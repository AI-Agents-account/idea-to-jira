import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(process.cwd(), "../..");

async function text(path: string): Promise<string> {
  return readFile(resolve(root, path), "utf8");
}

test("manifest and host config expose exactly the single stage-01 tool", async () => {
  const manifest = JSON.parse(await text("packages/idea-to-jira-plugin/openclaw.plugin.json"));
  assert.deepEqual(manifest.contracts.tools, ["idea_to_jira_validate_draft"]);
  assert.equal(manifest.configSchema.properties.jira.properties.writeMode.const, "disabled");

  const openclawConfig = await text("config/openclaw.json5");
  const allowlists = [...openclawConfig.matchAll(/allowedTools:\s*\[([^\]]*)\]|allow:\s*\[([^\]]*)\]/g)]
    .map((match) => match[1] ?? match[2] ?? "")
    .filter((value) => value.includes("idea_to_jira_validate_draft"));
  assert.equal(allowlists.length, 2);
  for (const allowlist of allowlists) {
    assert.match(allowlist, /^\s*"idea_to_jira_validate_draft"\s*,?\s*$/);
  }
  for (const forbidden of ["exec", "browser", "web_fetch", "web_search", "message", "jira_create"]) {
    assert.doesNotMatch(openclawConfig, new RegExp(`tools:[\\s\\S]{0,120}\\b${forbidden}\\b`));
  }
});

test("Compose maps only protected runtime values and keeps Gateway loopback-only", async () => {
  const compose = await text("compose.yaml");
  assert.match(compose, /127\.0\.0\.1:\$\{OPENCLAW_GATEWAY_PORT:-18789\}:18789/);
  assert.match(compose, /JIRA_BASE_URL: \$\{JIRA_BASE_URL:\?/);
  assert.match(compose, /JIRA_TOKEN: \$\{JIRA_TOKEN:\?/);
  assert.match(compose, /BUSINESS_ADMIN_TELEGRAM_IDS: \$\{BUSINESS_ADMIN_TELEGRAM_IDS:\?/);
  assert.match(compose, /PRODUCT_OWNER_TELEGRAM_IDS: \$\{PRODUCT_OWNER_TELEGRAM_IDS:\?/);
  assert.doesNotMatch(compose, /JIRA_PROJECT_KEY|JIRA_ISSUE_TYPE_ID|KNOWLEDGE_CATALOG_PATH/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:\s*\n\s*- ALL/);
  assert.match(compose, /\.\/data\/plugin-state:\/home\/node\/\.openclaw\/plugin-state/);
});

test("target-container storage verification is wired into the image and CI", async () => {
  const dockerfile = await text("Dockerfile");
  const workflow = await text(".github/workflows/ci.yaml");
  const storageCheck = await text("scripts/storage-container-check.mjs");
  assert.match(dockerfile, /^ARG OPENCLAW_VERSION=2026\.7\.1-2\s+FROM node:/);
  assert.match(dockerfile, /scripts\/storage-container-check\.mjs/);
  assert.match(workflow, /Verify SQLite durability and mount permissions in target container/);
  assert.match(workflow, /docker run --rm --read-only/);
  assert.match(workflow, /storage-container-check\.mjs/);
  assert.doesNotMatch(workflow, /compose[^\n]*run[^\n]*--no-deps/);
  assert.match(storageCheck, /openPluginDatabase/);
  assert.match(storageCheck, /schema=3 journal=wal modes=private restart=ok/);
});

test("health and create-readiness are separate signals", async () => {
  const compose = await text("compose.yaml");
  const packageJson = JSON.parse(await text("package.json"));
  assert.match(compose, /healthcheck\.mjs/);
  assert.equal(packageJson.scripts["readiness:create"], "node scripts/create-readiness.mjs");
  assert.equal(packageJson.scripts["verify:create-disabled"], "node scripts/create-readiness.mjs --expect-disabled");
});

test("healthcheck never prints configured URL credentials or raw exceptions", () => {
  const secret = ["health", "credential", "fixture"].join("-");
  const result = spawnSync(process.execPath, [resolve(root, "scripts/healthcheck.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      OPENCLAW_HEALTH_URL: `https://user:${secret}@example.test/healthz`,
    },
    encoding: "utf8",
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(output, new RegExp(secret));
  assert.match(output, /"code":"HEALTHCHECK_CONFIG_INVALID"/);
});
