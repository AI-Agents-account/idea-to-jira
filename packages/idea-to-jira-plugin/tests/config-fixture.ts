import { createHash } from "node:crypto";

import { loadEffectiveConfig, type EffectiveConfig } from "../src/config.js";

export const catalogText = "catalog fixture v1\n";
export const catalogSha256 = createHash("sha256").update(catalogText).digest("hex");

export function validRawConfig(): Record<string, unknown> {
  return {
    agentId: "idea-mvp",
    telegram: {
      channelId: "telegram",
      accountId: "idea-mvp",
      pilotSenderIdEnv: "TELEGRAM_PILOT_SENDER_ID",
      adminSenderIdsEnv: "BUSINESS_ADMIN_TELEGRAM_IDS",
    },
    notifications: {
      productOwnerSenderIdsEnv: "PRODUCT_OWNER_TELEGRAM_IDS",
    },
    jira: {
      originEnv: "JIRA_BASE_URL",
      tokenEnv: "JIRA_TOKEN",
      projectKey: "FPF",
      projectId: "18100",
      issueTypeName: "Feature",
      issueTypeId: "11500",
      writeMode: "disabled",
    },
    catalog: {
      path: "/catalog.md",
      schemaVersion: 1,
      sha256: catalogSha256,
    },
    sttModel: "medium",
    allowedTools: [
      "idea_to_jira_create_draft",
      "idea_to_jira_read_draft",
      "idea_to_jira_patch_draft",
      "idea_to_jira_cancel_draft",
      "idea_to_jira_request_access",
    ],
    limits: { inputTextChars: 20_000, requestsPerMinute: 20, burst: 5, activeDrafts: 3 },
    retention: { draftDays: 90, auditDays: 365 },
    stateDir: "/plugin-state/idea-to-jira",
  };
}

export const validEnvironment = {
  JIRA_BASE_URL: "https://jira.example.test",
  TELEGRAM_PILOT_SENDER_ID: "123456789",
  BUSINESS_ADMIN_TELEGRAM_IDS: "123456789,987654321",
  PRODUCT_OWNER_TELEGRAM_IDS: "111222333",
};

export function effectiveConfig(): EffectiveConfig {
  const result = loadEffectiveConfig(validRawConfig(), validEnvironment, () => catalogText);
  if (!result.ok) throw new Error(result.code);
  return result.config;
}
