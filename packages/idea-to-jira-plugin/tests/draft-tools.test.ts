import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { OpenClawPluginService, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentRunEvent,
  PluginHookBeforeAgentRunResult,
} from "openclaw/plugin-sdk/types";

import plugin from "../src/index.js";
import { SafeError } from "../src/errors/safe-error.js";
import { getServiceRuntime, resetServiceRuntimeForTest } from "../src/runtime/service-runtime.js";
import { DATABASE_FILENAME, openPluginDatabase } from "../src/storage/database.js";
import type { DraftServiceResult } from "../src/workflow/draft-service.js";
import { catalogSha256, catalogText, validEnvironment, validRawConfig } from "./config-fixture.js";

function configuredFixture(): Record<string, unknown> {
  const root = mkdtempSync(join(tmpdir(), "idea-to-jira-tools-"));
  const catalogPath = join(root, "catalog.md");
  writeFileSync(catalogPath, catalogText, { mode: 0o600 });
  const raw = validRawConfig();
  raw.catalog = { path: catalogPath, schemaVersion: 1, sha256: catalogSha256 };
  raw.stateDir = join(root, "state");
  return raw;
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
    deliveryContext: { channel: "telegram", accountId: "default", to: "123456789" },
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
    deliveryContext: { channel: "telegram", accountId: "default", to: "222222222" },
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
  const api = {
    registrationMode: "tool-discovery",
    pluginConfig: rawConfig,
    logger: { info() {}, warn() {}, error() {} },
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

  const trustedContext = {
    agentId: "idea-mvp",
    messageChannel: "telegram",
    agentAccountId: "default",
    requesterSenderId: "123456789",
    deliveryContext: { channel: "telegram", accountId: "default", to: "123456789" },
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
    deliveryContext: { channel: "telegram", accountId: "default", to: "222222222" },
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
    deliveryContext: { channel: "telegram", accountId: "default", to: "123456789" },
  } as OpenClawPluginToolContext;
  const changedRouteCreate = factories[0]?.(changedRouteContext) as { execute(id: string, input: unknown): Promise<unknown> };
  (changedRouteContext.deliveryContext as { to: string }).to = "987654321";
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
    deliveryContext: { channel: "telegram", accountId: "default", to: "987654321" },
  } as OpenClawPluginToolContext;
  assert.equal(
    factories[0]?.(mismatchedRouteContext),
    null,
    "schema discovery must reject a host-derived route mismatch without opening storage",
  );

  const wrongAgentContext = { ...trustedContext, agentId: "main" } as OpenClawPluginToolContext;
  assert.equal(
    factories[0]?.(wrongAgentContext),
    null,
    "schema discovery must not expose Draft tools to another agent",
  );
});
