import type {
  OpenClawPluginApi,
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/plugin-entry";

import type { EffectiveConfig } from "../config.js";
import { authorizeBusinessAdmin } from "../auth/authorization.js";
import { normalizeSafeError, SafeError, type SafeErrorCode } from "../errors/index.js";
import {
  requesterFromCommandContext,
  type RequesterContextErrorCode,
} from "../runtime/requester-context.js";
import type { RateLimiter } from "../runtime/policy.js";
import type { ServiceRuntimeStatus } from "../runtime/service-runtime.js";
import {
  AccessService,
  renderAdminAccessCard,
  type AccessDecision,
  type RoleTransition,
} from "./access-service.js";

const REF = /^[A-Za-z0-9_-]{20,64}$/;

type AccessCommandName = "access" | "request_access";
type AccessDiagnosticAction = "requester_validation" | "safe_failure";
interface AccessCommandRuntime {
  readonly config: EffectiveConfig;
  readonly service: AccessService;
  readonly limiter: RateLimiter;
}

function logAccessDiagnostic(
  api: OpenClawPluginApi,
  command: AccessCommandName,
  action: AccessDiagnosticAction,
  code: RequesterContextErrorCode | SafeErrorCode,
  runtimeStatus?: ServiceRuntimeStatus,
): void {
  try {
    const runtime = runtimeStatus
      ? ` runtime_phase=${runtimeStatus.phase}` +
        ` runtime_generation=${runtimeStatus.generation}` +
        ` latest_generation=${runtimeStatus.latestGeneration}` +
        ` runtime_instance=${runtimeStatus.instanceId ? "present" : "absent"}`
      : "";
    api.logger.warn(`idea-to-jira access command=${command} action=${action} code=${code}${runtime}`);
  } catch {
    // Diagnostics must not alter the command's fail-closed response.
  }
}

function reply(text: string): PluginCommandResult {
  return { text };
}

function safeFailure(error: unknown): PluginCommandResult {
  if (error instanceof SafeError &&
      (error.code === "ACCESS_REQUEST_STALE" || error.code === "ROLE_STALE")) {
    return reply("The action is stale or was already completed. Refresh status before retrying.");
  }
  if (error instanceof SafeError && error.code === "ACCESS_REQUEST_CONFLICT") {
    return reply("The access request is not available in the current state.");
  }
  if (error instanceof SafeError && error.code === "ROLE_STATE_INVALID") {
    return reply("The role transition is not valid in the current state.");
  }
  if (error instanceof SafeError && error.code === "RATE_LIMITED") {
    return reply("Слишком много запросов. Повторите команду /request_access позже.");
  }
  return reply("This request is unavailable.");
}

function requiredRuntime(runtime: AccessCommandRuntime | undefined): AccessCommandRuntime {
  if (!runtime) throw new SafeError("STORAGE_NOT_READY", false);
  return runtime;
}

function parseVersion(value: string | undefined): number | undefined {
  if (!value || !/^[1-9][0-9]{0,8}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseActionArgs(args: string | undefined): {
  readonly action: string;
  readonly ref?: string;
  readonly version?: number;
  readonly reason?: string;
} {
  const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
  const [action = "status", ref, versionText, ...reasonParts] = parts;
  const version = parseVersion(versionText);
  return Object.freeze({
    action: action.toLowerCase(),
    ...(ref && REF.test(ref) ? { ref } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(reasonParts.length > 0 ? { reason: reasonParts.join(" ") } : {}),
  });
}

async function notifyAdmins(
  api: OpenClawPluginApi,
  context: PluginCommandContext,
  config: EffectiveConfig,
  card: string,
): Promise<void> {
  const adapter = await api.runtime.channel.outbound.loadAdapter(config.telegram.channelId);
  if (!adapter?.sendText) throw new Error("TELEGRAM_OUTBOUND_UNAVAILABLE");
  let failures = 0;
  for (const destination of config.telegram.adminSenderIds) {
    try {
      await adapter.sendText({
        cfg: context.config,
        to: destination,
        text: card,
        accountId: config.telegram.accountId,
      });
    } catch {
      failures += 1;
    }
  }
  if (failures > 0) throw new Error("TELEGRAM_ADMIN_NOTIFICATION_FAILED");
}

function formatStatus(status: ReturnType<AccessService["getStatus"]>): string {
  const lines = [
    `Access state: ${status.userState}`,
    `User version: ${status.userVersion}`,
  ];
  if (status.request) {
    lines.push(`Request state: ${status.request.state}`, `Request version: ${status.request.version}`);
  }
  if (status.role) {
    lines.push(
      `Creator role: ${status.role.state}`,
      `Grant reference: ${status.role.grantRef}`,
      `Grant version: ${status.role.version}`,
    );
  }
  return lines.join("\n");
}

function formatDecision(result: ReturnType<AccessService["decideAccess"]>): string {
  return [
    `Request state: ${result.requestState}`,
    `Request version: ${result.requestVersion}`,
    `User reference: ${result.userRef}`,
    `User state: ${result.userState}`,
    `User version: ${result.userVersion}`,
    ...(result.role
      ? [
          `Grant reference: ${result.role.grantRef}`,
          `Grant state: ${result.role.state}`,
          `Grant version: ${result.role.version}`,
        ]
      : []),
  ].join("\n");
}

function formatRole(result: ReturnType<AccessService["transitionRole"]>): string {
  return [
    `Grant reference: ${result.grantRef}`,
    `Grant state: ${result.grantState}`,
    `Grant version: ${result.grantVersion}`,
    `User reference: ${result.userRef}`,
    `User state: ${result.userState}`,
    `User version: ${result.userVersion}`,
  ].join("\n");
}

export function registerAccessCommands(
  api: OpenClawPluginApi,
  registrationConfig: EffectiveConfig,
  getRuntime: () => AccessCommandRuntime | undefined,
  getRuntimeStatus: () => ServiceRuntimeStatus,
): void {
  api.registerCommand({
    name: "request_access",
    description: "Request Creator access or show the existing request status.",
    channels: [registrationConfig.telegram.channelId],
    acceptsArgs: false,
    requireAuth: false,
    async handler(context) {
      try {
        const resolved = getRuntime();
        const config = resolved?.config ?? registrationConfig;
        const requester = requesterFromCommandContext(context, config);
        if (!requester.ok) {
          logAccessDiagnostic(api, "request_access", "requester_validation", requester.code);
          return reply("This request is unavailable.");
        }
        const runtime = requiredRuntime(resolved);
        if (!runtime.limiter.consume(requester.context, "access_request").allowed) {
          throw new SafeError("RATE_LIMITED", true);
        }
        const result = runtime.service.requestAccess(requester.context);
        if (result.created && result.adminCard) {
          try {
            await notifyAdmins(api, context, config, renderAdminAccessCard(result.adminCard));
            return reply("Access request submitted. Business Admins were notified.");
          } catch {
            return reply("Access request submitted. Admin notification delivery is unavailable.");
          }
        }
        return reply(`Current access status:\n${formatStatus(result.status)}`);
      } catch (error) {
        const code = normalizeSafeError(error).code;
        logAccessDiagnostic(
          api,
          "request_access",
          "safe_failure",
          code,
          code === "STORAGE_NOT_READY" ? getRuntimeStatus() : undefined,
        );
        return safeFailure(error);
      }
    },
  });

  api.registerCommand({
    name: "access",
    description: "Perform a Business Admin access transition.",
    channels: [registrationConfig.telegram.channelId],
    acceptsArgs: true,
    requireAuth: false,
    async handler(context) {
      try {
        const resolved = getRuntime();
        const config = resolved?.config ?? registrationConfig;
        const requester = requesterFromCommandContext(context, config);
        if (!requester.ok) {
          logAccessDiagnostic(api, "access", "requester_validation", requester.code);
          return reply("This request is unavailable.");
        }
        if (!authorizeBusinessAdmin(requester.context, config).allowed) {
          return reply("Чтобы запросить доступ, отправьте команду /request_access.");
        }
        const service = requiredRuntime(resolved).service;
        const parsed = parseActionArgs(context.args);
        if (parsed.action === "status") return reply(formatStatus(service.ensureUser(requester.context)));
        if (!parsed.ref || parsed.version === undefined) {
          return reply("Usage: /access <approve|deny|block|suspend|restore|revoke|block-role|unblock> <reference> <version>");
        }
        if (parsed.action === "approve" || parsed.action === "deny" || parsed.action === "block") {
          const decision = parsed.action.toUpperCase() as AccessDecision;
          return reply(formatDecision(service.decideAccess(requester.context, {
            actionRef: parsed.ref,
            expectedVersion: parsed.version,
            decision,
            ...(parsed.reason ? { reason: parsed.reason } : {}),
          })));
        }
        if (["suspend", "restore", "revoke", "block-role"].includes(parsed.action)) {
          const transition = (parsed.action === "block-role" ? "BLOCK" : parsed.action.toUpperCase()) as RoleTransition;
          return reply(formatRole(service.transitionRole(requester.context, {
            grantRef: parsed.ref,
            expectedVersion: parsed.version,
            transition,
            ...(parsed.reason ? { reason: parsed.reason } : {}),
          })));
        }
        if (parsed.action === "unblock") {
          return reply(formatStatus(service.unblockUser(requester.context, {
            userRef: parsed.ref,
            expectedVersion: parsed.version,
          })));
        }
        return reply("Unknown access action.");
      } catch (error) {
        const code = normalizeSafeError(error).code;
        logAccessDiagnostic(
          api,
          "access",
          "safe_failure",
          code,
          code === "STORAGE_NOT_READY" ? getRuntimeStatus() : undefined,
        );
        return safeFailure(error);
      }
    },
  });
}
