import type { StorageUnitOfWork } from "../storage/repository.js";
import type { SqlExecutor } from "../storage/transaction.js";
import type { AuditEvent } from "./types.js";

export interface AuditWriter {
  append(sql: SqlExecutor, event: AuditEvent): void;
}

/** Append-only application API. No update/delete methods are exposed. */
export class SqliteAuditWriter implements AuditWriter {
  append(sql: SqlExecutor, event: AuditEvent): void {
    sql.prepare(`
      INSERT INTO audit_log(
        event_id, occurred_at, actor_user_id, entity_type, entity_id, operation, outcome, code,
        details_hash, event_version, actor_kind, actor_ref_hash, correlation_id, request_id,
        draft_id, draft_version, operation_id, notification_id, correction_of_event_id,
        retention_class, retention_policy_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.occurredAt,
      event.actor.kind === "USER" ? (event.actor.userId ?? null) : null,
      event.target.type,
      event.target.id ?? null,
      event.action,
      event.outcome,
      event.code,
      event.detailsHash ?? null,
      event.version,
      event.actor.kind,
      event.actor.kind === "USER" ? (event.actor.refHash ?? null) : null,
      event.links.correlationId ?? null,
      event.links.requestId ?? null,
      event.links.draftId ?? null,
      event.links.draftVersion ?? null,
      event.links.operationId ?? null,
      event.links.notificationId ?? null,
      event.correctionOfEventId ?? null,
      event.retentionClass,
      event.retentionPolicyVersion,
    );
  }
}

/** Couples a critical state mutation and its mandatory audit insert in one DB transaction. */
export class AuditedCriticalOperation {
  constructor(
    private readonly unitOfWork: StorageUnitOfWork,
    private readonly audit: AuditWriter,
  ) {}

  run<T>(event: AuditEvent, mutate: (sql: SqlExecutor) => T): T {
    return this.unitOfWork.criticalTransaction(({ sql }) => {
      const result = mutate(sql);
      this.audit.append(sql, event);
      return result;
    });
  }
}
