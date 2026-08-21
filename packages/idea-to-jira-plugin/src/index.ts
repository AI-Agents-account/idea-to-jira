import { join } from "node:path";

import { AccessService } from "./access/access-service.js";
import { registerAccessCommands } from "./access/commands.js";
import { createAuditEvent, hashAuditActorReference, SqliteAuditWriter } from "./audit/index.js";
import { assertCreateDisabled, loadEffectiveConfig } from "./config.js";
import type { CancelDraftInput, CreateDraftInput, PatchDraftInput } from "./domain/draft.js";
import { isSafeErrorCode, SafeError } from "./errors/index.js";
import { DisabledJiraIssueClient } from "./jira/client.js";
import { createCorrelationContext, StructuredLogger } from "./observability/index.js";
import {
  assertPayloadWithinLimit,
  requireRateLimit,
  TokenBucketRateLimiter,
} from "./runtime/policy.js";
import { requesterFromAgentRun, requesterFromToolContext } from "./runtime/requester-context.js";
import {
  openPluginDatabase,
  UPGRADE_BACKUP_FILENAME,
  type PluginDatabase,
} from "./storage/database.js";
import {
  DraftVersionConflict,
  IdeaToJiraDraftService,
} from "./workflow/draft-service.js";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentRunEvent,
  PluginHookBeforeAgentRunResult,
} from "openclaw/plugin-sdk/types";
import { Type } from "typebox";

const text = (maximum: number) => Type.String({ minLength: 1, maxLength: maximum });
const list = (maximumItems: number, itemMaximum = 2_000) =>
  Type.Array(text(itemMaximum), { minItems: 1, maxItems: maximumItems, uniqueItems: true });
const patchSource = Type.Union([
  Type.Literal("USER_STATED"),
  Type.Literal("MODEL_PROPOSED"),
  Type.Literal("UNKNOWN"),
]);
const textPatch = Type.Object({
  value: Type.Union([text(10_000), Type.Null()]),
  source: patchSource,
  evidenceRef: Type.Optional(text(128)),
}, { additionalProperties: false });
const listPatch = (maximumItems: number, itemMaximum = 2_000) => Type.Object({
  value: Type.Union([list(maximumItems, itemMaximum), Type.Null()]),
  source: patchSource,
  evidenceRef: Type.Optional(text(128)),
}, { additionalProperties: false });
const draftField = Type.Union([
  Type.Literal("summary"),
  Type.Literal("context"),
  Type.Literal("goalProblemOpportunity"),
  Type.Literal("targetAudience"),
  Type.Literal("proposedSolution"),
  Type.Literal("acceptanceCriteria"),
  Type.Literal("successMetrics"),
  Type.Literal("risksConstraintsDependencies"),
  Type.Literal("additionalDetails"),
  Type.Literal("links"),
  Type.Literal("marketingRequired"),
  Type.Literal("categoryId"),
  Type.Literal("moscowId"),
  Type.Literal("impactedMetricIds"),
  Type.Literal("routeCandidates"),
  Type.Literal("selectedRouteId"),
]);

const createDraftParameters = Type.Object({
  summary: text(255),
  context: text(10_000),
  goalProblemOpportunity: text(10_000),
  targetAudience: Type.Optional(text(10_000)),
  proposedSolution: Type.Optional(text(10_000)),
  acceptanceCriteria: Type.Optional(list(20)),
  successMetrics: Type.Optional(list(20)),
  risksConstraintsDependencies: Type.Optional(list(20)),
  additionalDetails: Type.Optional(list(20)),
  links: Type.Optional(list(10, 2_048)),
  marketingRequired: Type.Optional(text(128)),
  categoryId: Type.Optional(text(128)),
  moscowId: Type.Optional(text(128)),
  impactedMetricIds: Type.Optional(list(20, 128)),
}, { additionalProperties: false });

const readDraftParameters = Type.Object({ draftId: text(128) }, { additionalProperties: false });
const patchDraftParameters = Type.Object({
  draftId: text(128),
  expectedVersion: Type.Integer({ minimum: 1 }),
  updates: Type.Optional(Type.Object({
    summary: Type.Optional(textPatch),
    context: Type.Optional(textPatch),
    goalProblemOpportunity: Type.Optional(textPatch),
    targetAudience: Type.Optional(textPatch),
    proposedSolution: Type.Optional(textPatch),
    acceptanceCriteria: Type.Optional(listPatch(20)),
    successMetrics: Type.Optional(listPatch(20)),
    risksConstraintsDependencies: Type.Optional(listPatch(20)),
    additionalDetails: Type.Optional(listPatch(20)),
    links: Type.Optional(listPatch(10, 2_048)),
    marketingRequired: Type.Optional(textPatch),
    categoryId: Type.Optional(textPatch),
    moscowId: Type.Optional(textPatch),
    impactedMetricIds: Type.Optional(listPatch(20, 128)),
    routeCandidates: Type.Optional(listPatch(3, 128)),
    selectedRouteId: Type.Optional(textPatch),
  }, { additionalProperties: false })),
  confirmFields: Type.Optional(Type.Array(draftField, { maxItems: 16, uniqueItems: true })),
}, { additionalProperties: false });
const cancelDraftParameters = Type.Object({
  draftId: text(128),
  expectedVersion: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
const requestAccessParameters = Type.Object({}, { additionalProperties: false });

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
    });
    return true;
  } catch {
    logger.emit("ERROR", {
      timestamp: new Date().toISOString(),
      component: "AUDIT",
      eventType: "AUDIT_APPEND",
      outcome: "FAILED",
      errorCode: "AUDIT_APPEND_FAILED",
    });
    return false;
  }
}

function registerStartupDisabledGate(api: OpenClawPluginApi, code: string): void {
  api.logger.error(`idea-to-jira startup disabled code=${code}`);
  api.on("before_agent_run", (): PluginHookBeforeAgentRunResult => ({
    outcome: "block",
    reason: code,
    message: "This request is unavailable.",
    category: "access_policy",
  }), { priority: 1_000 });
}

const plugin = {
  id: "idea-to-jira",
  name: "Idea-to-Jira MVP",
  description: "Fail-closed versioned Draft foundation; Jira create remains disabled.",
  register(api: OpenClawPluginApi) {
    const loaded = loadEffectiveConfig(api.pluginConfig);
    if (!loaded.ok) {
      registerStartupDisabledGate(api, loaded.code);
      return;
    }

    const config = loaded.config;
    assertCreateDisabled(config);
    const jira = new DisabledJiraIssueClient();
    const limiter = new TokenBucketRateLimiter(config.limits);
    const logger = new StructuredLogger(api.logger);
    let storage: PluginDatabase | undefined;
    let accessService: AccessService | undefined;
    let draftService: IdeaToJiraDraftService | undefined;
    let storageFailureCode = "STORAGE_NOT_READY";

    api.registerService({
      id: "idea-to-jira-storage",
      start() {
        try {
          storage = openPluginDatabase({
            stateDir: config.stateDir,
            upgradeBackupPath: join(config.stateDir, UPGRADE_BACKUP_FILENAME),
          });
          accessService = new AccessService({ unitOfWork: storage.repositories, config });
          draftService = new IdeaToJiraDraftService({
            unitOfWork: storage.repositories,
            maxActiveDrafts: config.limits.activeDrafts,
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
          accessService = undefined;
          draftService = undefined;
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
        accessService = undefined;
        draftService = undefined;
        storageFailureCode = "STORAGE_NOT_READY";
        activeStorage?.close();
      },
    });

    void jira;
    registerAccessCommands(api, config, () => accessService);

    api.on("before_agent_run", (
      event: PluginHookBeforeAgentRunEvent,
      context: PluginHookAgentContext,
    ): PluginHookBeforeAgentRunResult => {
      if (!storage) return {
        outcome: "block",
        reason: storageFailureCode,
        message: "This request is unavailable.",
        category: "access_policy",
      };
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
      try {
        accessService?.ensureUser(requester.context);
      } catch {
        return {
          outcome: "block",
          reason: "ACCESS_REQUEST_CONFLICT",
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
      if (!recorded || !allowed) return {
        outcome: "block",
        reason: recorded ? code : "AUDIT_REQUIRED",
        message: allowed ? "This request is unavailable." : "This request is temporarily unavailable.",
        category: allowed ? "access_policy" : "rate_limit",
      };
      return { outcome: "pass" };
    }, { priority: 100 });

    async function executeTool<T>(
      requester: ReturnType<typeof requesterFromToolContext> & { readonly ok: true },
      input: unknown,
      action: () => T,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: T }> {
      const activeStorage = storage;
      if (!activeStorage) throw new SafeError("STORAGE_NOT_READY", false);
      try {
        requireRateLimit(limiter, requester.context, "draft_tool");
        assertPayloadWithinLimit(input, config);
        assertCreateDisabled(config);
        const trace = createCorrelationContext();
        if (!persistAudit(activeStorage, logger, createAuditEvent({
          actor: {
            kind: "USER",
            refHash: hashAuditActorReference(requester.context.accountId, requester.context.senderId),
          },
          action: "SECURITY_DECISION",
          target: { type: "SECURITY_BOUNDARY" },
          outcome: "ALLOWED",
          code: "POLICY_OK",
          links: trace,
          retentionClass: "AUDIT_1Y",
        }))) throw new SafeError("AUDIT_REQUIRED", false);
        const result = action();
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      } catch (error) {
        if (error instanceof DraftVersionConflict || error instanceof SafeError) throw error;
        const code = error instanceof Error && isSafeErrorCode(error.message) ? error.message : "DRAFT_INVALID";
        throw new SafeError(code, code === "RATE_LIMITED", { cause: error });
      }
    }

    api.registerTool((toolContext) => {
      if (!storage || !draftService) return null;
      const requester = requesterFromToolContext(toolContext, config);
      if (!requester.ok) return null;
      return {
        name: "idea_to_jira_create_draft",
        label: "Create own Draft",
        description: "Create a versioned Draft owned by the current Telegram sender; never writes to Jira.",
        parameters: createDraftParameters,
        execute: async (_id: string, input: unknown) => executeTool(requester, input, () => {
          if (!draftService) throw new SafeError("STORAGE_NOT_READY", false);
          return draftService.createDraft(requester.context, input as CreateDraftInput);
        }),
      };
    }, { name: "idea_to_jira_create_draft" });

    api.registerTool((toolContext) => {
      if (!storage || !draftService) return null;
      const requester = requesterFromToolContext(toolContext, config);
      if (!requester.ok) return null;
      return {
        name: "idea_to_jira_read_draft",
        label: "Read own Draft",
        description: "Read the current immutable version of a Draft owned by the current Telegram sender.",
        parameters: readDraftParameters,
        execute: async (_id: string, input: unknown) => executeTool(requester, input, () => {
          if (!draftService) throw new SafeError("STORAGE_NOT_READY", false);
          return draftService.readDraft(requester.context, (input as { draftId: string }).draftId);
        }),
      };
    }, { name: "idea_to_jira_read_draft" });

    api.registerTool((toolContext) => {
      if (!storage || !draftService) return null;
      const requester = requesterFromToolContext(toolContext, config);
      if (!requester.ok) return null;
      return {
        name: "idea_to_jira_patch_draft",
        label: "Patch own Draft",
        description: "CAS patch domain fields of an owned Draft; arbitrary Jira fields are rejected.",
        parameters: patchDraftParameters,
        execute: async (_id: string, input: unknown) => executeTool(requester, input, () => {
          if (!draftService) throw new SafeError("STORAGE_NOT_READY", false);
          return draftService.patchDraft(requester.context, input as PatchDraftInput);
        }),
      };
    }, { name: "idea_to_jira_patch_draft" });

    api.registerTool((toolContext) => {
      if (!storage || !draftService) return null;
      const requester = requesterFromToolContext(toolContext, config);
      if (!requester.ok) return null;
      return {
        name: "idea_to_jira_cancel_draft",
        label: "Cancel own Draft",
        description: "Cancel an owned Draft with CAS while preserving its immutable versions and audit.",
        parameters: cancelDraftParameters,
        execute: async (_id: string, input: unknown) => executeTool(requester, input, () => {
          if (!draftService) throw new SafeError("STORAGE_NOT_READY", false);
          return draftService.cancelDraft(requester.context, input as CancelDraftInput);
        }),
      };
    }, { name: "idea_to_jira_cancel_draft" });

    api.registerTool((toolContext) => {
      if (!storage || !accessService) return null;
      const requester = requesterFromToolContext(toolContext, config);
      if (!requester.ok) return null;
      return {
        name: "idea_to_jira_request_access",
        label: "Request Creator access",
        description: "Create or read the current sender's bounded Creator access request.",
        parameters: requestAccessParameters,
        execute: async (_id: string, input: unknown) => executeTool(requester, input, () => {
          if (!accessService) throw new SafeError("STORAGE_NOT_READY", false);
          return accessService.requestAccess(requester.context);
        }),
      };
    }, { name: "idea_to_jira_request_access" });
  },
};

export default plugin;
