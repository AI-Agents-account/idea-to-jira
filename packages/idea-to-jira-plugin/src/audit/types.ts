export const AUDIT_EVENT_VERSION = 1 as const;
export const RETENTION_POLICY_VERSION = 1 as const;

export const AUDIT_ACTIONS = Object.freeze([
  "SECURITY_DECISION",
  "ACCESS_DECISION",
  "ROLE_TRANSITION",
  "DRAFT_TRANSITION",
  "CATALOG_SELECTION",
  "DUPLICATE_DECISION",
  "OPERATION_TRANSITION",
  "RECONCILIATION_DECISION",
  "NOTIFICATION_TRANSITION",
] as const);
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_OUTCOMES = Object.freeze([
  "ALLOWED",
  "REJECTED",
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN",
] as const);
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const AUDIT_TARGET_TYPES = Object.freeze([
  "SECURITY_BOUNDARY",
  "ACCESS_REQUEST",
  "ROLE_GRANT",
  "DRAFT",
  "CATALOG_VERSION",
  "DUPLICATE_CHECK",
  "POSTING_OPERATION",
  "NOTIFICATION",
] as const);
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

export const RETENTION_CLASSES = Object.freeze([
  "DRAFT_90D",
  "AUDIT_1Y",
  "OPERATOR_POLICY",
] as const);
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

export type AuditActor =
  | { readonly kind: "SYSTEM" }
  | { readonly kind: "USER"; readonly userId?: string; readonly refHash?: string };

export interface AuditLinks {
  readonly correlationId?: string;
  readonly requestId?: string;
  readonly draftId?: string;
  readonly draftVersion?: number;
  readonly operationId?: string;
  readonly notificationId?: string;
}

/** Versioned, content-free audit envelope. Raw payload fields are intentionally unrepresentable. */
export interface AuditEvent {
  readonly version: typeof AUDIT_EVENT_VERSION;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly actor: AuditActor;
  readonly action: AuditAction;
  readonly target: {
    readonly type: AuditTargetType;
    readonly id?: string;
  };
  readonly outcome: AuditOutcome;
  readonly code: string;
  readonly links: AuditLinks;
  readonly detailsHash?: string;
  readonly correctionOfEventId?: string;
  readonly retentionClass: RetentionClass;
  readonly retentionPolicyVersion: typeof RETENTION_POLICY_VERSION;
}
