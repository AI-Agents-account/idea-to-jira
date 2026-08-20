import { join } from "node:path";

import { createAuditEvent, hashAuditActorReference, SqliteAuditWriter } from "./audit/index.js";
import { isSafeErrorCode, SafeError } from "./errors/index.js";
import { createCorrelationContext, StructuredLogger } from "./observability/index.js";

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

const auditWriter = new SqliteAuditWriter();

function persistAudit(
  storage: PluginDatabase,
  logger: StructuredLogger,
  event: ReturnType<typeof createAuditEvent>,
): boolean {
  try {
    storage.repositories.criticalTransaction(({ sql }) => auditWriter.append(sql, event));
    logger.emit("INFO", {
      timestamp: event.occurredAt,
      component: "AUDIT",
      eventType: event.action,
      outcome: event.outcome,
      ...(event.links.correlationId ? { correlationId: event.links.correlationId } : {}),
      ...(event.links.operationId ? { operationId: event.links.operationId } : {}),
    });
    return true;
  } catch {
    logger.emit("ERROR", {
      timestamp: new Date().toISOString(),
      component: "AUDIT",
      eventType: "AUDIT_APPEND",
      outcome: "FAILED",
      ...(event.links.correlationId ? { correlationId: event.links.correlationId } : {}),
      errorCode: "AUDIT_APPEND_FAILED",
    });
    return false;
  }
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
    const logger = new StructuredLogger(api.logger);
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
          logger.emit("INFO", {
            timestamp: new Date().toISOString(),
            component: "STORAGE",
            eventType: "STORAGE_READY",
            outcome: "SUCCEEDED",
          });
        } catch {
          storage = undefined;
          storageFailureCode = "STORAGE_STARTUP_FAILED";
          logger.emit("ERROR", {
            timestamp: new Date().toISOString(),
            component: "STORAGE",
            eventType: "STORAGE_STARTUP",
            outcome: "FAILED",
            errorCode: "STORAGE_STARTUP_FAILED",
          });
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
          return {
            outcome: "block",
            reason: storageFailureCode,
            message: "This request is unavailable.",
            category: "access_policy",
          };
        }

        const trace = createCorrelationContext();
        const requester = requesterFromAgentRun(event, context, config);
        if (!requester.ok) {
          const recorded = persistAudit(storage, logger, createAuditEvent({
            actor: { kind: "SYSTEM" },
            action: "SECURITY_DECISION",
            target: { type: "SECURITY_BOUNDARY" },
            outcome: "REJECTED",
            code: requester.code,
            links: trace,
            retentionClass: "AUDIT_1Y",
          }));
          return {
            outcome: "block",
            reason: recorded ? requester.code : "AUDIT_REQUIRED",
            message: "This request is unavailable.",
            category: "access_policy",
          };
        }

        const actor = {
          kind: "USER" as const,
          refHash: hashAuditActorReference(requester.context.accountId, requester.context.senderId),
        };
        const allowed = limiter.consume(requester.context, "model_run").allowed;
        const code = allowed ? "POLICY_OK" : "RATE_LIMITED";
        const recorded = persistAudit(storage, logger, createAuditEvent({
          actor,
          action: "SECURITY_DECISION",
          target: { type: "SECURITY_BOUNDARY" },
          outcome: allowed ? "ALLOWED" : "REJECTED",
          code,
          links: trace,
          retentionClass: "AUDIT_1Y",
        }));
        if (!recorded || !allowed) {
          return {
            outcome: "block",
            reason: recorded ? code : "AUDIT_REQUIRED",
            message: allowed ? "This request is unavailable." : "This request is temporarily unavailable.",
            category: allowed ? "access_policy" : "rate_limit",
          };
        }
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
            const trace = createCorrelationContext();
            const actor = {
              kind: "USER" as const,
              refHash: hashAuditActorReference(requester.context.accountId, requester.context.senderId),
            };
            try {
              if (!storage) throw new SafeError("STORAGE_NOT_READY", false);
              requireRateLimit(limiter, requester.context, "validate_draft");
              assertPayloadWithinLimit(input, config);
              assertCreateDisabled(config);
              if (!persistAudit(storage, logger, createAuditEvent({
                actor,
                action: "SECURITY_DECISION",
                target: { type: "SECURITY_BOUNDARY" },
                outcome: "ALLOWED",
                code: "POLICY_OK",
                links: trace,
                retentionClass: "AUDIT_1Y",
              }))) throw new SafeError("AUDIT_REQUIRED", false);

              const draft = validateDraftForRequester(requester.context, input as IdeaInput, drafts);
              if (!persistAudit(storage, logger, createAuditEvent({
                actor,
                action: "DRAFT_TRANSITION",
                target: { type: "DRAFT" },
                outcome: "SUCCEEDED",
                code: "DRAFT_VALID",
                links: trace,
                retentionClass: "AUDIT_1Y",
              }))) throw new SafeError("AUDIT_REQUIRED", false);
              return {
                content: [{ type: "text" as const, text: JSON.stringify(draft) }],
                details: draft,
              };
            } catch (error) {
              const code = error instanceof SafeError
                ? error.code
                : error instanceof Error && isSafeErrorCode(error.message)
                  ? error.message
                  : "DRAFT_INVALID";
              const activeStorage = storage;
              if (activeStorage && code !== "AUDIT_REQUIRED" && code !== "AUDIT_APPEND_FAILED") {
                persistAudit(activeStorage, logger, createAuditEvent({
                  actor,
                  action: "DRAFT_TRANSITION",
                  target: { type: "DRAFT" },
                  outcome: "FAILED",
                  code,
                  links: trace,
                  retentionClass: "AUDIT_1Y",
                }));
              }
              throw new SafeError(code, code === "RATE_LIMITED", { cause: error });
            }
          },
        };
      },
      { name: IDEA_TO_JIRA_TOOL },
    );
  },
};

export default plugin;
