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
import { SafeError } from "../src/errors/index.js";
import { TokenBucketRateLimiter } from "../src/runtime/policy.js";
import type { ServiceRuntimeStatus } from "../src/runtime/service-runtime.js";
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
    accountId: "default",
    requestConversationBinding: async () => ({ ok: false, error: "unused" }),
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
    ...overrides,
  } as unknown as PluginCommandContext;
}

function text(result: Awaited<ReturnType<OpenClawPluginCommandDefinition["handler"]>>): string {
  return result.text ?? "";
}

function runtimeStatus(overrides: Partial<ServiceRuntimeStatus> = {}): ServiceRuntimeStatus {
  return {
    schemaVersion: 1,
    generation: 1,
    latestGeneration: 1,
    instanceId: "11111111-1111-4111-8111-111111111111",
    phase: "READY",
    failureCode: "STORAGE_NOT_READY",
    ...overrides,
  };
}

test("typed command boundary uses trusted context and fixed admin destinations", async () => {
  const stateDir = join(mkdtempSync(join(tmpdir(), "idea-to-jira-commands-")), "state");
  ensurePrivateStateDirectory(stateDir);
  const storage = openPluginDatabase({ stateDir });
  const config = effectiveConfig();
  const service = new AccessService({ unitOfWork: storage.repositories, config });
  const limiter = new TokenBucketRateLimiter(config.limits);
  const commands = new Map<string, OpenClawPluginCommandDefinition>();
  const sends: Array<{ to: string; accountId?: string | null; text: string }> = [];
  const diagnostics: string[] = [];
  const api = {
    logger: {
      warn(message: string) {
        diagnostics.push(message);
      },
    },
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
  registerAccessCommands(api, config, () => ({ config, service, limiter }), runtimeStatus);

  const requestCommand = commands.get("request_access");
  const accessCommand = commands.get("access");
  assert.ok(requestCommand);
  assert.ok(accessCommand);
  assert.equal(requestCommand.requireAuth, false);
  assert.equal(accessCommand.requireAuth, false);

  const publicSenderId = "222222222";
  const requested = await requestCommand.handler(commandContext(publicSenderId));
  assert.equal(text(requested), "Access request submitted. Business Admins were notified.");
  assert.deepEqual(sends.map((send) => send.to), config.telegram.adminSenderIds);
  assert.equal(sends.every((send) => send.accountId === "default"), true);
  assert.equal(sends.every((send) => !/summary|problem|jira candidate/i.test(send.text)), true);
  const actionRef = /Action reference: ([A-Za-z0-9_-]{20,64})/.exec(sends[0]?.text ?? "")?.[1];
  assert.ok(actionRef);

  const repeated = await requestCommand.handler(commandContext(publicSenderId));
  assert.match(text(repeated), /^Current access status:\nAccess state: PENDING/m);
  assert.equal(sends.length, config.telegram.adminSenderIds.length);

  assert.equal(
    text(await accessCommand.handler(commandContext("333333333", "status"))),
    "Чтобы запросить доступ, отправьте команду /request_access.",
  );
  const forged = await accessCommand.handler(commandContext(
    "333333333",
    `approve ${actionRef} 1 123456789`,
  ));
  assert.equal(text(forged), "Чтобы запросить доступ, отправьте команду /request_access.");
  assert.equal(service.getStatus({
    agentId: "idea-mvp",
    channelId: "telegram",
    accountId: "default",
    senderId: publicSenderId,
    chatId: publicSenderId,
  }).userState, "PENDING");

  const substitutedDestination = await accessCommand.handler(commandContext(
    "123456789",
    `approve ${actionRef} 1`,
    { to: "telegram:222222222" },
  ));
  assert.equal(text(substitutedDestination), "This request is unavailable.");
  assert.deepEqual(diagnostics, [
    "idea-to-jira access command=access action=requester_validation code=DESTINATION_DENIED",
  ]);

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
  assert.deepEqual(diagnostics, [
    "idea-to-jira access command=access action=requester_validation code=DESTINATION_DENIED",
    "idea-to-jira access command=access action=safe_failure code=ACCESS_REQUEST_STALE",
  ]);
  for (const sensitiveValue of ["333333333", "123456789", "222222222", actionRef]) {
    assert.equal(diagnostics.some((entry) => entry.includes(sensitiveValue)), false);
  }
  assert.match(
    text(await requestCommand.handler(commandContext(publicSenderId))),
    /^Current access status:\nAccess state: CREATOR/m,
  );
  storage.close();
});

test("command diagnostics distinguish requester rejection from storage readiness without sensitive input", async () => {
  const config = effectiveConfig();
  const commands = new Map<string, OpenClawPluginCommandDefinition>();
  const diagnostics: string[] = [];
  const api = {
    logger: {
      warn(message: string) {
        diagnostics.push(message);
      },
    },
    registerCommand(command: OpenClawPluginCommandDefinition) {
      commands.set(command.name, command);
    },
  } as unknown as OpenClawPluginApi;
  let service: AccessService | undefined;
  const limiter = new TokenBucketRateLimiter(config.limits);
  registerAccessCommands(
    api,
    config,
    () => service ? { config, service, limiter } : undefined,
    () => runtimeStatus({
      generation: 2,
      latestGeneration: 2,
      instanceId: "22222222-2222-4222-8222-222222222222",
      phase: "STARTING",
    }),
  );

  const requestCommand = commands.get("request_access");
  const accessCommand = commands.get("access");
  assert.ok(requestCommand);
  assert.ok(accessCommand);

  const suppliedSenderId = "telegram:987654321";
  const suppliedReference = "PRIVATE_REFERENCE_123456789";
  const suppliedToken = "private-token-and-reason";
  const suppliedArgs = `approve ${suppliedReference} 7 ${suppliedToken}`;
  const suppliedCommandText = `/access ${suppliedArgs}`;
  const suppliedConfigSecret = "private-config-secret";
  const secretConfig = {
    config: { suppliedConfigSecret } as unknown as PluginCommandContext["config"],
    commandBody: suppliedCommandText,
  };

  assert.equal(text(await requestCommand.handler(commandContext(suppliedSenderId, "", secretConfig))), "This request is unavailable.");
  assert.equal(text(await requestCommand.handler(commandContext("123456789", "", secretConfig))), "This request is unavailable.");
  assert.equal(text(await accessCommand.handler(commandContext(suppliedSenderId, suppliedArgs, secretConfig))), "This request is unavailable.");
  assert.equal(text(await accessCommand.handler(commandContext("123456789", suppliedArgs, secretConfig))), "This request is unavailable.");

  const privateFailureDetail = "private-database-error-detail";
  service = {
    requestAccess() {
      throw new SafeError("ACCESS_REQUEST_CONFLICT", false, {
        cause: new Error(privateFailureDetail),
      });
    },
    ensureUser() {
      throw new Error(privateFailureDetail);
    },
  } as unknown as AccessService;
  assert.equal(
    text(await requestCommand.handler(commandContext("123456789", "", secretConfig))),
    "The access request is not available in the current state.",
  );
  assert.equal(
    text(await accessCommand.handler(commandContext("123456789", "status", secretConfig))),
    "This request is unavailable.",
  );

  assert.deepEqual(diagnostics, [
    "idea-to-jira access command=request_access action=requester_validation code=SENDER_MISSING",
    "idea-to-jira access command=request_access action=safe_failure code=STORAGE_NOT_READY runtime_phase=STARTING runtime_generation=2 latest_generation=2 runtime_instance=present",
    "idea-to-jira access command=access action=requester_validation code=SENDER_MISSING",
    "idea-to-jira access command=access action=safe_failure code=STORAGE_NOT_READY runtime_phase=STARTING runtime_generation=2 latest_generation=2 runtime_instance=present",
    "idea-to-jira access command=request_access action=safe_failure code=ACCESS_REQUEST_CONFLICT",
    "idea-to-jira access command=access action=safe_failure code=INTERNAL_ERROR",
  ]);
  assert.equal(diagnostics.every((entry) =>
    /^idea-to-jira access command=(?:access|request_access) action=(?:requester_validation|safe_failure) code=(?:SENDER_MISSING|ACCESS_REQUEST_CONFLICT|INTERNAL_ERROR)$/.test(entry) ||
    /^idea-to-jira access command=(?:access|request_access) action=safe_failure code=STORAGE_NOT_READY runtime_phase=STARTING runtime_generation=2 latest_generation=2 runtime_instance=present$/.test(entry)), true);
  for (const sensitiveValue of [
    suppliedSenderId,
    "123456789",
    suppliedReference,
    suppliedToken,
    suppliedArgs,
    suppliedCommandText,
    suppliedConfigSecret,
    privateFailureDetail,
  ]) {
    assert.equal(diagnostics.some((entry) => entry.includes(sensitiveValue)), false);
  }
});

test("public request command is rate-limited before access storage", async () => {
  const config = effectiveConfig();
  const commands = new Map<string, OpenClawPluginCommandDefinition>();
  const diagnostics: string[] = [];
  let storageCalled = false;
  const api = {
    logger: { warn(message: string) { diagnostics.push(message); } },
    registerCommand(command: OpenClawPluginCommandDefinition) {
      commands.set(command.name, command);
    },
  } as unknown as OpenClawPluginApi;
  const service = {
    requestAccess() {
      storageCalled = true;
      throw new Error("must not reach storage");
    },
  } as unknown as AccessService;
  registerAccessCommands(
    api,
    config,
    () => ({
      config,
      service,
      limiter: {
        consume(requester, operation) {
          assert.equal(requester.senderId, "222222222");
          assert.equal(operation, "access_request");
          return { allowed: false, retryAfterMs: 1_000 };
        },
      },
    }),
    runtimeStatus,
  );

  const requestCommand = commands.get("request_access");
  assert.ok(requestCommand);
  assert.equal(
    text(await requestCommand.handler(commandContext("222222222"))),
    "Слишком много запросов. Повторите команду /request_access позже.",
  );
  assert.equal(storageCalled, false);
  assert.deepEqual(diagnostics, [
    "idea-to-jira access command=request_access action=safe_failure code=RATE_LIMITED",
  ]);
});
