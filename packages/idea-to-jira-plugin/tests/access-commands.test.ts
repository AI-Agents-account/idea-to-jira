import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "openclaw/plugin-sdk/plugin-entry";

import { AccessService } from "../src/access/access-service.js";
import { registerAccessCommands } from "../src/access/commands.js";
import { ensurePrivateStateDirectory } from "../src/runtime/state.js";
import { openPluginDatabase } from "../src/storage/database.js";
import { effectiveConfig } from "./config-fixture.js";

function commandContext(
  senderId: string,
  args = "",
  overrides: Partial<PluginCommandContext> = {},
): PluginCommandContext {
  return {
    senderId,
    channel: "telegram",
    channelId: "telegram",
    isAuthorizedSender: true,
    agentId: "idea-mvp",
    args,
    commandBody: args,
    config: {},
    from: `telegram:${senderId}`,
    to: `telegram:${senderId}`,
    accountId: "idea-mvp",
    requestConversationBinding: async () => ({ ok: false, error: "unused" }),
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
    ...overrides,
  } as unknown as PluginCommandContext;
}

function text(result: Awaited<ReturnType<OpenClawPluginCommandDefinition["handler"]>>): string {
  return result.text ?? "";
}

test("typed command boundary uses trusted context and fixed admin destinations", async () => {
  const stateDir = join(mkdtempSync(join(tmpdir(), "idea-to-jira-commands-")), "state");
  ensurePrivateStateDirectory(stateDir);
  const storage = openPluginDatabase({ stateDir });
  const config = effectiveConfig();
  const service = new AccessService({ unitOfWork: storage.repositories, config });
  const commands = new Map<string, OpenClawPluginCommandDefinition>();
  const sends: Array<{ to: string; accountId?: string | null; text: string }> = [];
  const api = {
    runtime: {
      channel: {
        outbound: {
          async loadAdapter() {
            return {
              deliveryMode: "direct",
              async sendText(context: { to: string; accountId?: string | null; text: string }) {
                sends.push(context);
                return { channel: "telegram", to: context.to, messageId: `message-${sends.length}` };
              },
            };
          },
        },
      },
    },
    registerCommand(command: OpenClawPluginCommandDefinition) {
      commands.set(command.name, command);
    },
  } as unknown as OpenClawPluginApi;
  registerAccessCommands(api, config, () => service);

  const requestCommand = commands.get("request_access");
  const accessCommand = commands.get("access");
  assert.ok(requestCommand);
  assert.ok(accessCommand);
  assert.equal(requestCommand.requireAuth, false);
  assert.equal(accessCommand.requireAuth, false);

  const requested = await requestCommand.handler(commandContext("123456789"));
  assert.equal(text(requested), "Access request submitted. Business Admins were notified.");
  assert.deepEqual(sends.map((send) => send.to), config.telegram.adminSenderIds);
  assert.equal(sends.every((send) => send.accountId === "idea-mvp"), true);
  assert.equal(sends.every((send) => !/summary|problem|jira candidate/i.test(send.text)), true);
  const actionRef = /Action reference: ([A-Za-z0-9_-]{20,64})/.exec(sends[0]?.text ?? "")?.[1];
  assert.ok(actionRef);

  const forged = await accessCommand.handler(commandContext(
    "333333333",
    `approve ${actionRef} 1 123456789`,
  ));
  assert.equal(text(forged), "This request is unavailable.");
  assert.equal(service.getStatus({
    agentId: "idea-mvp",
    channelId: "telegram",
    accountId: "idea-mvp",
    senderId: "123456789",
    chatId: "123456789",
  }).userState, "PENDING");

  const substitutedDestination = await accessCommand.handler(commandContext(
    "123456789",
    `approve ${actionRef} 1`,
    { to: "telegram:222222222" },
  ));
  assert.equal(text(substitutedDestination), "This request is unavailable.");

  const approved = await accessCommand.handler(commandContext(
    "123456789",
    `approve ${actionRef} 1`,
  ));
  assert.match(text(approved), /Request state: APPROVED/);
  assert.match(text(approved), /Grant state: ACTIVE/);

  const replay = await accessCommand.handler(commandContext(
    "123456789",
    `deny ${actionRef} 1`,
  ));
  assert.equal(text(replay), "The action is stale or was already completed. Refresh status before retrying.");
  storage.close();
});
