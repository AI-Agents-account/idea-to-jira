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
  assert.equal(result.config.jira.projectKey, "PROJECT");
  assert.equal(result.config.jira.issueTypeName, "Feature");
  assert.equal(result.config.jira.url, "https://jira.example.test");
  assert.deepEqual(result.config.allowedTools, [
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
  ]);
  assert.equal(result.config.limits.activeDrafts, 3);
  assert.deepEqual(result.config.telegram.adminSenderIds, ["123456789", "987654321"]);
  assert.deepEqual(result.config.notifications.productOwnerSenderIds, ["111222333"]);
  assert.equal(Object.isFrozen(result.config), true);
  assert.doesNotThrow(() => assertCreateDisabled(result.config));
});

test("fails closed when a protected runtime value is missing", () => {
  const result = load(validRawConfig(), { ...validEnvironment, BUSINESS_ADMIN_TELEGRAM_IDS: "" });
  assert.deepEqual(result, { ok: false, code: "SECRET_REF_MISSING" });
});

test("does not require or retain a Jira credential and records presence only", () => {
  const result = load(validRawConfig(), { ...validEnvironment, JIRA_TOKEN: "present-but-never-retained" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.config.jira.credentialAvailable, true);
  assert.equal("token" in result.config.jira, false);
});

test("rejects unknown config keys and protected environment reference drift", () => {
  const unknownRoot = { ...validRawConfig(), unexpected: true };
  assert.deepEqual(load(unknownRoot), { ok: false, code: "CONFIG_INVALID" });

  const unknownNested = validRawConfig();
  (unknownNested.limits as Record<string, unknown>).unexpected = 1;
  assert.deepEqual(load(unknownNested), { ok: false, code: "CONFIG_INVALID" });

  const driftedAdminReference = validRawConfig();
  (driftedAdminReference.telegram as Record<string, unknown>).adminSenderIdsEnv = "UNRELATED_ACTOR";
  assert.deepEqual(load(driftedAdminReference), { ok: false, code: "CONFIG_INVALID" });
});

test("rejects non-HTTPS or path-bearing Jira origins", () => {
  for (const origin of ["http://jira.example.test", "https://jira.example.test/rest/api", "not-a-url"]) {
    const raw = validRawConfig();
    (raw.jira as Record<string, unknown>).url = origin;
    assert.deepEqual(load(raw), { ok: false, code: "JIRA_SCOPE_INVALID" });
  }
});

test("accepts deployment Jira scope and rejects an unsafe confirmation gate/tool allowlist", () => {
  const scope = validRawConfig();
  (scope.jira as Record<string, unknown>).projectKey = "OTHER";
  assert.equal(load(scope).ok, true);

  const write = validRawConfig();
  ((write.jira as Record<string, unknown>).create as Record<string, unknown>).requireConfirmation = false;
  assert.deepEqual(load(write), { ok: false, code: "CREATE_GATE_INVALID" });

  const tools = validRawConfig();
  tools.allowedTools = ["idea_to_jira_validate_draft", "exec"];
  assert.deepEqual(load(tools), { ok: false, code: "TOOL_ALLOWLIST_INVALID" });

  const numericFieldId = validRawConfig();
  (((numericFieldId.jira as Record<string, unknown>).search as Record<string, unknown>).fields as string[]).push("customfield_12345");
  assert.deepEqual(load(numericFieldId), { ok: false, code: "JIRA_SCOPE_INVALID" });
});

test("rejects invalid admin IDs and catalog checksum/content", () => {
  assert.deepEqual(
    load(validRawConfig(), { ...validEnvironment, BUSINESS_ADMIN_TELEGRAM_IDS: "@admin" }),
    { ok: false, code: "SECRET_REF_MISSING" },
  );
  assert.equal(
    load(validRawConfig(), { ...validEnvironment, BUSINESS_ADMIN_TELEGRAM_IDS: "987654321" }).ok,
    true,
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
