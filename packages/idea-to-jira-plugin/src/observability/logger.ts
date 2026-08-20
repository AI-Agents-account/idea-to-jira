import { isSafeErrorCode, type SafeErrorCode } from "../errors/index.js";

export const LOG_SCHEMA_VERSION = 1 as const;
export const LOG_COMPONENTS = Object.freeze([
  "PLUGIN",
  "SECURITY",
  "STORAGE",
  "AUDIT",
  "WORKFLOW",
] as const);
export const LOG_OUTCOMES = Object.freeze([
  "ALLOWED",
  "REJECTED",
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN",
] as const);

export type LogComponent = (typeof LOG_COMPONENTS)[number];
export type LogOutcome = (typeof LOG_OUTCOMES)[number];

export interface StructuredLogEvent {
  readonly timestamp: string;
  readonly component: LogComponent;
  readonly eventType: string;
  readonly outcome: LogOutcome;
  readonly correlationId?: string;
  readonly operationId?: string;
  readonly errorCode?: SafeErrorCode;
}

export interface LogTransport {
  info(message: string): void;
  error(message: string): void;
}

const COMPONENT_SET: ReadonlySet<string> = new Set(LOG_COMPONENTS);
const OUTCOME_SET: ReadonlySet<string> = new Set(LOG_OUTCOMES);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validate(event: StructuredLogEvent): void {
  if (
    typeof event.timestamp !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.timestamp) ||
    !Number.isFinite(Date.parse(event.timestamp)) ||
    new Date(event.timestamp).toISOString() !== event.timestamp
  ) {
    throw new Error("LOG_TIMESTAMP_INVALID");
  }
  if (!COMPONENT_SET.has(event.component)) throw new Error("LOG_COMPONENT_INVALID");
  if (typeof event.eventType !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(event.eventType)) {
    throw new Error("LOG_EVENT_TYPE_INVALID");
  }
  if (!OUTCOME_SET.has(event.outcome)) throw new Error("LOG_OUTCOME_INVALID");
  for (const id of [event.correlationId, event.operationId]) {
    if (id !== undefined && (typeof id !== "string" || !SAFE_ID.test(id))) {
      throw new Error("LOG_ID_INVALID");
    }
  }
  if (event.errorCode !== undefined && !isSafeErrorCode(event.errorCode)) {
    throw new Error("LOG_ERROR_CODE_INVALID");
  }
}

/** Emits a closed structured schema; arbitrary detail/payload fields are dropped. */
export class StructuredLogger {
  constructor(private readonly transport: LogTransport) {}

  emit(level: "INFO" | "ERROR", event: StructuredLogEvent): void {
    validate(event);
    const serialized = JSON.stringify({
      version: LOG_SCHEMA_VERSION,
      timestamp: event.timestamp,
      component: event.component,
      eventType: event.eventType,
      outcome: event.outcome,
      ...(event.correlationId !== undefined ? { correlationId: event.correlationId } : {}),
      ...(event.operationId !== undefined ? { operationId: event.operationId } : {}),
      ...(event.errorCode !== undefined ? { errorCode: event.errorCode } : {}),
    });
    if (level === "ERROR") this.transport.error(serialized);
    else this.transport.info(serialized);
  }
}
