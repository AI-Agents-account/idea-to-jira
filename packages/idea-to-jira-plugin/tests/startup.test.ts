import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginHookBeforeAgentRunResult } from "openclaw/plugin-sdk/types";

import plugin from "../src/index.js";

test("invalid startup config installs a fail-closed diagnostic gate and no tool", () => {
  const errors: string[] = [];
  const hooks: Array<() => PluginHookBeforeAgentRunResult> = [];
  let registeredTools = 0;
  const api = {
    pluginConfig: {},
    logger: {
      error(message: string) {
        errors.push(message);
      },
    },
    on(name: string, handler: () => PluginHookBeforeAgentRunResult) {
      assert.equal(name, "before_agent_run");
      hooks.push(handler);
    },
    registerTool() {
      registeredTools += 1;
    },
  } as unknown as OpenClawPluginApi;

  plugin.register(api);

  assert.equal(registeredTools, 0);
  assert.deepEqual(errors, ["idea-to-jira startup disabled code=CONFIG_INVALID"]);
  assert.equal(hooks.length, 1);
  assert.deepEqual(hooks[0]?.(), {
    outcome: "block",
    reason: "CONFIG_INVALID",
    message: "This request is unavailable.",
    category: "access_policy",
  });
});
