import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type {
  OpenClawPluginService,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentRunEvent,
  PluginHookBeforeAgentRunResult,
} from "openclaw/plugin-sdk/types";

import plugin from "../src/index.js";
import { SafeError } from "../src/errors/safe-error.js";
import { CONVERSATION_ROLE_REPLIES } from "../src/runtime/conversation-role-gate.js";
import { getServiceRuntime, resetServiceRuntimeForTest } from "../src/runtime/service-runtime.js";
import { catalogSha256, catalogText, validEnvironment, validRawConfig } from "./config-fixture.js";

interface RuntimeStatusPayload {
  readonly schemaVersion: number;
  readonly generation: number;
  readonly latestGeneration: number;
  readonly instanceId: string | null;
  readonly phase: string;
  readonly code: string | null;
  readonly storageHealthy: boolean;
  readonly storageSchemaVersion: number | null;
  readonly buildFingerprint: string | null;
  readonly jiraReadiness: string;
  readonly jiraMetadataHash: string | null;
}

type RuntimeStatusHandler = (options: {
  readonly respond: (ok: boolean, payload: unknown) => void;
}) => void;

function invokeRuntimeStatus(handler: RuntimeStatusHandler | undefined): RuntimeStatusPayload {
  if (!handler) throw new Error("runtime status method was not registered");
  let response: RuntimeStatusPayload | undefined;
  handler({
    respond(ok, payload) {
      assert.equal(ok, true);
      response = payload as RuntimeStatusPayload;
    },
  });
  if (!response) throw new Error("runtime status method did not respond");
  return response;
}

function configuredFixture(): { rawConfig: Record<string, unknown>; stateDir: string } {
  const root = mkdtempSync(join(tmpdir(), "idea-to-jira-startup-"));
  const catalogPath = join(root, "catalog.md");
  const stateDir = join(root, "state");
  writeFileSync(catalogPath, catalogText, { mode: 0o600 });
  const rawConfig = validRawConfig();
  rawConfig.catalog = { path: catalogPath, schemaVersion: 1, sha256: catalogSha256 };
  rawConfig.stateDir = stateDir;
  return { rawConfig, stateDir };
}

function setRuntimeEnvironment(t: test.TestContext): void {
  const previous = new Map<string, string | undefined>();
  for (const key of ["JIRA_TOKEN", "JIRA_TOKEN_FILE"]) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(validEnvironment)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("storage service gates requests until schema health succeeds and closes cleanly", async (t) => {
  resetServiceRuntimeForTest();
  t.after(resetServiceRuntimeForTest);
  setRuntimeEnvironment(t);
  const { rawConfig } = configuredFixture();
  const info: string[] = [];
  const errors: string[] = [];
  let service: OpenClawPluginService | undefined;
  let beforeAgentRun: ((event: PluginHookBeforeAgentRunEvent, context: PluginHookAgentContext) => PluginHookBeforeAgentRunResult) | undefined;
  let toolFactory: ((context: OpenClawPluginToolContext) => {
    execute(toolCallId: string, input: unknown): Promise<unknown>;
  } | null) | undefined;
  let runtimeStatusHandler: RuntimeStatusHandler | undefined;

  const api = {
    pluginConfig: rawConfig,
    logger: {
      info(message: string) { info.push(message); },
      error(message: string) { errors.push(message); },
    },
    registerService(value: OpenClawPluginService) { service = value; },
    on(name: string, handler: typeof beforeAgentRun) {
      assert.equal(name, "before_agent_run");
      beforeAgentRun = handler;
    },
    registerTool(factory: typeof toolFactory) { toolFactory = factory; },
    registerCommand() {},
    registerGatewayMethod(method: string, handler: unknown, options?: { scope?: string }) {
      assert.equal(method, "idea-to-jira.runtime-status");
      assert.deepEqual(options, { scope: "operator.read" });
      runtimeStatusHandler = handler as RuntimeStatusHandler;
    },
    runtime: { channel: { outbound: { loadAdapter: async () => undefined } } },
  } as unknown as OpenClawPluginApi;

  plugin.register(api);
  assert.ok(service);
  assert.ok(beforeAgentRun);
  assert.ok(toolFactory);
  assert.deepEqual(invokeRuntimeStatus(runtimeStatusHandler), {
    schemaVersion: 1,
    generation: 1,
    latestGeneration: 1,
    instanceId: null,
    phase: "NOT_STARTED",
    code: "STORAGE_NOT_READY",
    storageHealthy: false,
    storageSchemaVersion: null,
    buildFingerprint: null,
    jiraReadiness: "JIRA_UNAVAILABLE",
    jiraMetadataHash: null,
  });

  const event = {
    prompt: "untrusted",
    messages: [],
    accountId: "default",
    channelId: "telegram",
    senderId: "123456789",
  } satisfies PluginHookBeforeAgentRunEvent;
  const context = {
    agentId: "idea-mvp",
    trigger: "user",
    sessionKey: "agent:idea-mvp:telegram:default:direct:123456789",
    messageProvider: "telegram",
    channel: "telegram",
    channelId: "123456789",
    chatId: "123456789",
    senderId: "123456789",
  } satisfies PluginHookAgentContext;

  const beforeStart = beforeAgentRun(event, context);
  assert.ok(beforeStart);
  assert.equal(beforeStart.outcome, "block");
  if (beforeStart.outcome !== "block") throw new Error("expected storage gate to block");
  assert.equal(beforeStart.reason, "STORAGE_NOT_READY");
  await service.start({} as never);
  const readyStatus = invokeRuntimeStatus(runtimeStatusHandler);
  assert.equal(readyStatus.schemaVersion, 1);
  assert.equal(readyStatus.generation > 0, true);
  assert.equal(readyStatus.latestGeneration, readyStatus.generation);
  assert.match(readyStatus.instanceId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(readyStatus.phase, "READY");
  assert.equal(readyStatus.code, null);
  assert.equal(readyStatus.storageHealthy, true);
  assert.equal(readyStatus.storageSchemaVersion, 5);
  const afterStart = beforeAgentRun(event, context);
  assert.ok(afterStart);
  assert.equal(afterStart.outcome, "pass");
  assert.match(
    info[0] ?? "",
    /^idea-to-jira runtime action=registered registration_generation=1 phase=NOT_STARTED generation=1 latest_generation=1 instance=absent$/,
  );
  assert.deepEqual(info.filter((message) => message.startsWith("{"))
    .map((message) => JSON.parse(message) as { eventType?: string })
    .map((event) => event.eventType)
    .filter((eventType) => eventType?.startsWith("STORAGE_")), [
      "STORAGE_STARTING",
      "STORAGE_READY",
    ]);
  assert.deepEqual(errors, []);
  const tool = toolFactory({
    agentId: "idea-mvp",
    messageChannel: "telegram",
    agentAccountId: "default",
    requesterSenderId: "123456789",
    deliveryContext: { channel: "telegram", accountId: "default", to: "123456789" },
  } as OpenClawPluginToolContext);
  assert.ok(tool);

  await service.stop?.({} as never);
  const stoppedStatus = invokeRuntimeStatus(runtimeStatusHandler);
  assert.equal(stoppedStatus.generation, readyStatus.generation);
  assert.equal(stoppedStatus.instanceId, readyStatus.instanceId);
  assert.equal(stoppedStatus.phase, "STOPPED");
  assert.equal(stoppedStatus.code, "STORAGE_NOT_READY");
  assert.equal(stoppedStatus.storageHealthy, false);
  assert.equal(stoppedStatus.storageSchemaVersion, null);
  await assert.rejects(
    () => tool.execute("tool-call-1", {
      summary: "Summary",
      problem: "Problem",
      desiredOutcome: "Outcome",
    }),
    (error) => error instanceof SafeError && error.code === "STORAGE_NOT_READY",
  );
  const afterStop = beforeAgentRun(event, context);
  assert.ok(afterStop);
  assert.equal(afterStop.outcome, "block");
  if (afterStop.outcome !== "block") throw new Error("expected storage gate to block");
  assert.equal(afterStop.reason, "STORAGE_NOT_READY");
});

test("before_agent_run is the sole role gate and BLOCKED overrides Business Admin before the model", async (t) => {
  resetServiceRuntimeForTest();
  t.after(resetServiceRuntimeForTest);
  setRuntimeEnvironment(t);
  const { rawConfig } = configuredFixture();
  let service: OpenClawPluginService | undefined;
  let beforeAgentRun: ((
    event: PluginHookBeforeAgentRunEvent,
    context: PluginHookAgentContext,
  ) => PluginHookBeforeAgentRunResult) | undefined;
  const hookNames: string[] = [];

  const api = {
    pluginConfig: rawConfig,
    logger: { info() {}, warn() {}, error() {} },
    registerService(value: OpenClawPluginService) { service = value; },
    on(name: string, handler: typeof beforeAgentRun) {
      hookNames.push(name);
      assert.equal(name, "before_agent_run");
      beforeAgentRun = handler;
    },
    registerTool() {},
    registerCommand() {},
    registerGatewayMethod() {},
    runtime: { channel: { outbound: { loadAdapter: async () => undefined } } },
  } as unknown as OpenClawPluginApi;

  plugin.register(api);
  assert.deepEqual(hookNames, ["before_agent_run"]);
  assert.ok(service);
  assert.ok(beforeAgentRun);
  const registeredService = service;
  const gate = beforeAgentRun;
  await registeredService.start({} as never);

  const event = {
    prompt: "untrusted Draft input",
    messages: [],
    accountId: "default",
    channelId: "telegram",
    senderId: "123456789",
  } satisfies PluginHookBeforeAgentRunEvent;
  const context = {
    agentId: "idea-mvp",
    trigger: "user",
    messageProvider: "telegram",
    chatId: "123456789",
  } satisfies PluginHookAgentContext;

  assert.deepEqual(gate(event, context), { outcome: "pass" });

  const runtime = getServiceRuntime();
  assert.ok(runtime);
  const requester = Object.freeze({
    agentId: "idea-mvp",
    channelId: "telegram",
    accountId: "default",
    senderId: "123456789",
    chatId: "123456789",
  } as const);
  const request = runtime.accessService.requestAccess(requester);
  assert.ok(request.adminCard);

  assert.deepEqual(gate(event, context), { outcome: "pass" });

  runtime.accessService.decideAccess(requester, {
    actionRef: request.adminCard.actionRef,
    expectedVersion: request.adminCard.version,
    decision: "BLOCK",
  });

  assert.deepEqual(gate(event, context), {
    outcome: "block",
    reason: "BLOCKED",
    message: CONVERSATION_ROLE_REPLIES.BLOCKED,
    category: "access_policy",
  });
  await registeredService.stop?.({} as never);
});

test("agent-runtime pre-warm registration does not displace the started Gateway service", async (t) => {
  resetServiceRuntimeForTest();
  t.after(resetServiceRuntimeForTest);
  setRuntimeEnvironment(t);
  const { rawConfig } = configuredFixture();

  function registerCopy(): {
    service: OpenClawPluginService;
    beforeAgentRun: (
      event: PluginHookBeforeAgentRunEvent,
      context: PluginHookAgentContext,
    ) => PluginHookBeforeAgentRunResult;
    runtimeStatusHandler: RuntimeStatusHandler;
    info: string[];
  } {
    let service: OpenClawPluginService | undefined;
    let beforeAgentRun: ((
      event: PluginHookBeforeAgentRunEvent,
      context: PluginHookAgentContext,
    ) => PluginHookBeforeAgentRunResult) | undefined;
    let runtimeStatusHandler: RuntimeStatusHandler | undefined;
    const info: string[] = [];
    const api = {
      pluginConfig: rawConfig,
      logger: {
        info(message: string) { info.push(message); },
        warn() {},
        error() {},
      },
      registerService(value: OpenClawPluginService) { service = value; },
      on(name: string, handler: typeof beforeAgentRun) {
        assert.equal(name, "before_agent_run");
        beforeAgentRun = handler;
      },
      registerTool() {},
      registerCommand() {},
      registerGatewayMethod(_method: string, handler: unknown) {
        runtimeStatusHandler = handler as RuntimeStatusHandler;
      },
      runtime: { channel: { outbound: { loadAdapter: async () => undefined } } },
    } as unknown as OpenClawPluginApi;
    plugin.register(api);
    assert.ok(service);
    assert.ok(beforeAgentRun);
    assert.ok(runtimeStatusHandler);
    return { service, beforeAgentRun, runtimeStatusHandler, info };
  }

  const gatewayCopy = registerCopy();

  // Primary-model pre-warm is scheduled before Gateway plugin services start,
  // so the agent-runtime copy may register a newer generation first.
  const agentRuntimeCopy = registerCopy();
  const beforeServiceStart = invokeRuntimeStatus(agentRuntimeCopy.runtimeStatusHandler);
  assert.equal(beforeServiceStart.phase, "NOT_STARTED");
  assert.equal(beforeServiceStart.generation, 2);
  assert.equal(beforeServiceStart.latestGeneration, 2);
  assert.match(
    agentRuntimeCopy.info[0] ?? "",
    /^idea-to-jira runtime action=registered registration_generation=2 phase=NOT_STARTED generation=2 latest_generation=2 instance=absent$/,
  );

  await gatewayCopy.service.start({} as never);
  const initial = invokeRuntimeStatus(gatewayCopy.runtimeStatusHandler);
  assert.equal(initial.phase, "READY");
  assert.equal(initial.generation, 1);
  assert.equal(initial.latestGeneration, 2);

  const afterEarlyPrewarm = invokeRuntimeStatus(agentRuntimeCopy.runtimeStatusHandler);
  assert.equal(afterEarlyPrewarm.phase, "READY");
  assert.equal(afterEarlyPrewarm.generation, 1);
  assert.equal(afterEarlyPrewarm.latestGeneration, 2);
  assert.equal(afterEarlyPrewarm.instanceId, initial.instanceId);
  assert.equal(afterEarlyPrewarm.storageHealthy, true);

  // A registration that arrives after startup is equally inert until its own
  // service start is called.
  const lateAgentRuntimeCopy = registerCopy();
  const afterLatePrewarm = invokeRuntimeStatus(lateAgentRuntimeCopy.runtimeStatusHandler);
  assert.equal(afterLatePrewarm.phase, "READY");
  assert.equal(afterLatePrewarm.generation, 1);
  assert.equal(afterLatePrewarm.latestGeneration, 3);
  assert.equal(afterLatePrewarm.instanceId, initial.instanceId);
  assert.equal(afterLatePrewarm.storageHealthy, true);
  assert.match(
    lateAgentRuntimeCopy.info[0] ?? "",
    /^idea-to-jira runtime action=registered registration_generation=3 phase=READY generation=1 latest_generation=3 instance=present$/,
  );

  const result = agentRuntimeCopy.beforeAgentRun({
    prompt: "untrusted",
    messages: [],
    accountId: "default",
    channelId: "telegram",
    senderId: "123456789",
  }, {
    agentId: "idea-mvp",
    trigger: "user",
    messageProvider: "telegram",
    chatId: "123456789",
  });
  assert.ok(result);
  assert.equal(result.outcome, "pass");

  await gatewayCopy.service.stop?.({} as never);
});

test("storage startup failure is visible, bounded, and leaves every entry point fail-closed", async (t) => {
  resetServiceRuntimeForTest();
  t.after(resetServiceRuntimeForTest);
  setRuntimeEnvironment(t);
  const { rawConfig, stateDir } = configuredFixture();
  writeFileSync(stateDir, "not-a-directory", { mode: 0o600 });
  const info: string[] = [];
  const errors: string[] = [];
  let service: OpenClawPluginService | undefined;
  let beforeAgentRun: ((
    event: PluginHookBeforeAgentRunEvent,
    context: PluginHookAgentContext,
  ) => PluginHookBeforeAgentRunResult) | undefined;
  let runtimeStatusHandler: RuntimeStatusHandler | undefined;

  const api = {
    pluginConfig: rawConfig,
    logger: {
      info(message: string) { info.push(message); },
      error(message: string) { errors.push(message); },
    },
    registerService(value: OpenClawPluginService) { service = value; },
    on(name: string, handler: typeof beforeAgentRun) {
      assert.equal(name, "before_agent_run");
      beforeAgentRun = handler;
    },
    registerTool() {},
    registerCommand() {},
    registerGatewayMethod(_method: string, handler: unknown) {
      runtimeStatusHandler = handler as RuntimeStatusHandler;
    },
    runtime: { channel: { outbound: { loadAdapter: async () => undefined } } },
  } as unknown as OpenClawPluginApi;

  plugin.register(api);
  assert.ok(service);
  assert.ok(beforeAgentRun);
  const registeredService = service;
  await assert.rejects(
    async () => registeredService.start({} as never),
    (error) => error instanceof SafeError && error.code === "STORAGE_STARTUP_FAILED",
  );
  const failedStatus = invokeRuntimeStatus(runtimeStatusHandler);
  assert.equal(failedStatus.phase, "FAILED");
  assert.equal(failedStatus.code, "STORAGE_STARTUP_FAILED");
  assert.equal(failedStatus.storageHealthy, false);
  assert.equal(failedStatus.storageSchemaVersion, null);

  const result = beforeAgentRun({
    prompt: "untrusted",
    messages: [],
    accountId: "default",
    channelId: "telegram",
    senderId: "123456789",
  }, {
    agentId: "idea-mvp",
    trigger: "user",
    messageProvider: "telegram",
    chatId: "123456789",
  });
  assert.ok(result);
  assert.equal(result.outcome, "block");
  if (result.outcome !== "block") throw new Error("expected startup failure gate to block");
  assert.equal(result.reason, "STORAGE_STARTUP_FAILED");
  assert.equal(errors.length, 1);
  assert.equal((JSON.parse(errors[0] ?? "{}") as { errorCode?: string }).errorCode, "STORAGE_STARTUP_FAILED");
  assert.equal([...info, ...errors].some((entry) => entry.includes(stateDir)), false);
});
