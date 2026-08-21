import assert from "node:assert/strict";
import test from "node:test";

import { DisabledJiraIssueClient } from "../src/jira/client.js";

test("disabled Jira adapter rejects before any network call", async (t) => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("NETWORK_MUST_NOT_RUN");
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    new DisabledJiraIssueClient().createIssue(undefined as never),
    /Jira writes are disabled in the scaffold/,
  );
  assert.equal(networkCalls, 0);
});
