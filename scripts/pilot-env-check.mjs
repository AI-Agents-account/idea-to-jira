#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const processEnvironmentMode = process.argv.includes("--process-env");
const envPath = resolve(process.argv[2] ?? ".env");

function stop(code) {
  process.stderr.write(`pilot-env status=blocked code=${code}\n`);
  process.exit(1);
}

function valueOf(raw) {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

try {
  const values = new Map();

  if (processEnvironmentMode) {
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") values.set(key, value);
    }
  } else {
    const content = readFileSync(envPath, "utf8");
    for (const rawLine of content.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("export ")) stop("UNSUPPORTED_SYNTAX");

      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
      if (!match) stop("UNSUPPORTED_SYNTAX");

      const [, key, rawValue] = match;
      if (values.has(key)) stop("DUPLICATE_KEY");
      values.set(key, valueOf(rawValue));
    }
  }

  for (const forbidden of ["JIRA_TOKEN", "OPENAI_API_KEY"]) {
    if (values.has(forbidden)) stop("FORBIDDEN_CREDENTIAL_PRESENT");
  }

  const required = [
    "OPENCLAW_GATEWAY_TOKEN",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_PILOT_SENDER_ID",
    "OPENAI_MODEL",
    "JIRA_BASE_URL",
    "BUSINESS_ADMIN_TELEGRAM_IDS",
    "PRODUCT_OWNER_TELEGRAM_IDS",
  ];
  for (const key of required) {
    if (!values.get(key)) stop("REQUIRED_VALUE_MISSING");
  }

  const gatewayToken = values.get("OPENCLAW_GATEWAY_TOKEN");
  if (gatewayToken.length < 32 || /^\*+$/u.test(gatewayToken)) stop("GATEWAY_TOKEN_INVALID");

  const botToken = values.get("TELEGRAM_BOT_TOKEN");
  if (!/^[1-9][0-9]{4,19}:[A-Za-z0-9_-]{20,}$/u.test(botToken)) stop("TELEGRAM_TOKEN_INVALID");

  const sender = values.get("TELEGRAM_PILOT_SENDER_ID");
  if (!/^[1-9][0-9]{4,19}$/u.test(sender)) stop("PILOT_ACTOR_INVALID");

  const numericList = (value) => value.split(",").map((item) => item.trim()).filter(Boolean);
  const admins = numericList(values.get("BUSINESS_ADMIN_TELEGRAM_IDS"));
  const owners = numericList(values.get("PRODUCT_OWNER_TELEGRAM_IDS"));
  if (!admins.every((id) => /^[1-9][0-9]{4,19}$/u.test(id)) || !admins.includes(sender)) {
    stop("ADMIN_ALLOWLIST_INVALID");
  }
  if (owners.length === 0 || !owners.every((id) => /^[1-9][0-9]{4,19}$/u.test(id))) {
    stop("PRODUCT_OWNER_ALLOWLIST_INVALID");
  }

  const model = values.get("OPENAI_MODEL");
  if (!/^openai\/[A-Za-z0-9._:-]+$/u.test(model)) stop("MODEL_ROUTE_INVALID");

  if (values.get("JIRA_BASE_URL") !== "https://jira.invalid") stop("JIRA_ORIGIN_INVALID");

  process.stdout.write("pilot-env status=ready\n");
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    stop("ENV_FILE_MISSING");
  }
  stop("ENV_CHECK_FAILED");
}
