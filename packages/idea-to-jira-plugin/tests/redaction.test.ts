import assert from "node:assert/strict";
import test from "node:test";

import { SafeError, normalizeSafeError } from "../src/errors/safe-error.js";
import {
  redactTokenLike,
  sanitizeClassifiedRecord,
  sanitizeHeaders,
  sanitizeProviderError,
  sanitizeTelegramUpdate,
  sanitizeUrl,
} from "../src/security/redaction.js";

const secret = ["super", "private", "credential"].join("-");
const rawDescription = "Confidential roadmap narrative with customer names";
const transcript = "A private voice transcript in Unicode: Привет мир 🔒";

test("classified records allow IDs/versions/hashes/outcomes and drop unknown content", () => {
  const output = sanitizeClassifiedRecord({
    requestId: "request-1",
    version: 2,
    hash: "a".repeat(64),
    outcome: "SUCCEEDED",
    description: rawDescription,
    nested: { transcript },
    credential: secret,
  }, {
    requestId: "ID",
    version: "VERSION",
    hash: "HASH",
    outcome: "OUTCOME",
  });
  assert.deepEqual(output, {
    requestId: "request-1",
    version: 2,
    hash: "a".repeat(64),
    outcome: "SUCCEEDED",
  });
  const capture = JSON.stringify(output);
  assert.equal(capture.includes(rawDescription), false);
  assert.equal(capture.includes(transcript), false);
  assert.equal(capture.includes(secret), false);
});

test("URL and headers strip credentials, query values, fragments, and auth material", () => {
  const input = `https://user:${secret}@jira.example.test/rest/api/2/issue/FPF-123?token=${secret}#fragment`;
  assert.equal(sanitizeUrl(input), "https://jira.example.test/rest/api/:id/issue/:id");
  const headers = sanitizeHeaders({
    Authorization: `Bearer ${secret}`,
    Cookie: `session=${secret}`,
    "Content-Type": "application/json",
    "Content-Length": "512",
    "Retry-After": rawDescription,
    "X-Request-Id": "request-1",
    "X-Private": rawDescription,
  });
  assert.deepEqual(headers, {
    "content-type": "application/json",
    "content-length": "512",
    "x-request-id": "request-1",
  });
  assert.equal(redactTokenLike(`token=${secret} пароль`), "[REDACTED] пароль");
  assert.equal(redactTokenLike(`пароль=${secret}`), "[REDACTED]");
  const providerToken = ["ghp", "012345678901234567890123456789012345"].join("_");
  assert.equal(redactTokenLike(providerToken), "[REDACTED]");
});

test("Telegram update sanitizer drops raw text, identity, callback and voice payload", () => {
  const output = sanitizeTelegramUpdate({
    update_id: 42,
    message: {
      message_id: 7,
      from: { id: 123456789 },
      chat: { id: 123456789 },
      text: rawDescription,
      caption: transcript,
      voice: { file_id: secret, file_unique_id: secret, bytes: [1, 2, 3] },
    },
  });
  assert.deepEqual(output, { updateId: 42, messageId: 7, kind: "VOICE" });
  const capture = JSON.stringify(output);
  for (const forbidden of [secret, rawDescription, transcript, "123456789"]) {
    assert.equal(capture.includes(forbidden), false);
  }
});

test("provider and nested exception errors expose only bounded taxonomy", () => {
  const nested = new Error(rawDescription, {
    cause: { response: { body: rawDescription, headers: { authorization: secret } }, transcript },
  });
  Object.assign(nested, { status: 403 });
  const jira = sanitizeProviderError("JIRA", nested);
  assert.deepEqual(jira, {
    provider: "JIRA",
    code: "JIRA_AUTH_FAILED",
    message: "This request is unavailable.",
    retryable: false,
    statusClass: "4XX",
  });
  const unknown = normalizeSafeError({ deeply: { nested, secret, transcript } });
  assert.deepEqual(JSON.parse(JSON.stringify(unknown)), {
    code: "INTERNAL_ERROR",
    message: "This request is unavailable.",
    retryable: false,
  });
  assert.equal(JSON.stringify(unknown).includes(rawDescription), false);
});

test("SafeError never serializes its internal cause", () => {
  const error = new SafeError("JIRA_UNKNOWN_RESULT", false, { cause: { secret, rawDescription } });
  assert.deepEqual(error.toSafeView("OPERATOR"), {
    code: "JIRA_UNKNOWN_RESULT",
    message: "The result is not confirmed.",
    retryable: false,
  });
  assert.equal(JSON.stringify(error).includes(secret), false);
});
