import { registerAccessCommands } from "./access/commands.js";
import { createAuditEvent, hashAuditActorReference, type SqliteAuditWriter } from "./audit/index.js";
import { assertCreateDisabled, loadEffectiveConfig } from "./config.js";
import type { CancelDraftInput, CreateDraftInput, PatchDraftInput } from "./domain/draft.js";
import { isSafeErrorCode, SafeError } from "./errors/index.js";
import { createCorrelationContext, StructuredLogger } from "./observability/index.js";
import {
  assertPayloadWithinLimit,
  requireRateLimit,
} from "./runtime/policy.js";
import { CONVERSATION_ROLE_REPLIES } from "./runtime/conversation-role-gate.js";
import {
  requesterFromAgentRun,
  requesterFromBeforeDispatch,
  requesterFromToolContext,
  type TrustedRequesterContext,
} from "./runtime/requester-context.js";
import { JiraFailure } from "./jira/types.js";
import {
  beginServiceRuntime,
  createServiceRuntimeCandidate,
  createServiceRuntimeGeneration,
  failServiceRuntime,
  getServiceRuntime,
  getServiceRuntimeStatus,
  publishServiceRuntime,
  stopServiceRuntime,
  type RuntimeServices,
  type ServiceRuntimeStatus,
} from "./runtime/service-runtime.js";
import type { PluginDatabase } from "./storage/database.js";
import { DraftVersionConflict } from "./workflow/draft-service.js";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentRunEvent,
  PluginHookBeforeAgentRunResult,
  PluginHookBeforeDispatchContext,
  PluginHookBeforeDispatchEvent,
  PluginHookBeforeDispatchResult,
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
const jiraDraftParameters = Type.Object({ draftId: text(128) }, { additionalProperties: false });
const jiraAnswerParameters = Type.Object({
  draftId: text(128),
  questionId: text(128),
  value: Type.Union([text(10_000), Type.Number(), Type.Array(text(512), { minItems: 1, maxItems: 50, uniqueItems: true })]),
}, { additionalProperties: false });
const jiraPreviewParameters = Type.Object({
  draftId: text(128),
  explicitProceed: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
const jiraConfirmParameters = Type.Object({
  draftId: text(128),
  explicitProceed: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
const jiraCreateParameters = Type.Object({
  draftId: text(128),
  confirmationId: text(128),
  explicitProceed: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

function runtimeBuildFingerprint(): string | null {
  const value = process.env.IDEA_TO_JIRA_BUILD_FINGERPRINT?.trim();
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function isActiveCreator(runtime: RuntimeServices, requester: TrustedRequesterContext): boolean {
  const decision = runtime.accessService.authorizeConversation(requester);
  return decision.allowed && decision.via === "ACTIVE_CREATOR";
}

function isConversationAllowed(runtime: RuntimeServices, requester: TrustedRequesterContext): boolean {
  return runtime.accessService.authorizeConversation(requester).allowed;
}

function mappedToolError(error: unknown): "JIRA_AUTH_FAILED" | "JIRA_RATE_LIMITED" | "JIRA_SCOPE_INVALID" | "JIRA_UNAVAILABLE" | "JIRA_REQUEST_FAILED" | undefined {
  if (!(error instanceof JiraFailure)) return undefined;
  if (error.code === "JIRA_UNAUTHORIZED" || error.code === "JIRA_FORBIDDEN") return "JIRA_AUTH_FAILED";
  if (error.code === "JIRA_RATE_LIMITED") return "JIRA_RATE_LIMITED";
  if (error.code === "JIRA_SCOPE_NOT_FOUND") return "JIRA_SCOPE_INVALID";
  if (["JIRA_DISABLED", "JIRA_CREDENTIAL_MISSING", "JIRA_TIMEOUT", "JIRA_SERVER_ERROR", "JIRA_NETWORK_ERROR", "JIRA_CIRCUIT_OPEN"].includes(error.code)) return "JIRA_UNAVAILABLE";
  return "JIRA_REQUEST_FAILED";
}

function persistAudit(
  storage: PluginDatabase,
  auditWriter: SqliteAuditWriter,
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
  api.on("before_dispatch", (
    event: PluginHookBeforeDispatchEvent,
    context: PluginHookBeforeDispatchContext,
  ): PluginHookBeforeDispatchResult => {
    const sessionKey = context.sessionKey ?? event.sessionKey;
    if (event.channel !== "telegram" || (sessionKey && !sessionKey.startsWith("agent:idea-mvp:"))) {
      return { handled: false };
    }
    return { handled: true, text: CONVERSATION_ROLE_REPLIES.UNAVAILABLE };
  }, { priority: 1_000 });
  api.on("before_agent_run", (): PluginHookBeforeAgentRunResult => ({
    outcome: "block",
    reason: code,
    message: "This request is unavailable.",
    category: "access_policy",
  }), { priority: 1_000 });
}

function logRuntimeDiagnostic(
  api: OpenClawPluginApi,
  surface: "before_dispatch" | "before_agent_run" | "tool_execute",
  status: ServiceRuntimeStatus,
): void {
  try {
    api.logger.warn(
      `idea-to-jira runtime surface=${surface}` +
      ` phase=${status.phase}` +
      ` generation=${status.generation}` +
      ` latest_generation=${status.latestGeneration}` +
      ` instance=${status.instanceId ? "present" : "absent"}` +
      ` code=${status.failureCode}`,
    );
  } catch {
    // Bounded diagnostics must never alter the fail-closed result.
  }
}

const plugin = {
  id: "idea-to-jira",
  name: "Idea-to-Jira MVP",
  description: "Configuration-driven Draft-to-Jira MVP with bounded search and atomic confirmed create.",
  register(api: OpenClawPluginApi) {
    const loaded = loadEffectiveConfig(api.pluginConfig);
    if (!loaded.ok) {
      registerStartupDisabledGate(api, loaded.code);
      return;
    }

    const config = loaded.config;
    assertCreateDisabled(config);
    const logger = new StructuredLogger(api.logger);
    const runtimeGeneration = createServiceRuntimeGeneration();
    let ownedInstanceId: string | undefined;
    let ownedStorage: PluginDatabase | undefined;
    let ownedJiraWorkflow: RuntimeServices["jiraWorkflow"];

    const logLifecycle = (
      eventType: "STORAGE_STARTING" | "STORAGE_READY" | "STORAGE_STARTUP" | "STORAGE_STOPPED",
      outcome: "SUCCEEDED" | "FAILED",
      errorCode?: "STORAGE_STARTUP_FAILED",
    ): void => {
      try {
        logger.emit(errorCode ? "ERROR" : "INFO", {
          timestamp: new Date().toISOString(),
          component: "STORAGE",
          eventType,
          outcome,
          operationId: ownedInstanceId
            ? `instance:${ownedInstanceId}`
            : `generation:${runtimeGeneration}`,
          ...(errorCode ? { errorCode } : {}),
        });
      } catch {
        // Observability must never change the fail-closed lifecycle state.
      }
    };

    try {
      const status = getServiceRuntimeStatus();
      api.logger.info(
        `idea-to-jira runtime action=registered` +
        ` registration_generation=${runtimeGeneration}` +
        ` phase=${status.phase}` +
        ` generation=${status.generation}` +
        ` latest_generation=${status.latestGeneration}` +
        ` instance=${status.instanceId ? "present" : "absent"}`,
      );
    } catch {
      // Registration diagnostics must not affect service startup.
    }

    api.registerService({
      id: "idea-to-jira-storage",
      start() {
        if (!beginServiceRuntime(runtimeGeneration)) {
          throw new SafeError("STORAGE_STARTUP_FAILED", false);
        }
        ownedInstanceId = getServiceRuntimeStatus().instanceId ?? undefined;
        logLifecycle("STORAGE_STARTING", "SUCCEEDED");
        try {
          const candidate = createServiceRuntimeCandidate(config);
          if (!publishServiceRuntime(runtimeGeneration, candidate)) {
            candidate.storage.close();
            throw new SafeError("STORAGE_STARTUP_FAILED", false);
          }
          ownedStorage = candidate.storage;
          ownedJiraWorkflow = candidate.jiraWorkflow;
          void candidate.jiraWorkflow?.start();
          logLifecycle("STORAGE_READY", "SUCCEEDED");
        } catch (error) {
          failServiceRuntime(runtimeGeneration, "STORAGE_STARTUP_FAILED");
          logLifecycle("STORAGE_STARTUP", "FAILED", "STORAGE_STARTUP_FAILED");
          throw error instanceof SafeError
            ? error
            : new SafeError("STORAGE_STARTUP_FAILED", false, { cause: error });
        }
      },
      stop() {
        stopServiceRuntime(runtimeGeneration);
        const activeStorage = ownedStorage;
        const activeJiraWorkflow = ownedJiraWorkflow;
        ownedStorage = undefined;
        ownedJiraWorkflow = undefined;
        try {
          activeJiraWorkflow?.stop();
          activeStorage?.close();
          logLifecycle("STORAGE_STOPPED", "SUCCEEDED");
        } catch {
          logLifecycle("STORAGE_STOPPED", "FAILED");
          throw new Error("STORAGE_CLOSE_FAILED");
        }
      },
    });

    registerAccessCommands(api, config, () => {
      const runtime = getServiceRuntime();
      return runtime
        ? { config: runtime.config, service: runtime.accessService, limiter: runtime.limiter }
        : undefined;
    }, getServiceRuntimeStatus);

    api.registerGatewayMethod("idea-to-jira.runtime-status", ({ respond }) => {
      const status = getServiceRuntimeStatus();
      const active = getServiceRuntime();
      respond(true, {
        schemaVersion: status.schemaVersion,
        generation: status.generation,
        latestGeneration: status.latestGeneration,
        instanceId: status.instanceId,
        phase: status.phase,
        code: status.phase === "READY" ? null : status.failureCode,
        storageHealthy: active?.storage.health.healthy === true,
        storageSchemaVersion: active?.storage.health.schemaVersion ?? null,
        buildFingerprint: runtimeBuildFingerprint(),
        jiraReadiness: active?.jiraWorkflow?.status().readiness ?? "JIRA_UNAVAILABLE",
        jiraMetadataHash: active?.jiraWorkflow?.status().metadataHash ?? null,
      });
    }, { scope: "operator.read" });

    api.on("before_dispatch", (
      event: PluginHookBeforeDispatchEvent,
      context: PluginHookBeforeDispatchContext,
    ): PluginHookBeforeDispatchResult => {
      const runtime = getServiceRuntime();
      if (!runtime) {
        const requester = requesterFromBeforeDispatch(event, context, config);
        if (!requester.ok && requester.code === "AGENT_DENIED") return { handled: false };
        logRuntimeDiagnostic(api, "before_dispatch", getServiceRuntimeStatus());
        return { handled: true, text: CONVERSATION_ROLE_REPLIES.UNAVAILABLE };
      }
      const requester = requesterFromBeforeDispatch(event, context, runtime.config);
      if (!requester.ok) {
        // A global dispatch hook must not claim traffic routed to another agent.
        if (requester.code === "AGENT_DENIED") return { handled: false };
        persistAudit(
          runtime.storage,
          runtime.auditWriter,
          logger,
          createAuditEvent({
            actor: { kind: "SYSTEM" },
            action: "SECURITY_DECISION",
            target: { type: "SECURITY_BOUNDARY" },
            outcome: "REJECTED",
            code: requester.code,
            links: createCorrelationContext(),
            retentionClass: "AUDIT_1Y",
          }),
        );
        return { handled: true, text: CONVERSATION_ROLE_REPLIES.UNAVAILABLE };
      }
      let decision;
      try {
        decision = runtime.accessService.authorizeConversation(requester.context);
      } catch {
        return { handled: true, text: CONVERSATION_ROLE_REPLIES.UNAVAILABLE };
      }
      if (decision.allowed) return { handled: false };
      const message = decision.state === "ROLE_STALE"
        ? CONVERSATION_ROLE_REPLIES.UNAVAILABLE
        : CONVERSATION_ROLE_REPLIES[decision.state];
      const recorded = persistAudit(
        runtime.storage,
        runtime.auditWriter,
        logger,
        createAuditEvent({
          actor: {
            kind: "USER",
            refHash: hashAuditActorReference(requester.context.accountId, requester.context.senderId),
          },
          action: "SECURITY_DECISION",
          target: { type: "SECURITY_BOUNDARY" },
          outcome: "REJECTED",
          code: `CONVERSATION_ROLE_${decision.state}`,
          links: createCorrelationContext(),
          retentionClass: "AUDIT_1Y",
        }),
      );
      return {
        handled: true,
        text: recorded ? message : CONVERSATION_ROLE_REPLIES.UNAVAILABLE,
      };
    }, { priority: 1_000 });

    api.on("before_agent_run", (
      event: PluginHookBeforeAgentRunEvent,
      context: PluginHookAgentContext,
    ): PluginHookBeforeAgentRunResult => {
      const runtime = getServiceRuntime();
      if (!runtime) {
        const status = getServiceRuntimeStatus();
        logRuntimeDiagnostic(api, "before_agent_run", status);
        return {
          outcome: "block",
          reason: status.phase === "FAILED" ? status.failureCode : "STORAGE_NOT_READY",
          message: CONVERSATION_ROLE_REPLIES.UNAVAILABLE,
          category: "access_policy",
        };
      }
      const { accessService, auditWriter, config: activeConfig, limiter, storage } = runtime;
      const trace = createCorrelationContext();
      const requester = requesterFromAgentRun(event, context, activeConfig);
      if (!requester.ok) {
        const recorded = persistAudit(storage, auditWriter, logger, createAuditEvent({
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
      let roleDecision;
      try {
        roleDecision = accessService.authorizeConversation(requester.context);
      } catch {
        return {
          outcome: "block",
          reason: "ACCESS_REQUEST_CONFLICT",
          message: CONVERSATION_ROLE_REPLIES.UNAVAILABLE,
          category: "access_policy",
        };
      }
      const actor = {
        kind: "USER" as const,
        refHash: hashAuditActorReference(requester.context.accountId, requester.context.senderId),
      };
      if (!roleDecision.allowed) {
        const message = roleDecision.state === "ROLE_STALE"
          ? CONVERSATION_ROLE_REPLIES.UNAVAILABLE
          : CONVERSATION_ROLE_REPLIES[roleDecision.state];
        const recorded = persistAudit(storage, auditWriter, logger, createAuditEvent({
          actor,
          action: "SECURITY_DECISION",
          target: { type: "SECURITY_BOUNDARY" },
          outcome: "REJECTED",
          code: `CONVERSATION_ROLE_${roleDecision.state}`,
          links: trace,
          retentionClass: "AUDIT_1Y",
        }));
        return {
          outcome: "block",
          reason: recorded ? roleDecision.state : "AUDIT_REQUIRED",
          message: recorded ? message : CONVERSATION_ROLE_REPLIES.UNAVAILABLE,
          category: "access_policy",
        };
      }
      const allowed = limiter.consume(requester.context, "model_run").allowed;
      const code = allowed ? "POLICY_OK" : "RATE_LIMITED";
      const recorded = persistAudit(storage, auditWriter, logger, createAuditEvent({
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
      toolContext: Parameters<typeof requesterFromToolContext>[0],
      input: unknown,
      action: (
        runtime: RuntimeServices,
        requester: ReturnType<typeof requesterFromToolContext> & { readonly ok: true },
      ) => T | Promise<T>,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: T }> {
      const activeRuntime = getServiceRuntime();
      if (!activeRuntime) {
        logRuntimeDiagnostic(api, "tool_execute", getServiceRuntimeStatus());
        throw new SafeError("STORAGE_NOT_READY", false);
      }
      const requester = requesterFromToolContext(toolContext, activeRuntime.config);
      if (!requester.ok) throw new SafeError("ACCESS_DENIED", false);
      if (!isConversationAllowed(activeRuntime, requester.context)) {
        throw new SafeError("ACCESS_DENIED", false);
      }
      const activeStorage = activeRuntime.storage;
      try {
        requireRateLimit(activeRuntime.limiter, requester.context, "draft_tool");
        assertPayloadWithinLimit(input, activeRuntime.config);
        assertCreateDisabled(activeRuntime.config);
        const trace = createCorrelationContext();
        if (!persistAudit(activeStorage, activeRuntime.auditWriter, logger, createAuditEvent({
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
        const result = await action(activeRuntime, requester);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      } catch (error) {
        if (error instanceof DraftVersionConflict || error instanceof SafeError) throw error;
        const mapped = mappedToolError(error);
        const message = error instanceof Error ? error.message : "";
        const code = mapped ?? (isSafeErrorCode(message) ? message : message === "JIRA_ANSWER_FIELD_NOT_ALLOWED" ? "JIRA_REQUIRED_ANSWER_INVALID" : "DRAFT_INVALID");
        throw new SafeError(code, code === "RATE_LIMITED", { cause: error });
      }
    }

    api.registerTool((toolContext) => {
      const activeRuntime = getServiceRuntime();
      if (!activeRuntime) return null;
      const requester = requesterFromToolContext(toolContext, activeRuntime.config);
      if (!requester.ok || !isConversationAllowed(activeRuntime, requester.context)) return null;
      return {
        name: "idea_to_jira_create_draft",
        label: "Create own Draft",
        description: "Create a versioned Draft owned by the current Telegram sender; never writes to Jira.",
        parameters: createDraftParameters,
        execute: async (_id: string, input: unknown) => executeTool(toolContext, input, (runtime, currentRequester) =>
          runtime.draftService.createDraft(currentRequester.context, input as CreateDraftInput)),
      };
    }, { name: "idea_to_jira_create_draft" });

    api.registerTool((toolContext) => {
      const activeRuntime = getServiceRuntime();
      if (!activeRuntime) return null;
      const requester = requesterFromToolContext(toolContext, activeRuntime.config);
      if (!requester.ok || !isConversationAllowed(activeRuntime, requester.context)) return null;
      return {
        name: "idea_to_jira_read_draft",
        label: "Read own Draft",
        description: "Read the current immutable version of a Draft owned by the current Telegram sender.",
        parameters: readDraftParameters,
        execute: async (_id: string, input: unknown) => executeTool(toolContext, input, (runtime, currentRequester) =>
          runtime.draftService.readDraft(currentRequester.context, (input as { draftId: string }).draftId)),
      };
    }, { name: "idea_to_jira_read_draft" });

    api.registerTool((toolContext) => {
      const activeRuntime = getServiceRuntime();
      if (!activeRuntime) return null;
      const requester = requesterFromToolContext(toolContext, activeRuntime.config);
      if (!requester.ok || !isConversationAllowed(activeRuntime, requester.context)) return null;
      return {
        name: "idea_to_jira_patch_draft",
        label: "Patch own Draft",
        description: "CAS patch domain fields of an owned Draft; arbitrary Jira fields are rejected.",
        parameters: patchDraftParameters,
        execute: async (_id: string, input: unknown) => executeTool(toolContext, input, (runtime, currentRequester) =>
          runtime.draftService.patchDraft(currentRequester.context, input as PatchDraftInput)),
      };
    }, { name: "idea_to_jira_patch_draft" });

    api.registerTool((toolContext) => {
      const activeRuntime = getServiceRuntime();
      if (!activeRuntime) return null;
      const requester = requesterFromToolContext(toolContext, activeRuntime.config);
      if (!requester.ok || !isConversationAllowed(activeRuntime, requester.context)) return null;
      return {
        name: "idea_to_jira_cancel_draft",
        label: "Cancel own Draft",
        description: "Cancel an owned Draft with CAS while preserving its immutable versions and audit.",
        parameters: cancelDraftParameters,
        execute: async (_id: string, input: unknown) => executeTool(toolContext, input, (runtime, currentRequester) =>
          runtime.draftService.cancelDraft(currentRequester.context, input as CancelDraftInput)),
      };
    }, { name: "idea_to_jira_cancel_draft" });

    api.registerTool((toolContext) => {
      const activeRuntime = getServiceRuntime();
      if (!activeRuntime || !activeRuntime.jiraWorkflow) return null;
      const requester = requesterFromToolContext(toolContext, activeRuntime.config);
      if (!requester.ok || !isActiveCreator(activeRuntime, requester.context)) return null;
      return {
        name: "idea_to_jira_search_duplicates",
        label: "Search configured Jira scope",
        description: "Search only the deployment-configured JQL/fields and produce a version-bound duplicate decision.",
        parameters: jiraDraftParameters,
        execute: async (_id: string, input: unknown) => executeTool(toolContext, input, async (runtime, currentRequester) => {
          if (!runtime.jiraWorkflow) throw new SafeError("JIRA_REQUEST_FAILED", true);
          if (!isActiveCreator(runtime, currentRequester.context)) throw new SafeError("ACCESS_DENIED", false);
          const draft = runtime.draftService.readDraft(currentRequester.context, (input as { draftId: string }).draftId).draft;
          return runtime.jiraWorkflow.searchDuplicates(draft);
        }),
      };
    }, { name: "idea_to_jira_search_duplicates" });

    api.registerTool((toolContext) => {
      const activeRuntime = getServiceRuntime();
      if (!activeRuntime || !activeRuntime.jiraWorkflow) return null;
      const requester = requesterFromToolContext(toolContext, activeRuntime.config);
      if (!requester.ok || !isActiveCreator(activeRuntime, requester.context)) return null;
      return {
        name: "idea_to_jira_answer_field",
        label: "Answer a discovered Jira field",
        description: "Store a semantic answer for one current metadata-derived typed question; arbitrary Jira JSON is impossible.",
        parameters: jiraAnswerParameters,
        execute: async (_id: string, input: unknown) => executeTool(toolContext, input, async (runtime, currentRequester) => {
          const answer = input as { draftId: string; questionId: string; value: string | number | readonly string[] };
          if (!runtime.jiraWorkflow) throw new SafeError("JIRA_REQUEST_FAILED", true);
          if (!isActiveCreator(runtime, currentRequester.context)) throw new SafeError("ACCESS_DENIED", false);
          const draft = runtime.draftService.readDraft(currentRequester.context, answer.draftId).draft;
          return runtime.jiraWorkflow.answerField(draft, answer.questionId, answer.value);
        }),
      };
    }, { name: "idea_to_jira_answer_field" });

    api.registerTool((toolContext) => {
      const activeRuntime = getServiceRuntime();
      if (!activeRuntime || !activeRuntime.jiraWorkflow) return null;
      const requester = requesterFromToolContext(toolContext, activeRuntime.config);
      if (!requester.ok || !isActiveCreator(activeRuntime, requester.context)) return null;
      return {
        name: "idea_to_jira_preview_issue",
        label: "Preview exact Jira issue",
        description: "Build a bounded preview bound to the current Draft, metadata, duplicate decision, and canonical payload.",
        parameters: jiraPreviewParameters,
        execute: async (_id: string, input: unknown) => executeTool(toolContext, input, async (runtime, currentRequester) => {
          const value = input as { draftId: string; explicitProceed?: boolean };
          if (!runtime.jiraWorkflow) throw new SafeError("JIRA_REQUEST_FAILED", true);
          if (!isActiveCreator(runtime, currentRequester.context)) throw new SafeError("ACCESS_DENIED", false);
          const draft = runtime.draftService.readDraft(currentRequester.context, value.draftId).draft;
          return runtime.jiraWorkflow.preview(draft, value.explicitProceed === true);
        }),
      };
    }, { name: "idea_to_jira_preview_issue" });

    api.registerTool((toolContext) => {
      const activeRuntime = getServiceRuntime();
      if (!activeRuntime || !activeRuntime.jiraWorkflow) return null;
      const requester = requesterFromToolContext(toolContext, activeRuntime.config);
      if (!requester.ok || !isActiveCreator(activeRuntime, requester.context)) return null;
      return {
        name: "idea_to_jira_confirm_issue",
        label: "Confirm exact Jira preview",
        description: "Confirm the current preview for the host-derived actor/chat and exact Draft/metadata/payload versions.",
        parameters: jiraConfirmParameters,
        execute: async (_id: string, input: unknown) => executeTool(toolContext, input, async (runtime, currentRequester) => {
          const value = input as { draftId: string; explicitProceed?: boolean };
          if (!runtime.jiraWorkflow) throw new SafeError("JIRA_REQUEST_FAILED", true);
          if (!isActiveCreator(runtime, currentRequester.context)) throw new SafeError("ACCESS_DENIED", false);
          const draft = runtime.draftService.readDraft(currentRequester.context, value.draftId).draft;
          return runtime.jiraWorkflow.confirm(draft, currentRequester.context.senderId, currentRequester.context.chatId, value.explicitProceed === true);
        }),
      };
    }, { name: "idea_to_jira_confirm_issue" });

    api.registerTool((toolContext) => {
      const activeRuntime = getServiceRuntime();
      if (!activeRuntime || !activeRuntime.jiraWorkflow) return null;
      const requester = requesterFromToolContext(toolContext, activeRuntime.config);
      if (!requester.ok || !isActiveCreator(activeRuntime, requester.context)) return null;
      return {
        name: "idea_to_jira_create_issue",
        label: "Create confirmed Jira issue",
        description: "Execute the one fixed Jira create endpoint through the atomic idempotent operation boundary.",
        parameters: jiraCreateParameters,
        execute: async (_id: string, input: unknown) => executeTool(toolContext, input, async (runtime, currentRequester) => {
          const value = input as { draftId: string; confirmationId: string; explicitProceed?: boolean };
          if (!runtime.jiraWorkflow) throw new SafeError("JIRA_REQUEST_FAILED", true);
          if (!isActiveCreator(runtime, currentRequester.context)) throw new SafeError("ACCESS_DENIED", false);
          const draft = runtime.draftService.readDraft(currentRequester.context, value.draftId).draft;
          return runtime.jiraWorkflow.create(draft, currentRequester.context.senderId, currentRequester.context.chatId, value.confirmationId, value.explicitProceed === true);
        }),
      };
    }, { name: "idea_to_jira_create_issue" });

    api.registerTool((toolContext) => {
      const activeRuntime = getServiceRuntime();
      if (!activeRuntime) return null;
      const requester = requesterFromToolContext(toolContext, activeRuntime.config);
      if (!requester.ok || !isConversationAllowed(activeRuntime, requester.context)) return null;
      return {
        name: "idea_to_jira_request_access",
        label: "Request Creator access",
        description: "Create or read the current sender's bounded Creator access request.",
        parameters: requestAccessParameters,
        execute: async (_id: string, input: unknown) => executeTool(toolContext, input, (runtime, currentRequester) =>
          runtime.accessService.requestAccess(currentRequester.context)),
      };
    }, { name: "idea_to_jira_request_access" });
  },
};

export default plugin;
