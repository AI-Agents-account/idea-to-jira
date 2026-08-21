import assert from "node:assert/strict";
import test from "node:test";

import { assertPayloadWithinLimit, TokenBucketRateLimiter } from "../src/runtime/policy.js";
import type { TrustedRequesterContext } from "../src/runtime/requester-context.js";
import { effectiveConfig } from "./config-fixture.js";

const requester: TrustedRequesterContext = {
  agentId: "idea-mvp",
  channelId: "telegram",
  accountId: "idea-mvp",
  senderId: "123456789",
  chatId: "123456789",
};

test("token bucket is isolated by sender and operation and refills deterministically", () => {
  let now = 0;
  const limiter = new TokenBucketRateLimiter(
    { inputTextChars: 100, requestsPerMinute: 60, burst: 2, activeDrafts: 3 },
    () => now,
  );
  assert.equal(limiter.consume(requester, "draft_tool").allowed, true);
  assert.equal(limiter.consume(requester, "draft_tool").allowed, true);
  assert.equal(limiter.consume(requester, "draft_tool").allowed, false);
  assert.equal(limiter.consume(requester, "model_run").allowed, true);
  assert.equal(limiter.consume({ ...requester, senderId: "987654321", chatId: "987654321" }, "draft_tool").allowed, true);

  now = 1_000;
  assert.equal(limiter.consume(requester, "draft_tool").allowed, true);
});

test("payload limit rejects oversized and non-serializable input", () => {
  const config = effectiveConfig();
  assert.doesNotThrow(() => assertPayloadWithinLimit({ summary: "small" }, config));
  assert.throws(
    () => assertPayloadWithinLimit({ text: "x".repeat(config.limits.inputTextChars + 1) }, config),
    /PAYLOAD_TOO_LARGE/,
  );
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(() => assertPayloadWithinLimit(circular, config), /PAYLOAD_INVALID/);
});
