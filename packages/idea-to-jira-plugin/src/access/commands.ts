import type {
  OpenClawPluginApi,
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/plugin-entry";

import type { EffectiveConfig } from "../config.js";
import { SafeError } from "../errors/index.js";
import { requesterFromCommandContext } from "../runtime/requester-context.js";
import {
  AccessService,
  renderAdminAccessCard,
  type AccessDecision,
  type RoleTransition,
} from "./access-service.js";

const REF = /^[A-Za-z0-9_-]{20,64}$/;

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
  return reply("This request is unavailable.");
}

function requiredService(getService: () => AccessService | undefined): AccessService {
  const service = getService();
  if (!service) throw new SafeError("STORAGE_NOT_READY", false);
  return service;
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
  config: EffectiveConfig,
  getService: () => AccessService | undefined,
): void {
  api.registerCommand({
    name: "request_access",
    description: "Request Creator access or show the existing request status.",
    channels: [config.telegram.channelId],
    acceptsArgs: false,
    requireAuth: false,
    async handler(context) {
      try {
        const requester = requesterFromCommandContext(context, config);
        if (!requester.ok) return reply("This request is unavailable.");
        const result = requiredService(getService).requestAccess(requester.context);
        if (result.created && result.adminCard) {
          try {
            await notifyAdmins(api, context, config, renderAdminAccessCard(result.adminCard));
            return reply("Access request submitted. Business Admins were notified.");
          } catch {
            return reply("Access request submitted. Admin notification delivery is unavailable.");
          }
        }
        return reply(`Access request already exists.\n${formatStatus(result.status)}`);
      } catch (error) {
        return safeFailure(error);
      }
    },
  });

  api.registerCommand({
    name: "access",
    description: "Show access status or perform an allowlisted Business Admin transition.",
    channels: [config.telegram.channelId],
    acceptsArgs: true,
    requireAuth: false,
    async handler(context) {
      try {
        const requester = requesterFromCommandContext(context, config);
        if (!requester.ok) return reply("This request is unavailable.");
        const service = requiredService(getService);
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
        return safeFailure(error);
      }
    },
  });
}
