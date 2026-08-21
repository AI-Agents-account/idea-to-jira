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
import { catalogSha256, catalogText, validEnvironment, validRawConfig } from "./config-fixture.js";

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
  setRuntimeEnvironment(t);
  const { rawConfig } = configuredFixture();
  const info: string[] = [];
  const errors: string[] = [];
  let service: OpenClawPluginService | undefined;
  let beforeAgentRun: ((event: PluginHookBeforeAgentRunEvent, context: PluginHookAgentContext) => PluginHookBeforeAgentRunResult) | undefined;
  let toolFactory: ((context: OpenClawPluginToolContext) => {
    execute(toolCallId: string, input: unknown): Promise<unknown>;
  } | null) | undefined;

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
    runtime: { channel: { outbound: { loadAdapter: async () => undefined } } },
  } as unknown as OpenClawPluginApi;

  plugin.register(api);
  assert.ok(service);
  assert.ok(beforeAgentRun);
  assert.ok(toolFactory);

  const event = {
    prompt: "untrusted",
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

  const beforeStart = beforeAgentRun(event, context);
  assert.ok(beforeStart);
  assert.equal(beforeStart.outcome, "block");
  if (beforeStart.outcome !== "block") throw new Error("expected storage gate to block");
  assert.equal(beforeStart.reason, "STORAGE_NOT_READY");
  await service.start({} as never);
  const afterStart = beforeAgentRun(event, context);
  assert.ok(afterStart);
  assert.equal(afterStart.outcome, "pass");
  assert.equal(info.map((message) => JSON.parse(message) as { eventType?: string })
    .filter((event) => event.eventType === "STORAGE_READY").length, 1);
  assert.deepEqual(errors, []);
  const tool = toolFactory({
    agentId: "idea-mvp",
    messageChannel: "telegram",
    agentAccountId: "idea-mvp",
    requesterSenderId: "123456789",
    deliveryContext: { channel: "telegram", accountId: "idea-mvp", to: "123456789" },
  } as OpenClawPluginToolContext);
  assert.ok(tool);

  await service.stop?.({} as never);
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
