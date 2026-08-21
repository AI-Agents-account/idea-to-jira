import assert from "node:assert/strict";
import test from "node:test";

import { createCorrelationContext } from "../src/observability/correlation.js";
import { StructuredLogger, type StructuredLogEvent } from "../src/observability/logger.js";
import { recordMetric, type MetricPoint } from "../src/observability/metrics.js";

const privateText = "Private Jira description must never become telemetry";

test("correlation and request IDs are distinct local trace identities", () => {
  const context = createCorrelationContext();
  assert.match(context.correlationId, /^[a-f0-9-]{36}$/);
  assert.match(context.requestId, /^[a-f0-9-]{36}$/);
  assert.notEqual(context.correlationId, context.requestId);
  assert.equal("jiraKey" in context, false);
  assert.equal("idempotencyKey" in context, false);
});

test("structured logger emits only the closed operational schema", () => {
  const messages: string[] = [];
  const logger = new StructuredLogger({ info: (message) => messages.push(message), error: (message) => messages.push(message) });
  logger.emit("ERROR", {
    timestamp: "2026-08-20T12:00:00.000Z",
    component: "STORAGE",
    eventType: "STORAGE_STARTUP",
    outcome: "FAILED",
    correlationId: "correlation-1",
    errorCode: "STORAGE_STARTUP_FAILED",
    detail: privateText,
    transcript: "Приватная расшифровка 🔒",
  } as unknown as StructuredLogEvent);
  assert.deepEqual(JSON.parse(messages[0] ?? ""), {
    version: 1,
    timestamp: "2026-08-20T12:00:00.000Z",
    component: "STORAGE",
    eventType: "STORAGE_STARTUP",
    outcome: "FAILED",
    correlationId: "correlation-1",
    errorCode: "STORAGE_STARTUP_FAILED",
  });
  assert.equal((messages[0] ?? "").includes(privateText), false);
  assert.equal((messages[0] ?? "").includes("Приватная расшифровка"), false);
  assert.throws(() => logger.emit("INFO", {
    timestamp: "2026-08-20T12:00:00.000Z",
    component: "PLUGIN",
    eventType: "BAD EVENT",
    outcome: "FAILED",
  }), /LOG_EVENT_TYPE_INVALID/);
});

test("metric labels are bounded and reject IDs or arbitrary keys", () => {
  const captured: MetricPoint[] = [];
  recordMetric({ record: (point) => captured.push(point) }, {
    name: "idea_to_jira_blocks_total",
    value: 1,
    labels: { component: "SECURITY", outcome: "REJECTED", errorCode: "RATE_LIMITED" },
  });
  assert.equal(captured.length, 1);
  assert.throws(() => recordMetric({ record: () => undefined }, {
    name: "idea_to_jira_blocks_total",
    value: 1,
    labels: { operationId: "operation-1" },
  } as unknown as MetricPoint), /METRIC_LABEL_INVALID/);
  assert.throws(() => recordMetric({ record: () => undefined }, {
    name: "idea_to_jira_blocks_total",
    value: 1,
    labels: { errorCode: privateText },
  } as unknown as MetricPoint), /METRIC_LABEL_INVALID/);
  assert.throws(() => recordMetric({ record: () => undefined }, {
    name: "idea_to_jira_blocks_total",
    value: 1,
    labels: { component: "operation-1" },
  } as unknown as MetricPoint), /METRIC_LABEL_INVALID/);
  assert.throws(() => recordMetric({ record: () => undefined }, {
    name: "unbounded_dynamic_metric",
    value: 1,
    labels: {},
  } as unknown as MetricPoint), /METRIC_NAME_INVALID/);
});
