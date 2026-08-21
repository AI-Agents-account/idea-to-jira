import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCreateDisabled,
  loadEffectiveConfig,
  type RuntimeEnvironment,
} from "../src/config.js";
import { catalogText, validEnvironment, validRawConfig } from "./config-fixture.js";

function load(
  raw: unknown = validRawConfig(),
  environment: RuntimeEnvironment = validEnvironment,
  catalog = catalogText,
) {
  return loadEffectiveConfig(raw, environment, () => catalog);
}

test("builds one immutable effective configuration from config and protected environment", () => {
  const result = load();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.config.jira.projectId, "18100");
  assert.equal(result.config.jira.issueTypeId, "11500");
  assert.deepEqual(result.config.allowedTools, [
    "idea_to_jira_create_draft",
    "idea_to_jira_read_draft",
    "idea_to_jira_patch_draft",
    "idea_to_jira_cancel_draft",
    "idea_to_jira_request_access",
  ]);
  assert.equal(result.config.limits.activeDrafts, 3);
  assert.deepEqual(result.config.telegram.adminSenderIds, ["123456789", "987654321"]);
  assert.deepEqual(result.config.notifications.productOwnerSenderIds, ["111222333"]);
  assert.equal(Object.isFrozen(result.config), true);
  assert.doesNotThrow(() => assertCreateDisabled(result.config));
});

test("fails closed when a protected runtime value is missing", () => {
  const result = load(validRawConfig(), { ...validEnvironment, JIRA_TOKEN: "" });
  assert.deepEqual(result, { ok: false, code: "SECRET_REF_MISSING" });
});

test("rejects unknown config keys and protected environment reference drift", () => {
  const unknownRoot = { ...validRawConfig(), unexpected: true };
  assert.deepEqual(load(unknownRoot), { ok: false, code: "CONFIG_INVALID" });

  const unknownNested = validRawConfig();
  (unknownNested.limits as Record<string, unknown>).unexpected = 1;
  assert.deepEqual(load(unknownNested), { ok: false, code: "CONFIG_INVALID" });

  const driftedReference = validRawConfig();
  (driftedReference.jira as Record<string, unknown>).tokenEnv = "UNRELATED_SECRET";
  assert.deepEqual(
    load(driftedReference, { ...validEnvironment, UNRELATED_SECRET: "present" }),
    { ok: false, code: "CONFIG_INVALID" },
  );
});

test("rejects non-HTTPS or path-bearing Jira origins", () => {
  for (const origin of ["http://jira.example.test", "https://jira.example.test/rest/api", "not-a-url"]) {
    const result = load(validRawConfig(), { ...validEnvironment, JIRA_BASE_URL: origin });
    assert.deepEqual(result, { ok: false, code: "SECRET_REF_MISSING" });
  }
});

test("rejects Jira scope, write mode, and tool allowlist drift", () => {
  const scope = validRawConfig();
  (scope.jira as Record<string, unknown>).projectKey = "OTHER";
  assert.deepEqual(load(scope), { ok: false, code: "JIRA_SCOPE_INVALID" });

  const write = validRawConfig();
  (write.jira as Record<string, unknown>).writeMode = "enabled";
  assert.deepEqual(load(write), { ok: false, code: "CREATE_GATE_INVALID" });

  const tools = validRawConfig();
  tools.allowedTools = ["idea_to_jira_validate_draft", "exec"];
  assert.deepEqual(load(tools), { ok: false, code: "TOOL_ALLOWLIST_INVALID" });
});

test("rejects invalid admin IDs and catalog checksum/content", () => {
  assert.deepEqual(
    load(validRawConfig(), { ...validEnvironment, BUSINESS_ADMIN_TELEGRAM_IDS: "@admin" }),
    { ok: false, code: "SECRET_REF_MISSING" },
  );
  assert.deepEqual(
    load(validRawConfig(), { ...validEnvironment, PRODUCT_OWNER_TELEGRAM_IDS: "" }),
    { ok: false, code: "SECRET_REF_MISSING" },
  );
  assert.deepEqual(load(validRawConfig(), validEnvironment, "tampered catalog"), {
    ok: false,
    code: "CATALOG_INVALID",
  });
});
