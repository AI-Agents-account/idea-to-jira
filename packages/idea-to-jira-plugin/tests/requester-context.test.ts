import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginHookAgentContext, PluginHookBeforeAgentRunEvent } from "openclaw/plugin-sdk/types";

import {
  requesterFromAgentRun,
  requesterFromToolContext,
  validateRequesterFacts,
} from "../src/runtime/requester-context.js";
import { effectiveConfig } from "./config-fixture.js";

const config = effectiveConfig();

const validFacts = {
  agentId: "idea-mvp",
  trigger: "user",
  channelId: "telegram",
  accountId: "idea-mvp",
  senderId: "123456789",
  chatId: "123456789",
};

test("accepts only a host-derived Telegram DM context", () => {
  const result = validateRequesterFacts(validFacts, config);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.context.senderId, "123456789");
    assert.equal(Object.isFrozen(result.context), true);
  }
});

test("denies missing or ambiguous sender and non-DM destinations", () => {
  const { senderId: _senderId, ...withoutSender } = validFacts;
  assert.deepEqual(validateRequesterFacts(withoutSender, config), {
    ok: false,
    code: "SENDER_MISSING",
  });
  assert.deepEqual(validateRequesterFacts({ ...validFacts, senderId: "telegram:123456789" }, config), {
    ok: false,
    code: "SENDER_MISSING",
  });
  assert.deepEqual(validateRequesterFacts({ ...validFacts, chatId: "-100123456789" }, config), {
    ok: false,
    code: "DESTINATION_DENIED",
  });
  assert.deepEqual(validateRequesterFacts({ ...validFacts, threadId: 42 }, config), {
    ok: false,
    code: "THREAD_DENIED",
  });
});

test("denies wrong agent, channel, account, and host-derived trigger", () => {
  const cases = [
    [{ ...validFacts, agentId: "main" }, "AGENT_DENIED"],
    [{ ...validFacts, channelId: "discord" }, "CHANNEL_DENIED"],
    [{ ...validFacts, accountId: "default" }, "ACCOUNT_DENIED"],
    [{ ...validFacts, trigger: "heartbeat" }, "TRIGGER_DENIED"],
    [{ ...validFacts, trigger: "cron" }, "TRIGGER_DENIED"],
  ] as const;
  for (const [facts, code] of cases) {
    assert.deepEqual(validateRequesterFacts(facts, config), { ok: false, code });
  }
});

test("extracts identity from trusted tool factory context, never tool arguments", () => {
  const context = {
    agentId: "idea-mvp",
    messageChannel: "telegram",
    agentAccountId: "idea-mvp",
    requesterSenderId: "123456789",
    deliveryContext: { channel: "telegram", accountId: "idea-mvp", to: "123456789" },
  } as OpenClawPluginToolContext;
  assert.equal(requesterFromToolContext(context, config).ok, true);
  assert.deepEqual(requesterFromToolContext({ ...context, oneShotCliRun: true }, config), {
    ok: false,
    code: "TRIGGER_DENIED",
  });
});

test("before_agent_run adapter requires a direct user trigger", () => {
  const event = {
    prompt: "untrusted prompt",
    messages: [],
    accountId: "idea-mvp",
    channelId: "telegram",
    senderId: "123456789",
  } satisfies PluginHookBeforeAgentRunEvent;
  const context = {
    agentId: "idea-mvp",
    trigger: "user",
    messageProvider: "telegram",
    chatId: "123456789",
  } satisfies PluginHookAgentContext;
  assert.equal(requesterFromAgentRun(event, context, config).ok, true);
  assert.deepEqual(requesterFromAgentRun(event, { ...context, trigger: "heartbeat" }, config), {
    ok: false,
    code: "TRIGGER_DENIED",
  });
});
