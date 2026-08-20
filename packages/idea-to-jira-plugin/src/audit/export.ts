import type { StorageUnitOfWork } from "../storage/repository.js";
import type { AuditAction, AuditOutcome, AuditTargetType, RetentionClass } from "./types.js";

export interface AuditExportRequest {
  readonly requesterUserId: string;
  readonly limit: number;
  readonly afterSequence?: number;
}

export interface AuditExportAuthorizer {
  canExport(requesterUserId: string): boolean;
}

export interface SanitizedAuditExportRow {
  readonly sequence: number;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly actorUserId?: string;
  readonly action: AuditAction;
  readonly targetType: AuditTargetType;
  readonly targetId?: string;
  readonly outcome: AuditOutcome;
  readonly code: string;
  readonly correlationId?: string;
  readonly requestId?: string;
  readonly draftId?: string;
  readonly draftVersion?: number;
  readonly operationId?: string;
  readonly notificationId?: string;
  readonly detailsHash?: string;
  readonly correctionOfEventId?: string;
  readonly retentionClass: RetentionClass;
  readonly retentionPolicyVersion: 1;
}

type Row = Record<string, string | number | null>;

export class SanitizedAuditExporter {
  constructor(
    private readonly unitOfWork: StorageUnitOfWork,
    private readonly authorizer: AuditExportAuthorizer,
  ) {}

  export(request: AuditExportRequest): readonly SanitizedAuditExportRow[] {
    if (!this.authorizer.canExport(request.requesterUserId)) throw new Error("AUDIT_EXPORT_DENIED");
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1_000) {
      throw new Error("AUDIT_EXPORT_LIMIT_INVALID");
    }
    const after = request.afterSequence ?? 0;
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("AUDIT_EXPORT_CURSOR_INVALID");

    return this.unitOfWork.transaction(({ sql }) => {
      const rows = sql.prepare(`
        SELECT sequence, event_id, occurred_at, actor_user_id, entity_type, entity_id,
          operation, outcome, code, correlation_id, request_id, draft_id, draft_version,
          operation_id, notification_id, details_hash, correction_of_event_id,
          retention_class, retention_policy_version
        FROM audit_log
        WHERE sequence > ?
        ORDER BY sequence ASC
        LIMIT ?
      `).all(after, request.limit) as unknown as Row[];
      return Object.freeze(rows.map((row) => Object.freeze({
        sequence: row.sequence as number,
        eventId: row.event_id as string,
        occurredAt: row.occurred_at as string,
        ...(row.actor_user_id ? { actorUserId: row.actor_user_id as string } : {}),
        action: row.operation as AuditAction,
        targetType: row.entity_type as AuditTargetType,
        ...(row.entity_id ? { targetId: row.entity_id as string } : {}),
        outcome: row.outcome as AuditOutcome,
        code: row.code as string,
        ...(row.correlation_id ? { correlationId: row.correlation_id as string } : {}),
        ...(row.request_id ? { requestId: row.request_id as string } : {}),
        ...(row.draft_id ? { draftId: row.draft_id as string } : {}),
        ...(row.draft_version ? { draftVersion: row.draft_version as number } : {}),
        ...(row.operation_id ? { operationId: row.operation_id as string } : {}),
        ...(row.notification_id ? { notificationId: row.notification_id as string } : {}),
        ...(row.details_hash ? { detailsHash: row.details_hash as string } : {}),
        ...(row.correction_of_event_id ? { correctionOfEventId: row.correction_of_event_id as string } : {}),
        retentionClass: row.retention_class as RetentionClass,
        retentionPolicyVersion: row.retention_policy_version as 1,
      })));
    });
  }
}
