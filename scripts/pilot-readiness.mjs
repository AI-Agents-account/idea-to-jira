#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "openclaw/plugin-sdk/config-runtime";

const structuralOnly = process.argv.includes("--structural");
const expectedTools = [
  "idea_to_jira_create_draft",
  "idea_to_jira_read_draft",
  "idea_to_jira_patch_draft",
  "idea_to_jira_cancel_draft",
  "idea_to_jira_request_access",
];

function stop(code) {
  process.stderr.write(`pilot-readiness status=blocked code=${code}\n`);
  process.exit(1);
}

function exactList(value, expected) {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

try {
  const pluginRoot = process.env.IDEA_TO_JIRA_PLUGIN_PATH
    ? resolve(process.env.IDEA_TO_JIRA_PLUGIN_PATH)
    : resolve(process.cwd(), "packages/idea-to-jira-plugin");
  const moduleUrl = (path) => pathToFileURL(resolve(pluginRoot, path)).href;
  const [{ assertCreateDisabled, loadEffectiveConfig }, { DisabledJiraIssueClient }] =
    await Promise.all([
      import(moduleUrl("dist/src/config.js")),
      import(moduleUrl("dist/src/jira/client.js")),
    ]);

  const host = loadConfig();
  const pilotSenderId = process.env.TELEGRAM_PILOT_SENDER_ID?.trim();
  if (!pilotSenderId || !/^[1-9][0-9]{4,19}$/.test(pilotSenderId)) stop("PILOT_ACTOR_INVALID");

  const telegram = host.channels?.telegram;
  const accountIds = Object.keys(telegram?.accounts ?? {});
  const account = telegram?.accounts?.default;
  if (
    telegram?.defaultAccount !== "default" ||
    !exactList(accountIds, ["default"]) ||
    telegram.dmPolicy !== "allowlist" ||
    !exactList(telegram.allowFrom, [pilotSenderId]) ||
    account?.enabled !== true ||
    account.dmPolicy !== "allowlist" ||
    !exactList(account.allowFrom, [pilotSenderId]) ||
    account.groupPolicy !== "disabled"
  ) stop("TELEGRAM_BOUNDARY_INVALID");

  const agent = host.agents?.list?.find((candidate) => candidate.id === "idea-mvp");
  if (
    !agent ||
    !exactList(agent.tools?.allow, expectedTools) ||
    host.tools?.media?.audio?.enabled !== false
  ) stop("TEXT_ONLY_TOOL_POLICY_INVALID");

  const model = typeof agent.model === "string" ? agent.model : agent.model?.primary ?? host.agents?.defaults?.model?.primary;
  if (typeof model !== "string" || model !== process.env.OPENAI_MODEL || !model.startsWith("openai/")) {
    stop("MODEL_ROUTE_INVALID");
  }

  if (host.session?.dmScope !== "per-account-channel-peer") stop("SESSION_SCOPE_INVALID");
  const binding = host.bindings?.filter((candidate) => candidate.agentId === "idea-mvp") ?? [];
  if (
    binding.length !== 1 ||
    binding[0]?.match?.channel !== "telegram" ||
    binding[0]?.match?.accountId !== "default"
  ) stop("AGENT_BINDING_INVALID");

  const rawPlugin = host.plugins?.entries?.["idea-to-jira"]?.config;
  const loaded = loadEffectiveConfig(rawPlugin, process.env, (path) => {
    if (!structuralOnly) return readFileSync(path, "utf8");
    return readFileSync(resolve(process.cwd(), "knowledge/catalog.md"), "utf8");
  });
  if (!loaded.ok) stop(loaded.code);
  if (loaded.config.telegram.pilotSenderId !== pilotSenderId) stop("PILOT_ACTOR_DRIFT");
  assertCreateDisabled(loaded.config);

  let jiraDisabled = false;
  try {
    await new DisabledJiraIssueClient().createIssue(undefined);
  } catch (error) {
    jiraDisabled = error instanceof Error && error.message === "Jira writes are disabled in the scaffold";
  }
  if (!jiraDisabled) stop("JIRA_WRITE_GATE_INVALID");

  if (structuralOnly) {
    process.stdout.write("pilot-readiness status=ready mode=structural jira_post=disabled audio=disabled\n");
    process.exit(0);
  }

  const modelRoute = process.env.OPENAI_MODEL?.trim();
  if (!modelRoute || modelRoute.includes("<") || modelRoute.includes("fixture")) {
    stop("MODEL_ROUTE_NOT_LIVE");
  }
  if (Object.hasOwn(process.env, "JIRA_TOKEN")) stop("JIRA_CREDENTIAL_PRESENT");

  const gatewayPort = host.gateway?.port;
  if (
    host.gateway?.mode !== "local" ||
    !Number.isSafeInteger(gatewayPort) ||
    gatewayPort < 1 ||
    gatewayPort > 65535
  ) stop("GATEWAY_BOUNDARY_INVALID");

  const gatewayEnv = {
    ...process.env,
    OPENCLAW_GATEWAY_PORT: String(gatewayPort),
  };
  delete gatewayEnv.OPENCLAW_GATEWAY_URL;
  const gatewayCall = spawnSync(
    "openclaw",
    ["gateway", "call", "idea-to-jira.runtime-status", "--json", "--timeout", "5000"],
    { encoding: "utf8", maxBuffer: 64 * 1024, env: gatewayEnv },
  );
  if (gatewayCall.status !== 0 || gatewayCall.signal || typeof gatewayCall.stdout !== "string") {
    stop("PLUGIN_RUNTIME_UNREACHABLE");
  }
  let runtimeStatus;
  try {
    runtimeStatus = JSON.parse(gatewayCall.stdout);
  } catch {
    stop("PLUGIN_RUNTIME_RESPONSE_INVALID");
  }
  if (
    runtimeStatus?.schemaVersion !== 1 ||
    !Number.isSafeInteger(runtimeStatus.generation) ||
    runtimeStatus.generation < 1 ||
    !Number.isSafeInteger(runtimeStatus.latestGeneration) ||
    runtimeStatus.latestGeneration < runtimeStatus.generation ||
    typeof runtimeStatus.instanceId !== "string" ||
    !/^[0-9a-f-]{36}$/.test(runtimeStatus.instanceId) ||
    runtimeStatus.phase !== "READY" ||
    runtimeStatus.code !== null ||
    runtimeStatus.storageHealthy !== true ||
    !Number.isSafeInteger(runtimeStatus.storageSchemaVersion) ||
    runtimeStatus.storageSchemaVersion < 1 ||
    typeof runtimeStatus.buildFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(runtimeStatus.buildFingerprint)
  ) stop("PLUGIN_RUNTIME_NOT_READY");

  process.stdout.write(
    `pilot-readiness status=ready mode=live-local schema=${runtimeStatus.storageSchemaVersion} runtime=ready build=${runtimeStatus.buildFingerprint} jira_post=disabled audio=disabled\n`,
  );
} catch {
  stop("PILOT_READINESS_FAILED");
}
