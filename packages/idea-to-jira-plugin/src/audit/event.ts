import { createHash, randomUUID } from "node:crypto";

import {
  AUDIT_ACTIONS,
  AUDIT_EVENT_VERSION,
  AUDIT_OUTCOMES,
  AUDIT_TARGET_TYPES,
  RETENTION_CLASSES,
  RETENTION_POLICY_VERSION,
  type AuditActor,
  type AuditEvent,
} from "./types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ACTION_SET: ReadonlySet<string> = new Set(AUDIT_ACTIONS);
const OUTCOME_SET: ReadonlySet<string> = new Set(AUDIT_OUTCOMES);
const TARGET_TYPE_SET: ReadonlySet<string> = new Set(AUDIT_TARGET_TYPES);
const RETENTION_CLASS_SET: ReadonlySet<string> = new Set(RETENTION_CLASSES);

function requireId(value: string, field: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`AUDIT_${field}_INVALID`);
  return value;
}

function optionalId(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : requireId(value, field);
}

function validateActor(actor: AuditActor): AuditActor {
  if (actor.kind === "SYSTEM") return actor;
  const userId = optionalId(actor.userId, "ACTOR_ID");
  const refHash = actor.refHash;
  if (!userId && !refHash) throw new Error("AUDIT_ACTOR_INVALID");
  if (refHash !== undefined && !SHA256.test(refHash)) throw new Error("AUDIT_ACTOR_HASH_INVALID");
  return { kind: "USER", ...(userId ? { userId } : {}), ...(refHash ? { refHash } : {}) };
}

export function hashAuditActorReference(accountId: string, senderId: string): string {
  return createHash("sha256").update(`${accountId}\0${senderId}`, "utf8").digest("hex");
}

export type NewAuditEvent = Omit<
  AuditEvent,
  "version" | "eventId" | "occurredAt" | "retentionPolicyVersion"
> & {
  readonly eventId?: string;
  readonly occurredAt?: string;
};

export function createAuditEvent(input: NewAuditEvent): AuditEvent {
  const eventId = requireId(input.eventId ?? randomUUID(), "EVENT_ID");
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  if (
    typeof occurredAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(occurredAt) ||
    !Number.isFinite(Date.parse(occurredAt)) ||
    new Date(occurredAt).toISOString() !== occurredAt
  ) {
    throw new Error("AUDIT_TIMESTAMP_INVALID");
  }
  if (!ACTION_SET.has(input.action)) throw new Error("AUDIT_ACTION_INVALID");
  if (!OUTCOME_SET.has(input.outcome)) throw new Error("AUDIT_OUTCOME_INVALID");
  if (!TARGET_TYPE_SET.has(input.target.type)) throw new Error("AUDIT_TARGET_TYPE_INVALID");
  if (!RETENTION_CLASS_SET.has(input.retentionClass)) {
    throw new Error("AUDIT_RETENTION_CLASS_INVALID");
  }
  if (!SAFE_CODE.test(input.code)) throw new Error("AUDIT_CODE_INVALID");
  if (input.detailsHash !== undefined && !SHA256.test(input.detailsHash)) {
    throw new Error("AUDIT_DETAILS_HASH_INVALID");
  }
  if (input.links.draftVersion !== undefined &&
      (!Number.isSafeInteger(input.links.draftVersion) || input.links.draftVersion < 1)) {
    throw new Error("AUDIT_DRAFT_VERSION_INVALID");
  }

  const correlationId = optionalId(input.links.correlationId, "CORRELATION_ID");
  const requestId = optionalId(input.links.requestId, "REQUEST_ID");
  const draftId = optionalId(input.links.draftId, "DRAFT_ID");
  const operationId = optionalId(input.links.operationId, "OPERATION_ID");
  const notificationId = optionalId(input.links.notificationId, "NOTIFICATION_ID");
  return Object.freeze({
    version: AUDIT_EVENT_VERSION,
    eventId,
    occurredAt,
    actor: Object.freeze(validateActor(input.actor)),
    action: input.action,
    target: Object.freeze({
      type: input.target.type,
      ...(input.target.id !== undefined ? { id: requireId(input.target.id, "TARGET_ID") } : {}),
    }),
    outcome: input.outcome,
    code: input.code,
    links: Object.freeze({
      ...(correlationId ? { correlationId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(draftId ? { draftId } : {}),
      ...(input.links.draftVersion ? { draftVersion: input.links.draftVersion } : {}),
      ...(operationId ? { operationId } : {}),
      ...(notificationId ? { notificationId } : {}),
    }),
    ...(input.detailsHash ? { detailsHash: input.detailsHash } : {}),
    ...(input.correctionOfEventId !== undefined
      ? { correctionOfEventId: requireId(input.correctionOfEventId, "CORRECTION_ID") }
      : {}),
    retentionClass: input.retentionClass,
    retentionPolicyVersion: RETENTION_POLICY_VERSION,
  });
}
