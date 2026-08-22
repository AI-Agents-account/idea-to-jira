import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type {
  PluginHookBeforeAgentRunResult,
  PluginHookBeforeDispatchResult,
} from "openclaw/plugin-sdk/types";

import plugin from "../src/index.js";

test("invalid tool-discovery config registers no lifecycle surfaces", () => {
  const errors: string[] = [];
  const api = {
    registrationMode: "tool-discovery",
    pluginConfig: {},
    logger: {
      error(message: string) { errors.push(message); },
    },
    on() { assert.fail("tool discovery must not register hooks"); },
    registerTool() { assert.fail("invalid discovery config must not register tools"); },
    registerService() { assert.fail("tool discovery must not register services"); },
    registerCommand() { assert.fail("tool discovery must not register commands"); },
    registerGatewayMethod() { assert.fail("tool discovery must not register gateway methods"); },
  } as unknown as OpenClawPluginApi;

  plugin.register(api);
  assert.deepEqual(errors, ["idea-to-jira tool discovery disabled code=CONFIG_INVALID"]);
});

test("invalid startup config installs a fail-closed diagnostic gate and no tool", () => {
  const errors: string[] = [];
  const agentHooks: Array<() => PluginHookBeforeAgentRunResult> = [];
  const dispatchHooks: Array<(
    event: { channel: string; sessionKey?: string },
    context: { sessionKey?: string },
  ) => PluginHookBeforeDispatchResult> = [];
  let registeredTools = 0;
  const api = {
    pluginConfig: {},
    logger: {
      error(message: string) {
        errors.push(message);
      },
    },
    on(name: string, handler: unknown) {
      if (name === "before_agent_run") {
        agentHooks.push(handler as () => PluginHookBeforeAgentRunResult);
      } else if (name === "before_dispatch") {
        dispatchHooks.push(handler as (
          event: { channel: string; sessionKey?: string },
          context: { sessionKey?: string },
        ) => PluginHookBeforeDispatchResult);
      } else {
        assert.fail(`unexpected hook: ${name}`);
      }
    },
    registerTool() {
      registeredTools += 1;
    },
  } as unknown as OpenClawPluginApi;

  plugin.register(api);

  assert.equal(registeredTools, 0);
  assert.deepEqual(errors, ["idea-to-jira startup disabled code=CONFIG_INVALID"]);
  assert.equal(dispatchHooks.length, 1);
  assert.deepEqual(dispatchHooks[0]?.({
    channel: "telegram",
    sessionKey: "agent:idea-mvp:telegram:direct:123456789",
  }, {
    sessionKey: "agent:idea-mvp:telegram:direct:123456789",
  }), {
    handled: true,
    text: "Не удалось проверить доступ. Попробуйте позже.",
  });
  assert.deepEqual(dispatchHooks[0]?.({
    channel: "telegram",
    sessionKey: "agent:other:telegram:direct:123456789",
  }, {
    sessionKey: "agent:other:telegram:direct:123456789",
  }), { handled: false });
  assert.equal(agentHooks.length, 1);
  assert.deepEqual(agentHooks[0]?.(), {
    outcome: "block",
    reason: "CONFIG_INVALID",
    message: "This request is unavailable.",
    category: "access_policy",
  });
});
