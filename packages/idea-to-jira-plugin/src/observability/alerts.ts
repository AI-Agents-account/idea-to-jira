import type { SafeErrorCode } from "../errors/safe-error.js";
import type { MetricComponent } from "./metrics.js";

export const ALERT_TYPES = Object.freeze([
  "UPSTREAM_AUTH_FAILURE",
  "UPSTREAM_DEGRADATION",
  "OPERATION_UNKNOWN",
  "NOTIFICATION_EXHAUSTED",
  "STORAGE_FAILURE",
  "BACKUP_RESTORE_FAILURE",
  "RESOURCE_PRESSURE",
  "STT_UNAVAILABLE",
  "CATALOG_INVALID",
  "RETENTION_FAILURE",
] as const);
export type AlertType = (typeof ALERT_TYPES)[number];

export interface AlertEvent {
  readonly version: 1;
  readonly alertId: string;
  readonly occurredAt: string;
  readonly type: AlertType;
  readonly severity: "WARNING" | "CRITICAL";
  readonly component: MetricComponent;
  readonly errorCode: SafeErrorCode;
  readonly correlationId?: string;
  readonly operationId?: string;
}

/** Outbox boundary only. Destination/routing is intentionally absent and remains server-side stage 12/14 work. */
export interface AlertOutbox {
  enqueue(event: AlertEvent): void;
}
