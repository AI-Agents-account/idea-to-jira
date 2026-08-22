import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(process.cwd(), "../..");

async function text(path: string): Promise<string> {
  return readFile(resolve(root, path), "utf8");
}

test("manifest and host config expose only typed Draft/access/Jira workflow tools", async () => {
  const expected = [
    "idea_to_jira_create_draft",
    "idea_to_jira_read_draft",
    "idea_to_jira_patch_draft",
    "idea_to_jira_cancel_draft",
    "idea_to_jira_search_duplicates",
    "idea_to_jira_answer_field",
    "idea_to_jira_preview_issue",
    "idea_to_jira_confirm_issue",
    "idea_to_jira_create_issue",
    "idea_to_jira_request_access",
  ];
  const manifest = JSON.parse(await text("packages/idea-to-jira-plugin/openclaw.plugin.json"));
  assert.deepEqual(manifest.contracts.tools, expected);
  assert.equal(manifest.configSchema.properties.jira.properties.create.properties.requireConfirmation.const, true);
  assert.equal(manifest.configSchema.properties.jira.properties.url.pattern, "^https://");
  assert.equal(manifest.configSchema.properties.limits.properties.activeDrafts.maximum, 100);

  const openclawConfig = await text("config/openclaw.json5");
  const pluginSource = await text("packages/idea-to-jira-plugin/src/index.ts");
  assert.match(pluginSource, /decision\.allowed && decision\.via === "ACTIVE_CREATOR"/);
  assert.match(pluginSource, /questionId: text\(128\)/);
  assert.doesNotMatch(pluginSource, /fieldId: text\(128\)/);
  assert.equal((openclawConfig.match(/dmPolicy: "open"/g) ?? []).length, 2);
  assert.equal((openclawConfig.match(/allowFrom: \["\*"\]/g) ?? []).length, 2);
  assert.equal((openclawConfig.match(/groupPolicy: "disabled"/g) ?? []).length, 2);
  assert.match(openclawConfig, /commands:\s*\{[\s\S]*?native: false,[\s\S]*?nativeSkills: false,[\s\S]*?text: false,/);
  assert.match(openclawConfig, /allowFrom:\s*\{\s*telegram: \["\$\{TELEGRAM_PILOT_SENDER_ID\}"\]/);
  assert.match(openclawConfig, /ownerAllowFrom: \["telegram:\$\{TELEGRAM_PILOT_SENDER_ID\}"\]/);
  for (const disabled of ["bash", "config", "mcp", "plugins", "debug", "restart"]) {
    assert.match(openclawConfig, new RegExp(`${disabled}: false`));
  }
  assert.match(openclawConfig, /audio: \{ enabled: false \}/);
  assert.match(openclawConfig, /defaultAccount: "default"/);
  assert.match(openclawConfig, /accounts:\s*\{\s*default:\s*\{/);
  assert.doesNotMatch(openclawConfig, /accounts:\s*\{\s*"idea-mvp":\s*\{/);
  assert.match(openclawConfig, /match:\s*\{\s*channel: "telegram",\s*accountId: "default"/);
  for (const tool of expected) {
    assert.equal(openclawConfig.split(`"${tool}"`).length - 1, 2);
  }
  for (const forbidden of ["exec", "browser", "web_fetch", "web_search", "message", "jira_create"]) {
    assert.doesNotMatch(openclawConfig, new RegExp(`tools:[\\s\\S]{0,700}\\b${forbidden}\\b`));
  }
});

test("Compose maps only guarded runtime values and keeps Gateway loopback-only", async () => {
  const compose = await text("compose.yaml");
  const dockerfile = await text("Dockerfile");
  const pilotUp = await text("scripts/pilot-up.sh");
  const pilotReadiness = await text("scripts/pilot-readiness.mjs");
  const containerEntrypoint = await text("scripts/pilot-container-entrypoint.sh");
  assert.doesNotMatch(compose, /\benv_file:/);
  assert.match(compose, /127\.0\.0\.1:\$\{OPENCLAW_GATEWAY_PORT:-18789\}:18789/);
  assert.match(compose, /OPENCLAW_GATEWAY_PORT: "18789"/);
  assert.match(compose, /JIRA_BASE_URL: \$\{JIRA_BASE_URL:\?/);
  assert.doesNotMatch(compose, /JIRA_TOKEN:/);
  assert.match(compose, /JIRA_TOKEN_FILE: \/run\/secrets\/jira-token/);
  assert.match(compose, /\.\/data\/secrets:\/run\/secrets:ro/);
  assert.match(compose, /TELEGRAM_PILOT_SENDER_ID: \$\{TELEGRAM_PILOT_SENDER_ID:\?/);
  assert.match(compose, /OPENAI_MODEL: \$\{OPENAI_MODEL:\?/);
  assert.match(compose, /BUSINESS_ADMIN_TELEGRAM_IDS: \$\{BUSINESS_ADMIN_TELEGRAM_IDS:\?/);
  assert.match(compose, /PRODUCT_OWNER_TELEGRAM_IDS: \$\{PRODUCT_OWNER_TELEGRAM_IDS:\?/);
  assert.doesNotMatch(compose, /JIRA_PROJECT_KEY|JIRA_ISSUE_TYPE_ID|KNOWLEDGE_CATALOG_PATH/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:\s*\n\s*- ALL/);
  assert.match(compose, /OPENCLAW_CONFIG_PATH: \/home\/node\/config\/openclaw\.json5/);
  assert.match(compose, /IDEA_TO_JIRA_PLUGIN_PATH: \/opt\/openclaw-plugins\/idea-to-jira/);
  assert.doesNotMatch(compose, /IDEA_TO_JIRA_PLUGIN_PATH: \/app\/extensions\//);
  assert.match(dockerfile, /WORKDIR \/opt\/openclaw-plugins\/idea-to-jira/);
  assert.match(compose, /\.\/data\/config:\/home\/node\/config/);
  assert.doesNotMatch(compose, /config\/openclaw\.json5:\/home\/node\/\.openclaw/);
  assert.doesNotMatch(dockerfile, /COPY .*config\/openclaw\.json5/);
  assert.match(compose, /\.\/data\/plugin-state:\/home\/node\/plugin-state/);
  assert.match(compose, /\.\/data\/workspace:\/home\/node\/workspace/);
  assert.match(compose, /\.\/knowledge:\/app\/knowledge:ro/);
  assert.doesNotMatch(compose, /:\/home\/node\/\.openclaw\/(?:workspace|plugin-state)/);
  assert.match(pilotUp, /for forbidden_key in JIRA_TOKEN OPENAI_API_KEY/);
  assert.match(pilotUp, /compose up -d --wait --wait-timeout 180 --force-recreate/);
  assert.match(pilotUp, /models auth login --provider openai --device-code/);
  assert.match(pilotUp, /openclaw plugins list --json/);
  assert.match(pilotUp, /plugin\?\.id === "idea-to-jira" && plugin\?\.status === "loaded"/);
  assert.match(pilotUp, /compose run --rm --no-deps --entrypoint node openclaw-cli/);
  assert.match(pilotUp, /cp config\/openclaw\.json5 "\$runtime_config_tmp"/);
  assert.match(pilotUp, /chmod 600 "\$runtime_config_tmp"/);
  assert.match(pilotUp, /mv "\$runtime_config_tmp" data\/config\/openclaw\.json5/);
  assert.doesNotMatch(pilotUp, /if \[ ! -f data\/config\/openclaw\.json5 \]/);
  assert.doesNotMatch(pilotUp, /required command not found: (?:node|npm)/);
  assert.match(pilotUp, /pilot-readiness\.mjs/);
  assert.match(pilotUp, /create-readiness\.mjs --verify-contract/);
  assert.match(dockerfile, /node scripts\/plugin-build-fingerprint\.mjs > \/src\/PLUGIN_BUILD_FINGERPRINT/);
  assert.match(dockerfile, /COPY --from=plugin-build \/src\/PLUGIN_BUILD_FINGERPRINT \.\/BUILD_FINGERPRINT/);
  assert.match(dockerfile, /ENTRYPOINT \["\/app\/scripts\/pilot-container-entrypoint\.sh"\]/);
  assert.match(dockerfile, /FROM node:24\.19\.0-bookworm-slim AS plugin-build/);
  assert.match(pilotUp, /FINGERPRINT_NODE_IMAGE="node:24\.19\.0-bookworm-slim"/);
  assert.match(pilotUp, /source_plugin_fingerprint\(\) \{/);
  assert.match(pilotUp, /docker run --rm[\s\S]{0,300}--network none[\s\S]{0,300}--read-only[\s\S]{0,300}--cap-drop ALL/);
  assert.match(pilotUp, /expected_plugin_fingerprint=\$\(source_plugin_fingerprint\)/);
  assert.match(pilotUp, /built_plugin_fingerprint=\$\(compose run --rm --no-deps --entrypoint cat openclaw-cli/);
  assert.match(pilotUp, /built plugin image does not match the reviewed source/);
  assert.match(pilotUp, /\/opt\/openclaw-plugins\/idea-to-jira\/BUILD_FINGERPRINT/);
  assert.match(pilotUp, /running_plugin_fingerprint=\$\(compose exec -T "\$GATEWAY_SERVICE"/);
  assert.match(pilotUp, /running plugin build does not match the reviewed source/);
  assert.match(pilotUp, /current_plugin_fingerprint=\$\(source_plugin_fingerprint\)/);
  assert.match(pilotUp, /plugin source changed during image startup verification/);
  assert.match(pilotReadiness, /runtimeStatus\.buildFingerprint/);
  assert.match(containerEntrypoint, /for forbidden_key in JIRA_TOKEN OPENAI_API_KEY/);
  assert.match(containerEntrypoint, /IDEA_TO_JIRA_BUILD_FINGERPRINT=\$\(cat "\$fingerprint_file"\)/);
  assert.match(containerEntrypoint, /export IDEA_TO_JIRA_BUILD_FINGERPRINT/);
  assert.match(containerEntrypoint, /exec openclaw "\$@"/);
});

test("pilot env validation is fail-closed and never prints secret values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idea-to-jira-pilot-env-"));
  const envPath = join(directory, ".env");
  const gatewaySecret = "g".repeat(48);
  const telegramSecret = `123456789:${"t".repeat(24)}`;
  const base = [
    `OPENCLAW_GATEWAY_TOKEN=${gatewaySecret}`,
    `TELEGRAM_BOT_TOKEN=${telegramSecret}`,
    "TELEGRAM_PILOT_SENDER_ID=123456789",
    "OPENAI_MODEL=openai/gpt-5.6-terra",
    "JIRA_BASE_URL=https://jira.invalid",
    "BUSINESS_ADMIN_TELEGRAM_IDS=123456789",
    "PRODUCT_OWNER_TELEGRAM_IDS=987654321",
  ];

  try {
    await writeFile(envPath, `${base.join("\n")}\n`, "utf8");
    const accepted = spawnSync(process.execPath, [resolve(root, "scripts/pilot-env-check.mjs"), envPath], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(accepted.status, 0);
    assert.match(accepted.stdout, /pilot-env status=ready/);
    assert.doesNotMatch(`${accepted.stdout}${accepted.stderr}`, new RegExp(`${gatewaySecret}|${telegramSecret}`));

    const acceptedFromEnvironment = spawnSync(
      process.execPath,
      [resolve(root, "scripts/pilot-env-check.mjs"), "--process-env"],
      {
        cwd: root,
        encoding: "utf8",
        env: Object.fromEntries(base.map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        })),
      },
    );
    assert.equal(acceptedFromEnvironment.status, 0);
    assert.match(acceptedFromEnvironment.stdout, /pilot-env status=ready/);
    assert.doesNotMatch(
      `${acceptedFromEnvironment.stdout}${acceptedFromEnvironment.stderr}`,
      new RegExp(`${gatewaySecret}|${telegramSecret}`),
    );

    const jiraSecret = "jira-secret-fixture";
    await writeFile(envPath, `${base.join("\n")}\nJIRA_TOKEN=${jiraSecret}\n`, "utf8");
    const rejected = spawnSync(process.execPath, [resolve(root, "scripts/pilot-env-check.mjs"), envPath], {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /code=FORBIDDEN_CREDENTIAL_PRESENT/);
    assert.doesNotMatch(`${rejected.stdout}${rejected.stderr}`, new RegExp(jiraSecret));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
  assert.match(storageCheck, /schema=5 journal=wal modes=private restart=ok/);
});

test("health and create-readiness are separate signals", async () => {
  const compose = await text("compose.yaml");
  const dockerfile = await text("Dockerfile");
  const workflow = await text(".github/workflows/ci.yaml");
  const pilotReadiness = await text("scripts/pilot-readiness.mjs");
  const pluginEntry = await text("packages/idea-to-jira-plugin/src/index.ts");
  const packageJson = JSON.parse(await text("package.json"));
  assert.match(compose, /healthcheck\.mjs/);
  assert.equal(packageJson.scripts["readiness:create"], "node scripts/create-readiness.mjs");
  assert.equal(packageJson.scripts["verify:create-contract"], "node scripts/create-readiness.mjs --verify-contract");
  assert.equal(packageJson.scripts["readiness:pilot"], "node scripts/pilot-readiness.mjs");
  assert.equal(packageJson.scripts["verify:pilot-structure"], "node scripts/pilot-readiness.mjs --structural");
  assert.match(dockerfile, /scripts\/pilot-readiness\.mjs/);
  assert.match(dockerfile, /scripts\/pilot-env-check\.mjs/);
  assert.match(workflow, /Verify Stage-05A pilot structure without external calls/);
  assert.doesNotMatch(workflow, /JIRA_TOKEN:/);
  assert.match(pluginEntry, /registerGatewayMethod\("idea-to-jira\.runtime-status"/);
  assert.match(pilotReadiness, /gateway", "call", "idea-to-jira\.runtime-status"/);
  assert.match(pilotReadiness, /host\.gateway\?\.mode !== "local"/);
  assert.match(pilotReadiness, /OPENCLAW_GATEWAY_PORT: String\(gatewayPort\)/);
  assert.match(pilotReadiness, /delete gatewayEnv\.OPENCLAW_GATEWAY_URL/);
  assert.match(pilotReadiness, /maxBuffer: 64 \* 1024, env: gatewayEnv/);
  assert.doesNotMatch(pilotReadiness, /"--(?:url|token|password)"/);
  assert.match(pilotReadiness, /runtimeStatus\.phase !== "READY"/);
  assert.doesNotMatch(pilotReadiness, /openPluginDatabase/);
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
