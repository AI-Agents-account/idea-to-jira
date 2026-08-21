import type { OpenClawPluginToolContext, PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginHookAgentContext, PluginHookBeforeAgentRunEvent } from "openclaw/plugin-sdk/types";

import type { EffectiveConfig } from "../config.js";

export type RequesterContextErrorCode =
  | "AGENT_DENIED"
  | "TRIGGER_DENIED"
  | "CHANNEL_DENIED"
  | "ACCOUNT_DENIED"
  | "SENDER_MISSING"
  | "SENDER_DENIED"
  | "DESTINATION_DENIED"
  | "THREAD_DENIED";

export interface TrustedRequesterContext {
  readonly agentId: "idea-mvp";
  readonly channelId: "telegram";
  readonly accountId: "default";
  readonly senderId: string;
  readonly chatId: string;
}

export type RequesterContextResult =
  | { readonly ok: true; readonly context: TrustedRequesterContext }
  | { readonly ok: false; readonly code: RequesterContextErrorCode };

interface RequesterFacts {
  readonly agentId?: string | undefined;
  readonly trigger?: string | undefined;
  readonly channelId?: string | undefined;
  readonly accountId?: string | undefined;
  readonly senderId?: string | undefined;
  readonly chatId?: string | undefined;
  readonly threadId?: string | number | undefined;
}

function normalized(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numericTelegramId(value: string | undefined): value is string {
  return value !== undefined && /^[1-9][0-9]{0,19}$/.test(value);
}

export function validateRequesterFacts(facts: RequesterFacts, config: EffectiveConfig): RequesterContextResult {
  const agentId = normalized(facts.agentId);
  const channelId = normalized(facts.channelId);
  const accountId = normalized(facts.accountId);
  const senderId = normalized(facts.senderId);
  const chatId = normalized(facts.chatId);

  if (agentId !== config.agentId) return { ok: false, code: "AGENT_DENIED" };
  if (facts.trigger !== undefined && facts.trigger !== "user") return { ok: false, code: "TRIGGER_DENIED" };
  if (channelId !== config.telegram.channelId) return { ok: false, code: "CHANNEL_DENIED" };
  if (accountId !== config.telegram.accountId) return { ok: false, code: "ACCOUNT_DENIED" };
  if (!numericTelegramId(senderId)) return { ok: false, code: "SENDER_MISSING" };
  if (senderId !== config.telegram.pilotSenderId) return { ok: false, code: "SENDER_DENIED" };
  if (!numericTelegramId(chatId) || chatId !== senderId) return { ok: false, code: "DESTINATION_DENIED" };
  if (facts.threadId !== undefined && String(facts.threadId).trim().length > 0) {
    return { ok: false, code: "THREAD_DENIED" };
  }

  return {
    ok: true,
    context: Object.freeze({
      agentId: "idea-mvp",
      channelId: "telegram",
      accountId: "default",
      senderId,
      chatId,
    }),
  };
}

/** Uses only host-populated tool-factory context; no tool argument can supply identity. */
export function requesterFromToolContext(
  context: OpenClawPluginToolContext,
  config: EffectiveConfig,
): RequesterContextResult {
  if (context.oneShotCliRun === true) return { ok: false, code: "TRIGGER_DENIED" };
  return validateRequesterFacts(
    {
      agentId: context.agentId,
      channelId: context.messageChannel ?? context.deliveryContext?.channel,
      accountId: context.agentAccountId ?? context.deliveryContext?.accountId,
      senderId: context.requesterSenderId,
      chatId: context.deliveryContext?.to,
      threadId: context.deliveryContext?.threadId,
    },
    config,
  );
}

/** Uses only host-populated command context. Command arguments are never identity input. */
export function requesterFromCommandContext(
  context: PluginCommandContext,
  config: EffectiveConfig,
): RequesterContextResult {
  const senderId = normalized(context.senderId);
  if (!numericTelegramId(senderId)) return { ok: false, code: "SENDER_MISSING" };
  // Telegram native commands expose channel-qualified From/To targets while senderId
  // remains the plain provider identity. Both targets must bind to the same DM peer.
  const expectedTarget = `${config.telegram.channelId}:${senderId}`;
  if (context.from !== expectedTarget || context.to !== expectedTarget) {
    return { ok: false, code: "DESTINATION_DENIED" };
  }
  return validateRequesterFacts(
    {
      agentId: context.agentId,
      trigger: "user",
      channelId: context.channelId ?? context.channel,
      accountId: context.accountId,
      senderId,
      chatId: senderId,
      threadId: context.messageThreadId ?? context.threadParentId,
    },
    config,
  );
}

/** Sole free-form conversation identity adapter and fail-closed server gate. */
export function requesterFromAgentRun(
  event: PluginHookBeforeAgentRunEvent,
  context: PluginHookAgentContext,
  config: EffectiveConfig,
): RequesterContextResult {
  if (context.trigger !== "user") return { ok: false, code: "TRIGGER_DENIED" };
  return validateRequesterFacts(
    {
      agentId: context.agentId,
      trigger: context.trigger,
      channelId: event.channelId ?? context.messageProvider,
      accountId: event.accountId,
      senderId: event.senderId ?? context.senderId,
      chatId: context.chatId ?? context.channelId ?? context.channel,
    },
    config,
  );
}
