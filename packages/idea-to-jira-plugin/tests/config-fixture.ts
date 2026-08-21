import { createHash } from "node:crypto";

import { loadEffectiveConfig, type EffectiveConfig } from "../src/config.js";

export const catalogText = "catalog fixture v1\n";
export const catalogSha256 = createHash("sha256").update(catalogText).digest("hex");

export function validRawConfig(): Record<string, unknown> {
  return {
    agentId: "idea-mvp",
    telegram: {
      channelId: "telegram",
      accountId: "default",
      adminSenderIdsEnv: "BUSINESS_ADMIN_TELEGRAM_IDS",
    },
    notifications: {
      productOwnerSenderIdsEnv: "PRODUCT_OWNER_TELEGRAM_IDS",
    },
    jira: {
      enabled: true,
      url: "https://jira.example.test",
      projectKey: "PROJECT",
      issueTypeName: "Feature",
      search: {
        jql: 'project = "PROJECT" AND issuetype = "Feature" ORDER BY updated DESC',
        fields: ["key", "summary", "description", "status", "labels", "components", "updated"],
        maxResults: 50,
        maxPages: 2,
        timeoutMs: 10_000,
        maxContextBytes: 65_536,
      },
      metadata: { refreshIntervalMinutes: 60 },
      create: { requireConfirmation: true },
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
      "idea_to_jira_search_duplicates",
      "idea_to_jira_answer_field",
      "idea_to_jira_preview_issue",
      "idea_to_jira_confirm_issue",
      "idea_to_jira_create_issue",
      "idea_to_jira_request_access",
    ],
    limits: { inputTextChars: 20_000, requestsPerMinute: 20, burst: 5, activeDrafts: 3 },
    retention: { draftDays: 90, auditDays: 365 },
    stateDir: "/plugin-state/idea-to-jira",
  };
}

export const validEnvironment = {
  // Used by deployment/readiness fixtures, not by plugin requester authorization.
  TELEGRAM_PILOT_SENDER_ID: "123456789",
  BUSINESS_ADMIN_TELEGRAM_IDS: "123456789,987654321",
  PRODUCT_OWNER_TELEGRAM_IDS: "111222333",
};

export function effectiveConfig(): EffectiveConfig {
  const result = loadEffectiveConfig(validRawConfig(), validEnvironment, () => catalogText);
  if (!result.ok) throw new Error(result.code);
  return result.config;
}
