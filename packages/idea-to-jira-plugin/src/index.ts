import { join } from "node:path";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentRunEvent,
  PluginHookBeforeAgentRunResult,
} from "openclaw/plugin-sdk/types";
import { Type } from "typebox";

import { assertCreateDisabled, IDEA_TO_JIRA_TOOL, loadEffectiveConfig } from "./config.js";
import type { IdeaInput } from "./domain/idea.js";
import { DisabledJiraIssueClient } from "./jira/client.js";
import { requesterFromAgentRun, requesterFromToolContext } from "./runtime/requester-context.js";
import {
  openPluginDatabase,
  UPGRADE_BACKUP_FILENAME,
  type PluginDatabase,
} from "./storage/database.js";
import {
  assertPayloadWithinLimit,
  requireRateLimit,
  TokenBucketRateLimiter,
  type AuditSink,
  type SecurityAuditEvent,
} from "./runtime/policy.js";
import { IdeaToJiraDraftService } from "./workflow/draft-service.js";
import { validateDraftForRequester } from "./workflow/validate-draft-handler.js";

const parameters = Type.Object(
  {
    summary: Type.String({ minLength: 1, maxLength: 255 }),
    problem: Type.String({ minLength: 1, maxLength: 10_000 }),
    desiredOutcome: Type.String({ minLength: 1, maxLength: 10_000 }),
    evidence: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 50 })),
    labels: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 255 }), { maxItems: 50 })),
  },
  { additionalProperties: false },
);

function createAuditSink(api: OpenClawPluginApi): AuditSink {
  return {
    record(event: SecurityAuditEvent): void {
      // Fixed enum-like fields only: never sender IDs, content, destinations, origins, or credentials.
      api.logger.info(`idea-to-jira audit operation=${event.operation} outcome=${event.outcome} code=${event.code}`);
    },
  };
}

function registerStartupDisabledGate(api: OpenClawPluginApi, code: string): void {
  api.logger.error(`idea-to-jira startup disabled code=${code}`);
  api.on(
    "before_agent_run",
    (): PluginHookBeforeAgentRunResult => ({
      outcome: "block",
      reason: code,
      message: "This request is unavailable.",
      category: "access_policy",
    }),
    { priority: 1_000 },
  );
}

const plugin = {
  id: "idea-to-jira",
  name: "Idea-to-Jira MVP",
  description: "Fail-closed Idea-to-Jira plugin foundation; Jira create remains disabled.",
  register(api: OpenClawPluginApi) {
    const loaded = loadEffectiveConfig(api.pluginConfig);
    if (!loaded.ok) {
      registerStartupDisabledGate(api, loaded.code);
      return;
    }

    const config = loaded.config;
    assertCreateDisabled(config);
    const drafts = new IdeaToJiraDraftService({ jiraProjectKey: config.jira.projectKey });
    const jira = new DisabledJiraIssueClient();
    const limiter = new TokenBucketRateLimiter(config.limits);
    const audit = createAuditSink(api);
    let storage: PluginDatabase | undefined;
    let storageFailureCode = "STORAGE_NOT_READY";

    api.registerService({
      id: "idea-to-jira-storage",
      start() {
        try {
          storage = openPluginDatabase({
            stateDir: config.stateDir,
            upgradeBackupPath: join(config.stateDir, UPGRADE_BACKUP_FILENAME),
          });
          storageFailureCode = "STORAGE_NOT_READY";
          api.logger.info(`idea-to-jira storage ready schema=${storage.health.schemaVersion}`);
        } catch {
          storage = undefined;
          storageFailureCode = "STORAGE_STARTUP_FAILED";
          api.logger.error("idea-to-jira storage disabled code=STORAGE_STARTUP_FAILED");
        }
      },
      stop() {
        const activeStorage = storage;
        storage = undefined;
        storageFailureCode = "STORAGE_NOT_READY";
        activeStorage?.close();
      },
    });

    // Keep the disabled adapter in the effective service graph so no future handler can
    // accidentally obtain an unguarded Jira client from this foundation.
    void jira;

    api.on(
      "before_agent_run",
      (
        event: PluginHookBeforeAgentRunEvent,
        context: PluginHookAgentContext,
      ): PluginHookBeforeAgentRunResult => {
        if (!storage) {
          audit.record({ operation: "model_run", outcome: "rejected", code: storageFailureCode });
          return {
            outcome: "block",
            reason: storageFailureCode,
            message: "This request is unavailable.",
            category: "access_policy",
          };
        }

        const requester = requesterFromAgentRun(event, context, config);
        if (!requester.ok) {
          audit.record({ operation: "model_run", outcome: "rejected", code: requester.code });
          return {
            outcome: "block",
            reason: requester.code,
            message: "This request is unavailable.",
            category: "access_policy",
          };
        }

        if (!limiter.consume(requester.context, "model_run").allowed) {
          audit.record({ operation: "model_run", outcome: "rejected", code: "RATE_LIMITED" });
          return {
            outcome: "block",
            reason: "RATE_LIMITED",
            message: "This request is temporarily unavailable.",
            category: "rate_limit",
          };
        }
        audit.record({ operation: "model_run", outcome: "allowed", code: "POLICY_OK" });
        return { outcome: "pass" };
      },
      { priority: 100 },
    );

    api.registerTool(
      (toolContext) => {
        if (!storage) return null;
        const requester = requesterFromToolContext(toolContext, config);
        if (!requester.ok) return null;

        return {
          name: IDEA_TO_JIRA_TOOL,
          label: "Validate idea draft",
          description: "Validate and normalize a draft Feature without writing to Jira.",
          parameters,
          async execute(_toolCallId: string, input: unknown) {
            try {
              if (!storage) throw new Error(storageFailureCode);
              requireRateLimit(limiter, requester.context, "validate_draft");
              assertPayloadWithinLimit(input, config);
              assertCreateDisabled(config);
              audit.record({ operation: "validate_draft", outcome: "allowed", code: "POLICY_OK" });

              const draft = validateDraftForRequester(requester.context, input as IdeaInput, drafts);
              audit.record({ operation: "validate_draft", outcome: "succeeded", code: "DRAFT_VALID" });
              return {
                content: [{ type: "text" as const, text: JSON.stringify(draft) }],
                details: draft,
              };
            } catch (error) {
              const code = error instanceof Error && /^[A-Z_]+$/.test(error.message)
                ? error.message
                : "DRAFT_INVALID";
              audit.record({ operation: "validate_draft", outcome: "failed", code });
              throw error;
            }
          },
        };
      },
      { name: IDEA_TO_JIRA_TOOL },
    );
  },
};

export default plugin;
