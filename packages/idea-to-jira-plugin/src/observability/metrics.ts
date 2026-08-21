import { isSafeErrorCode, type SafeErrorCode } from "../errors/index.js";

export const METRIC_TAXONOMY_VERSION = 1 as const;
export const METRIC_LABEL_POLICY_VERSION = 1 as const;

export const METRIC_NAMES = Object.freeze([
  "idea_to_jira_users_active",
  "idea_to_jira_access_requests_total",
  "idea_to_jira_draft_lifecycle_total",
  "idea_to_jira_duplicate_search_total",
  "idea_to_jira_duplicate_search_latency_ms",
  "idea_to_jira_jira_create_total",
  "idea_to_jira_provider_latency_ms",
  "idea_to_jira_provider_errors_total",
  "idea_to_jira_notifications_total",
  "idea_to_jira_blocks_total",
  "idea_to_jira_sqlite_busy_total",
  "idea_to_jira_migration_status",
  "idea_to_jira_unknown_reconciliation_age_seconds",
] as const);
export type MetricName = (typeof METRIC_NAMES)[number];
export type MetricOutcome = "ALLOWED" | "REJECTED" | "SUCCEEDED" | "FAILED" | "UNKNOWN";

export const METRIC_COMPONENTS = Object.freeze([
  "SECURITY",
  "STORAGE",
  "DRAFT",
  "DUPLICATE",
  "JIRA",
  "MODEL",
  "STT",
  "TELEGRAM",
  "NOTIFICATION",
] as const);
export type MetricComponent = (typeof METRIC_COMPONENTS)[number];

export interface MetricLabels {
  readonly component?: MetricComponent;
  readonly outcome?: MetricOutcome;
  readonly errorCode?: SafeErrorCode;
}

export interface MetricPoint {
  readonly name: MetricName;
  readonly value: number;
  readonly labels: MetricLabels;
}

export interface MetricsSink {
  record(point: MetricPoint): void;
}

const METRIC_NAME_SET: ReadonlySet<string> = new Set(METRIC_NAMES);
const METRIC_COMPONENT_SET: ReadonlySet<string> = new Set(METRIC_COMPONENTS);
const METRIC_OUTCOME_SET: ReadonlySet<string> = new Set([
  "ALLOWED",
  "REJECTED",
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN",
]);

/** IDs, routes, users, Jira keys and free text cannot be represented as metric labels. */
export function recordMetric(sink: MetricsSink, point: MetricPoint): void {
  if (!METRIC_NAME_SET.has(point.name)) throw new Error("METRIC_NAME_INVALID");
  if (typeof point.value !== "number" || !Number.isFinite(point.value) || point.value < 0) {
    throw new Error("METRIC_VALUE_INVALID");
  }
  if (point.labels === null || typeof point.labels !== "object" || Array.isArray(point.labels)) {
    throw new Error("METRIC_LABEL_INVALID");
  }
  const keys = Object.keys(point.labels);
  if (keys.some((key) => !["component", "outcome", "errorCode"].includes(key))) {
    throw new Error("METRIC_LABEL_INVALID");
  }
  if (point.labels.component !== undefined && !METRIC_COMPONENT_SET.has(point.labels.component)) {
    throw new Error("METRIC_LABEL_INVALID");
  }
  if (point.labels.outcome !== undefined && !METRIC_OUTCOME_SET.has(point.labels.outcome)) {
    throw new Error("METRIC_LABEL_INVALID");
  }
  if (point.labels.errorCode !== undefined && !isSafeErrorCode(point.labels.errorCode)) {
    throw new Error("METRIC_LABEL_INVALID");
  }
  const labels: MetricLabels = Object.freeze({
    ...(point.labels.component !== undefined ? { component: point.labels.component } : {}),
    ...(point.labels.outcome !== undefined ? { outcome: point.labels.outcome } : {}),
    ...(point.labels.errorCode !== undefined ? { errorCode: point.labels.errorCode } : {}),
  });
  sink.record(Object.freeze({ name: point.name, value: point.value, labels }));
}
