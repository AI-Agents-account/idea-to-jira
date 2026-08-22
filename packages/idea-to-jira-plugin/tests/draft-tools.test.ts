import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { OpenClawPluginService, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentRunEvent,
  PluginHookBeforeAgentRunResult,
} from "openclaw/plugin-sdk/types";

import { loadEffectiveConfig } from "../src/config.js";
import plugin from "../src/index.js";
import { SafeError } from "../src/errors/safe-error.js";
import { TokenBucketRateLimiter } from "../src/runtime/policy.js";
import {
  beginServiceRuntime,
  createServiceRuntimeCandidate,
  createServiceRuntimeGeneration,
  getServiceRuntime,
  publishServiceRuntime,
  resetServiceRuntimeForTest,
  stopServiceRuntime,
} from "../src/runtime/service-runtime.js";
import { DATABASE_FILENAME, openPluginDatabase } from "../src/storage/database.js";
import { migrations } from "../src/storage/migrations/index.js";
import { DraftVersionConflict, type DraftServiceResult } from "../src/workflow/draft-service.js";
import { catalogSha256, catalogText, validEnvironment, validRawConfig } from "./config-fixture.js";

type ToolFactory = (context: OpenClawPluginToolContext) => unknown;
type RegisteredTool = {
  readonly name: string;
  readonly parameters: unknown;
  execute(id: string, input: unknown): Promise<{ details: unknown }>;
};

function configuredFixture(): Record<string, unknown> {
  const root = mkdtempSync(join(tmpdir(), "idea-to-jira-tools-"));
  const catalogPath = join(root, "catalog.md");
  writeFileSync(catalogPath, catalogText, { mode: 0o600 });
  const raw = validRawConfig();
  raw.catalog = { path: catalogPath, schemaVersion: 1, sha256: catalogSha256 };
  raw.stateDir = join(root, "state");
  return raw;
}

function installValidEnvironment(t: { after(callback: () => void): void }): void {
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

function registerDiscovery(rawConfig: Record<string, unknown>, logs: string[] = []): ToolFactory[] {
  const factories: ToolFactory[] = [];
  const api = {
    registrationMode: "tool-discovery",
    pluginConfig: rawConfig,
    logger: {
      info(value: unknown) { logs.push(String(value)); },
      warn(value: unknown) { logs.push(String(value)); },
      error(value: unknown) { logs.push(String(value)); },
    },
    registerTool(factory: ToolFactory) { factories.push(factory); },
    registerService() { assert.fail("tool discovery must not register a background service"); },
    registerCommand() { assert.fail("tool discovery must not register commands"); },
    registerGatewayMethod() { assert.fail("tool discovery must not register gateway methods"); },
    on() { assert.fail("tool discovery must not register lifecycle hooks"); },
  } as unknown as OpenClawPluginApi;
  plugin.register(api);
  return factories;
}

function trustedToolContext(senderId = "123456789"): OpenClawPluginToolContext {
  return {
    agentId: "idea-mvp",
    messageChannel: "telegram",
    agentAccountId: "default",
    requesterSenderId: senderId,
    deliveryContext: { channel: "telegram", accountId: "default", to: `telegram:${senderId}` },
  } as OpenClawPluginToolContext;
}

function toolsFor(factories: readonly ToolFactory[], context: OpenClawPluginToolContext): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  for (const factory of factories) {
    const tool = factory(context) as RegisteredTool | null;
    if (tool) tools.set(tool.name, tool);
  }
  return tools;
}

test("registered typed tools perform own-Draft create/read/CAS patch/cancel end to end", async (t) => {
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

  let service: OpenClawPluginService | undefined;
  let beforeAgentRun: ((event: PluginHookBeforeAgentRunEvent, context: PluginHookAgentContext) => PluginHookBeforeAgentRunResult) | undefined;
  const factories: Array<(context: OpenClawPluginToolContext) => unknown> = [];
  const api = {
    pluginConfig: configuredFixture(),
    logger: { info() {}, error() {} },
    registerService(value: OpenClawPluginService) { service = value; },
    on(name: string, handler: typeof beforeAgentRun) {
      if (name === "before_agent_run") beforeAgentRun = handler;
    },
    registerTool(factory: (context: OpenClawPluginToolContext) => unknown) { factories.push(factory); },
    registerCommand() {},
    registerGatewayMethod() {},
    runtime: { channel: { outbound: { loadAdapter: async () => undefined } } },
  } as unknown as OpenClawPluginApi;

  plugin.register(api);
  assert.ok(service);
  assert.ok(beforeAgentRun);
  assert.equal(factories.length, 10);
  await service.start({} as never);

  const event = {
    prompt: "untrusted",
    messages: [],
    accountId: "default",
    channelId: "telegram",
    senderId: "123456789",
  } satisfies PluginHookBeforeAgentRunEvent;
  const hookContext = {
    agentId: "idea-mvp",
    trigger: "user",
    messageProvider: "telegram",
    chatId: "123456789",
  } satisfies PluginHookAgentContext;
  assert.equal(beforeAgentRun(event, hookContext)?.outcome, "pass");

  const toolContext = {
    agentId: "idea-mvp",
    messageChannel: "telegram",
    agentAccountId: "default",
    requesterSenderId: "123456789",
    deliveryContext: { channel: "telegram", accountId: "default", to: "telegram:123456789" },
  } as OpenClawPluginToolContext;
  const tools = new Map<string, { execute(id: string, input: unknown): Promise<{ details: unknown }> }>();
  for (const factory of factories) {
    const tool = factory(toolContext) as { name: string; execute(id: string, input: unknown): Promise<{ details: unknown }> } | null;
    if (tool) tools.set(tool.name, tool);
  }
  assert.deepEqual([...tools.keys()], [
    "idea_to_jira_create_draft",
    "idea_to_jira_read_draft",
    "idea_to_jira_patch_draft",
    "idea_to_jira_cancel_draft",
    "idea_to_jira_request_access",
  ]);
  assert.equal(tools.has("jira_create"), false);

  const guestToolContext = {
    ...toolContext,
    requesterSenderId: "222222222",
    deliveryContext: { channel: "telegram", accountId: "default", to: "telegram:222222222" },
  } as OpenClawPluginToolContext;
  assert.equal(factories.every((factory) => factory(guestToolContext) === null), true);

  const created = (await tools.get("idea_to_jira_create_draft")?.execute("create", {
    summary: "Сократить онбординг",
    context: "Пользователь не находит импорт.",
    goalProblemOpportunity: "Сделать импорт заметным.",
  }))?.details as DraftServiceResult;
  assert.equal(created.draft.version, 1);
  assert.equal(created.draft.readiness.ready, false);

  const read = (await tools.get("idea_to_jira_read_draft")?.execute("read", {
    draftId: created.draft.id,
  }))?.details as DraftServiceResult;
  assert.equal(read.draft.id, created.draft.id);

  const patched = (await tools.get("idea_to_jira_patch_draft")?.execute("patch", {
    draftId: created.draft.id,
    expectedVersion: 1,
    updates: {
      targetAudience: { value: "Новые клиенты", source: "USER_STATED" },
    },
  }))?.details as DraftServiceResult;
  assert.equal(patched.draft.version, 2);

  const cancelled = (await tools.get("idea_to_jira_cancel_draft")?.execute("cancel", {
    draftId: created.draft.id,
    expectedVersion: 2,
  }))?.details as DraftServiceResult;
  assert.equal(cancelled.draft.state, "CANCELLED");
  assert.equal(cancelled.draft.version, 3);

  await service.stop?.({} as never);
});

test("tool-discovery registers callable schemas and lazily persists create/read while denying untrusted callers", async (t) => {
  resetServiceRuntimeForTest();
  t.after(resetServiceRuntimeForTest);
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

  const rawConfig = configuredFixture();
  rawConfig.limits = { inputTextChars: 20_000, requestsPerMinute: 2, burst: 2, activeDrafts: 3 };
  const stateDir = rawConfig.stateDir as string;
  const gatewayStorage = openPluginDatabase({ stateDir });
  gatewayStorage.close();
  const databasePath = join(stateDir, DATABASE_FILENAME);
  const registrationMtime = statSync(databasePath).mtimeMs;
  const factories: Array<(context: OpenClawPluginToolContext) => unknown> = [];
  const logs: string[] = [];
  const api = {
    registrationMode: "tool-discovery",
    pluginConfig: rawConfig,
    logger: {
      info(value: unknown) { logs.push(String(value)); },
      warn(value: unknown) { logs.push(String(value)); },
      error(value: unknown) { logs.push(String(value)); },
    },
    registerTool(factory: (context: OpenClawPluginToolContext) => unknown) { factories.push(factory); },
    registerService() { assert.fail("tool discovery must not register a background service"); },
    registerCommand() { assert.fail("tool discovery must not register commands"); },
    registerGatewayMethod() { assert.fail("tool discovery must not register gateway methods"); },
    on() { assert.fail("tool discovery must not register lifecycle hooks"); },
  } as unknown as OpenClawPluginApi;

  plugin.register(api);
  assert.equal(factories.length, 10);
  assert.equal(existsSync(databasePath), true);
  assert.equal(statSync(databasePath).mtimeMs, registrationMtime, "registration must not open storage or run migrations");
  assert.equal(getServiceRuntime(), undefined);

  // This is the sparse context shape used by OpenClaw 2026.7's catalog/tool
  // discovery path. It deliberately has no sender or delivery identity.
  const catalogContext = {
    config: {},
    workspaceDir: "/workspace",
    agentDir: "/agent",
    agentId: "idea-mvp",
  } as OpenClawPluginToolContext;
  type CatalogTool = { name: string; execute(id: string, input: unknown): Promise<unknown> };
  const catalogTools = factories
    .map((factory) => factory(catalogContext) as CatalogTool | null)
    .filter((tool): tool is CatalogTool => tool !== null);
  assert.deepEqual(catalogTools.map((tool) => tool.name), [
    "idea_to_jira_create_draft",
    "idea_to_jira_read_draft",
    "idea_to_jira_patch_draft",
    "idea_to_jira_cancel_draft",
  ]);
  await assert.rejects(
    () => catalogTools[0]!.execute("catalog-no-identity", {
      summary: "Denied",
      context: "Denied",
      goalProblemOpportunity: "Denied",
    }),
    (error) => error instanceof SafeError && error.code === "ACCESS_DENIED",
  );
  assert.equal(statSync(databasePath).mtimeMs, registrationMtime, "missing identity must not open SQLite");

  const trustedContext = {
    agentId: "idea-mvp",
    messageChannel: "telegram",
    agentAccountId: "default",
    requesterSenderId: "123456789",
    deliveryContext: { channel: "telegram", accountId: "default", to: "telegram:123456789" },
  } as OpenClawPluginToolContext;
  const tools = new Map<string, { execute(id: string, input: unknown): Promise<{ details: unknown }> }>();
  for (const factory of factories) {
    const tool = factory(trustedContext) as { name: string; execute(id: string, input: unknown): Promise<{ details: unknown }> } | null;
    if (tool) tools.set(tool.name, tool);
  }
  assert.deepEqual([...tools.keys()], [
    "idea_to_jira_create_draft",
    "idea_to_jira_read_draft",
    "idea_to_jira_patch_draft",
    "idea_to_jira_cancel_draft",
  ]);

  const created = (await tools.get("idea_to_jira_create_draft")?.execute("discovery-create", {
    summary: "Сократить онбординг",
    context: "Пользователь не находит импорт.",
    goalProblemOpportunity: "Сделать импорт заметным.",
  }))?.details as DraftServiceResult;
  assert.equal(created.draft.version, 1);
  assert.equal(getServiceRuntime(), undefined, "execution-only runtime must not publish into service lifecycle state");

  const read = (await tools.get("idea_to_jira_read_draft")?.execute("discovery-read", {
    draftId: created.draft.id,
  }))?.details as DraftServiceResult;
  assert.equal(read.draft.id, created.draft.id, "a later execution must observe persisted storage");
  assert.equal(getServiceRuntime(), undefined);

  await assert.rejects(
    () => tools.get("idea_to_jira_read_draft")!.execute("discovery-rate-limit", { draftId: created.draft.id }),
    (error) => error instanceof SafeError && error.code === "RATE_LIMITED",
    "closing a runtime between calls must not reset the registration-scoped limiter",
  );

  const guestContext = {
    ...trustedContext,
    requesterSenderId: "222222222",
    deliveryContext: { channel: "telegram", accountId: "default", to: "telegram:222222222" },
  } as OpenClawPluginToolContext;
  const guestCreate = factories[0]?.(guestContext) as { execute(id: string, input: unknown): Promise<unknown> };
  assert.ok(guestCreate, "RBAC must not remove schemas during discovery");
  await assert.rejects(
    () => guestCreate.execute("discovery-guest", {
      summary: "Denied",
      context: "Denied",
      goalProblemOpportunity: "Denied",
    }),
    (error) => error instanceof SafeError && error.code === "ACCESS_DENIED",
  );

  const changedRouteContext = {
    ...trustedContext,
    deliveryContext: { channel: "telegram", accountId: "default", to: "telegram:123456789" },
  } as OpenClawPluginToolContext;
  const changedRouteCreate = factories[0]?.(changedRouteContext) as { execute(id: string, input: unknown): Promise<unknown> };
  (changedRouteContext.deliveryContext as { to: string }).to = "telegram:987654321";
  await assert.rejects(
    () => changedRouteCreate.execute("discovery-revalidate-route", {
      summary: "Denied",
      context: "Denied",
      goalProblemOpportunity: "Denied",
    }),
    (error) => error instanceof SafeError && error.code === "ACCESS_DENIED",
    "execution must revalidate the captured host context",
  );

  const mismatchedRouteContext = {
    ...trustedContext,
    deliveryContext: { channel: "telegram", accountId: "default", to: "telegram:987654321" },
  } as OpenClawPluginToolContext;
  assert.equal(
    factories[0]?.(mismatchedRouteContext),
    null,
    "schema discovery must reject an explicit host route mismatch without opening storage",
  );

  const wrongAgentContext = { ...trustedContext, agentId: "main" } as OpenClawPluginToolContext;
  assert.equal(
    factories[0]?.(wrongAgentContext),
    null,
    "schema discovery must not expose Draft tools to another agent",
  );

  const contradictoryDeliveryChannel = {
    ...trustedContext,
    deliveryContext: { channel: "signal", accountId: "default", to: "telegram:123456789" },
  } as OpenClawPluginToolContext;
  assert.equal(
    factories[0]?.(contradictoryDeliveryChannel),
    null,
    "an allowed top-level channel must not mask a contradictory delivery channel",
  );

  const contradictoryDeliveryAccount = {
    ...trustedContext,
    deliveryContext: { channel: "telegram", accountId: "other", to: "telegram:123456789" },
  } as OpenClawPluginToolContext;
  assert.equal(
    factories[0]?.(contradictoryDeliveryAccount),
    null,
    "an allowed top-level account must not mask a contradictory delivery account",
  );

  const roleSenders = {
    GUEST: "222222223",
    PENDING: "222222224",
    SUSPENDED: "222222225",
    BLOCKED: "987654321",
  } as const;
  const deniedPayload = {
    summary: "Denied",
    context: "Denied",
    goalProblemOpportunity: "Denied",
  };
  for (const [state, senderId] of Object.entries(roleSenders)) {
    const context = {
      ...trustedContext,
      requesterSenderId: senderId,
      deliveryContext: { channel: "telegram", accountId: "default", to: `telegram:${senderId}` },
    } as OpenClawPluginToolContext;
    const create = factories[0]?.(context) as { execute(id: string, input: unknown): Promise<unknown> };
    if (state === "BLOCKED") {
      await create.execute("seed-BLOCKED-admin", deniedPayload);
    } else if (state !== "GUEST") {
      await assert.rejects(
        () => create.execute(`seed-${state}`, deniedPayload),
        (error) => error instanceof SafeError && error.code === "ACCESS_DENIED",
      );
    }
    if (state !== "GUEST") {
      const storage = openPluginDatabase({ stateDir });
      storage.repositories.criticalTransaction(({ sql }) => {
        sql.prepare("UPDATE users SET state = ?, record_version = record_version + 1 WHERE telegram_sender_id = ?")
          .run(state, senderId);
      });
      storage.close();
    }
    await assert.rejects(
      () => create.execute(`deny-${state}`, deniedPayload),
      (error) => error instanceof SafeError && error.code === "ACCESS_DENIED",
    );
  }

  const auditStorage = openPluginDatabase({ stateDir });
  const denialCodes = auditStorage.repositories.transaction(({ sql }) =>
    (sql.prepare(`
      SELECT code FROM audit_log
      WHERE operation = 'SECURITY_DECISION' AND outcome = 'REJECTED'
    `).all() as unknown as Array<{ code: string }>).map((row) => row.code));
  auditStorage.close();
  for (const state of Object.keys(roleSenders)) {
    assert.ok(denialCodes.includes(`CONVERSATION_ROLE_${state}`), `${state} denial must be audited`);
  }

  const privateIdentifiers = ["123456789", "222222222", ...Object.values(roleSenders)];
  assert.equal(logs.some((line) => privateIdentifiers.some((identifier) => line.includes(identifier))), false,
    "bounded diagnostics must not disclose sender or route identifiers");
});

test("tool-discovery rejects missing identity and shared-limit abuse before absent SQLite", async (t) => {
  resetServiceRuntimeForTest();
  t.after(resetServiceRuntimeForTest);
  installValidEnvironment(t);

  const rawConfig = configuredFixture();
  rawConfig.limits = { inputTextChars: 20_000, requestsPerMinute: 1, burst: 1, activeDrafts: 3 };
  const stateDir = rawConfig.stateDir as string;
  const logs: string[] = [];
  const factories = registerDiscovery(rawConfig, logs);
  assert.equal(existsSync(stateDir), false, "registration must not create the state directory");

  const catalogTools = toolsFor(factories, {
    config: {},
    workspaceDir: "/workspace",
    agentDir: "/agent",
    agentId: "idea-mvp",
  } as OpenClawPluginToolContext);
  assert.deepEqual([...catalogTools.keys()], [
    "idea_to_jira_create_draft",
    "idea_to_jira_read_draft",
    "idea_to_jira_patch_draft",
    "idea_to_jira_cancel_draft",
  ]);
  await assert.rejects(
    () => catalogTools.get("idea_to_jira_create_draft")!.execute("missing-identity", {
      summary: "Denied",
      context: "Denied",
      goalProblemOpportunity: "Denied",
    }),
    (error) => error instanceof SafeError && error.code === "ACCESS_DENIED",
  );
  assert.equal(existsSync(stateDir), false);

  const trustedTools = toolsFor(factories, trustedToolContext());
  await assert.rejects(
    () => trustedTools.get("idea_to_jira_create_draft")!.execute("absent-schema", {
      summary: "No storage",
      context: "No storage",
      goalProblemOpportunity: "No storage",
    }),
    (error) => error instanceof SafeError && error.code === "STORAGE_NOT_READY",
  );
  assert.equal(existsSync(stateDir), false, "verify-current must not create missing SQLite");
  await assert.rejects(
    () => trustedTools.get("idea_to_jira_read_draft")!.execute("shared-rate-limit", { draftId: "draft-x" }),
    (error) => error instanceof SafeError && error.code === "RATE_LIMITED",
  );
  assert.equal(existsSync(stateDir), false, "rate abuse must be rejected before SQLite");
  assert.equal(logs.some((line) => line.includes("123456789")), false);
});

test("tool-discovery execution requires an existing exact schema and never migrates an older one", async (t) => {
  resetServiceRuntimeForTest();
  t.after(resetServiceRuntimeForTest);
  installValidEnvironment(t);

  const rawConfig = configuredFixture();
  const stateDir = rawConfig.stateDir as string;
  const oldStorage = openPluginDatabase({ stateDir, migrationRegistry: migrations.slice(0, 1) });
  oldStorage.close();
  const databasePath = join(stateDir, DATABASE_FILENAME);
  const before = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal((before.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
  before.close();

  const tools = toolsFor(registerDiscovery(rawConfig), trustedToolContext());
  await assert.rejects(
    () => tools.get("idea_to_jira_create_draft")!.execute("old-schema", {
      summary: "No migration",
      context: "No migration",
      goalProblemOpportunity: "No migration",
    }),
    (error) => error instanceof SafeError && error.code === "STORAGE_NOT_READY",
  );
  const after = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal((after.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1,
    "tool execution must not migrate Gateway-owned storage");
  after.close();
});

test("tool-discovery execution enforces a borrowed READY runtime's tighter live limits exactly once", async (t) => {
  resetServiceRuntimeForTest();
  installValidEnvironment(t);

  const discoveryConfig = configuredFixture();
  discoveryConfig.limits = { inputTextChars: 20_000, requestsPerMinute: 100, burst: 100, activeDrafts: 3 };
  const liveRawConfig = structuredClone(discoveryConfig);
  liveRawConfig.limits = { inputTextChars: 200, requestsPerMinute: 2, burst: 2, activeDrafts: 3 };
  const loaded = loadEffectiveConfig(liveRawConfig);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;

  let liveConsumeCalls = 0;
  class CountingLiveLimiter extends TokenBucketRateLimiter {
    override consume(
      ...args: Parameters<TokenBucketRateLimiter["consume"]>
    ): ReturnType<TokenBucketRateLimiter["consume"]> {
      liveConsumeCalls += 1;
      return super.consume(...args);
    }
  }
  const liveLimiter = new CountingLiveLimiter(loaded.config.limits);
  const runtime = createServiceRuntimeCandidate(loaded.config, undefined, { limiter: liveLimiter });
  const generation = createServiceRuntimeGeneration();
  assert.equal(beginServiceRuntime(generation), true);
  assert.equal(publishServiceRuntime(generation, runtime), true);
  t.after(() => {
    stopServiceRuntime(generation);
    runtime.jiraWorkflow?.stop();
    runtime.storage.close();
    resetServiceRuntimeForTest();
  });

  const create = toolsFor(registerDiscovery(discoveryConfig), trustedToolContext())
    .get("idea_to_jira_create_draft")!;
  await assert.rejects(
    () => create.execute("live-payload-limit", {
      summary: "Discovery would allow this",
      context: "x".repeat(250),
      goalProblemOpportunity: "The READY runtime must reject it.",
    }),
    (error) => error instanceof SafeError && error.code === "PAYLOAD_TOO_LARGE",
  );
  assert.equal(liveConsumeCalls, 0, "payload rejection must precede live token consumption");

  for (const suffix of ["one", "two"]) {
    await create.execute(`live-rate-${suffix}`, {
      summary: suffix,
      context: "short",
      goalProblemOpportunity: "short",
    });
  }
  assert.equal(liveConsumeCalls, 2, "each accepted execution must consume the live limiter once");
  await assert.rejects(
    () => create.execute("live-rate-three", {
      summary: "three",
      context: "short",
      goalProblemOpportunity: "short",
    }),
    (error) => error instanceof SafeError && error.code === "RATE_LIMITED",
  );
  assert.equal(liveConsumeCalls, 3, "a rejected live-limit attempt must perform one consume check");
});

test("tool-discovery borrowed runtime cannot bypass the registration-scoped limiter", async (t) => {
  resetServiceRuntimeForTest();
  installValidEnvironment(t);

  const discoveryConfig = configuredFixture();
  discoveryConfig.limits = { inputTextChars: 20_000, requestsPerMinute: 1, burst: 1, activeDrafts: 3 };
  const liveRawConfig = structuredClone(discoveryConfig);
  liveRawConfig.limits = { inputTextChars: 20_000, requestsPerMinute: 100, burst: 100, activeDrafts: 3 };
  const loaded = loadEffectiveConfig(liveRawConfig);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;

  let liveConsumeCalls = 0;
  class CountingLiveLimiter extends TokenBucketRateLimiter {
    override consume(
      ...args: Parameters<TokenBucketRateLimiter["consume"]>
    ): ReturnType<TokenBucketRateLimiter["consume"]> {
      liveConsumeCalls += 1;
      return super.consume(...args);
    }
  }
  const liveLimiter = new CountingLiveLimiter(loaded.config.limits);
  const runtime = createServiceRuntimeCandidate(loaded.config, undefined, { limiter: liveLimiter });
  const generation = createServiceRuntimeGeneration();
  assert.equal(beginServiceRuntime(generation), true);
  assert.equal(publishServiceRuntime(generation, runtime), true);
  t.after(() => {
    stopServiceRuntime(generation);
    runtime.jiraWorkflow?.stop();
    runtime.storage.close();
    resetServiceRuntimeForTest();
  });

  const create = toolsFor(registerDiscovery(discoveryConfig), trustedToolContext())
    .get("idea_to_jira_create_draft")!;
  await create.execute("registration-rate-one", {
    summary: "one",
    context: "short",
    goalProblemOpportunity: "short",
  });
  assert.equal(liveConsumeCalls, 1);
  await assert.rejects(
    () => create.execute("registration-rate-two", {
      summary: "two",
      context: "short",
      goalProblemOpportunity: "short",
    }),
    (error) => error instanceof SafeError && error.code === "RATE_LIMITED",
  );
  assert.equal(liveConsumeCalls, 1, "registration denial must happen before live limiter consumption");
});

test("Draft data and owner/CAS guarantees survive separate tool-discovery registrations", async (t) => {
  resetServiceRuntimeForTest();
  t.after(resetServiceRuntimeForTest);
  installValidEnvironment(t);

  const rawConfig = configuredFixture();
  rawConfig.limits = { inputTextChars: 20_000, requestsPerMinute: 100, burst: 20, activeDrafts: 3 };
  const stateDir = rawConfig.stateDir as string;
  const gatewayStorage = openPluginDatabase({ stateDir });
  gatewayStorage.close();

  const firstRegistration = toolsFor(registerDiscovery(rawConfig), trustedToolContext("123456789"));
  const created = (await firstRegistration.get("idea_to_jira_create_draft")!.execute("create", {
    summary: "Persist across registration",
    context: "The catalog and execution paths load separate plugin registrations.",
    goalProblemOpportunity: "Keep Draft storage durable.",
  })).details as DraftServiceResult;

  const secondRegistration = toolsFor(registerDiscovery(rawConfig), trustedToolContext("123456789"));
  const read = (await secondRegistration.get("idea_to_jira_read_draft")!.execute("read", {
    draftId: created.draft.id,
  })).details as DraftServiceResult;
  assert.equal(read.draft.id, created.draft.id);
  await assert.rejects(
    () => secondRegistration.get("idea_to_jira_patch_draft")!.execute("stale-cas", {
      draftId: created.draft.id,
      expectedVersion: 99,
      updates: { summary: { value: "stale", source: "USER_STATED" } },
    }),
    (error) => error instanceof DraftVersionConflict && error.currentVersion === 1,
  );

  const otherAdmin = toolsFor(registerDiscovery(rawConfig), trustedToolContext("987654321"));
  await assert.rejects(
    () => otherAdmin.get("idea_to_jira_read_draft")!.execute("cross-owner", { draftId: created.draft.id }),
    (error) => error instanceof SafeError && error.code === "DRAFT_NOT_FOUND",
  );
});
