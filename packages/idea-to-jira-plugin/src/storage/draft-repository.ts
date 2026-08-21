import type {
  CompletenessResult,
  DraftContent,
  DraftDependencies,
  PostingReference,
  ReadinessResult,
} from "../domain/draft.js";
import type { DraftState } from "../domain/draft-state.js";
import type { SqlExecutor } from "./transaction.js";

export interface DraftHeadRow {
  readonly id: string;
  readonly owner_user_id: string;
  readonly state: DraftState;
  readonly head_version: number;
  readonly record_version: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly summary: string;
  readonly problem: string;
  readonly desired_outcome: string;
  readonly provenance_hash: string;
  readonly draft_schema_version: 1;
  readonly formatter_version: 1;
  readonly domain_json: string;
  readonly description: string;
  readonly completeness_json: string;
  readonly readiness_json: string;
  readonly dependencies_json: string;
}

export interface DraftVersionInsert {
  readonly draftId: string;
  readonly version: number;
  readonly summary: string;
  readonly problem: string;
  readonly desiredOutcome: string;
  readonly evidenceJson: string;
  readonly provenanceHash: string;
  readonly content: DraftContent;
  readonly description: string;
  readonly completeness: CompletenessResult;
  readonly readiness: ReadinessResult;
  readonly dependencies: DraftDependencies;
  readonly createdAt: string;
}

interface PostingRow {
  readonly id: string;
  readonly draft_version: number;
  readonly payload_hash: string;
  readonly state: PostingReference["state"];
}

function changed(result: { readonly changes: number | bigint }): boolean {
  return Number(result.changes) === 1;
}

export class SqliteDraftRepository {
  findOwnerUserId(sql: SqlExecutor, senderId: string): string | undefined {
    return (sql.prepare(`
      SELECT id FROM users
      WHERE telegram_sender_id = ? AND state <> 'BLOCKED'
    `).get(senderId) as { id: string } | undefined)?.id;
  }

  countActiveOwned(sql: SqlExecutor, senderId: string): number {
    const row = sql.prepare(`
      SELECT count(*) AS count
      FROM drafts d
      JOIN users u ON u.id = d.owner_user_id
      WHERE u.telegram_sender_id = ? AND u.state <> 'BLOCKED'
        AND d.state IN ('EDITING', 'READY')
    `).get(senderId) as { count: number };
    return row.count;
  }

  findOwnedHead(sql: SqlExecutor, draftId: string, senderId: string): DraftHeadRow | undefined {
    return sql.prepare(`
      SELECT d.id, d.owner_user_id, d.state, d.head_version, d.record_version,
             d.created_at, d.updated_at,
             v.summary, v.problem, v.desired_outcome, v.provenance_hash,
             v.draft_schema_version, v.formatter_version, v.domain_json,
             v.description, v.completeness_json, v.readiness_json, v.dependencies_json
      FROM drafts d
      JOIN users u ON u.id = d.owner_user_id
      JOIN draft_versions v ON v.draft_id = d.id AND v.version = d.head_version
      WHERE d.id = ? AND u.telegram_sender_id = ? AND u.state <> 'BLOCKED'
    `).get(draftId, senderId) as DraftHeadRow | undefined;
  }

  insertDraft(sql: SqlExecutor, draftId: string, ownerUserId: string, createdAt: string): boolean {
    return changed(sql.prepare(`
      INSERT INTO drafts(id, owner_user_id, state, head_version, record_version, created_at, updated_at)
      SELECT ?, u.id, 'EDITING', 1, 1, ?, ?
      FROM users u
      WHERE u.id = ? AND u.state <> 'BLOCKED'
    `).run(draftId, createdAt, createdAt, ownerUserId));
  }

  insertVersion(sql: SqlExecutor, value: DraftVersionInsert): boolean {
    return changed(sql.prepare(`
      INSERT INTO draft_versions(
        draft_id, version, summary, problem, desired_outcome, evidence_json, labels_json,
        provenance_hash, created_at, draft_schema_version, formatter_version, domain_json,
        description, completeness_json, readiness_json, dependencies_json
      )
      SELECT ?, ?, ?, ?, ?, ?, '[]', ?, ?, 1, 1, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM drafts d
        JOIN users u ON u.id = d.owner_user_id
        WHERE d.id = ? AND u.state <> 'BLOCKED'
      )
    `).run(
      value.draftId,
      value.version,
      value.summary,
      value.problem,
      value.desiredOutcome,
      value.evidenceJson,
      value.provenanceHash,
      value.createdAt,
      JSON.stringify(value.content),
      value.description,
      JSON.stringify(value.completeness),
      JSON.stringify(value.readiness),
      JSON.stringify(value.dependencies),
      value.draftId,
    ));
  }

  advanceHead(
    sql: SqlExecutor,
    draftId: string,
    senderId: string,
    expectedVersion: number,
    nextVersion: number,
    nextState: DraftState,
    updatedAt: string,
  ): boolean {
    return changed(sql.prepare(`
      UPDATE drafts
      SET head_version = ?, record_version = record_version + 1, state = ?, updated_at = ?
      WHERE id = ? AND head_version = ? AND record_version = ?
        AND owner_user_id = (
          SELECT id FROM users
          WHERE telegram_sender_id = ? AND state <> 'BLOCKED'
        )
    `).run(nextVersion, nextState, updatedAt, draftId, expectedVersion, expectedVersion, senderId));
  }

  invalidateUnstartedOperation(
    sql: SqlExecutor,
    draftId: string,
    updatedAt: string,
  ): void {
    sql.prepare(`
      UPDATE posting_operations
      SET state = 'FAILED_FINAL', error_code = 'DRAFT_VERSION_INVALIDATED',
          record_version = record_version + 1, updated_at = ?
      WHERE draft_id = ? AND state = 'PENDING'
    `).run(updatedAt, draftId);
  }

  blockingPriorOperations(sql: SqlExecutor, draftId: string): readonly PostingReference[] {
    const rows = sql.prepare(`
      SELECT id, draft_version, payload_hash, state
      FROM posting_operations
      WHERE draft_id = ? AND state IN ('POSTING', 'CREATED', 'UNKNOWN', 'MANUAL_RESOLUTION_REQUIRED')
      ORDER BY draft_version, id
    `).all(draftId) as unknown as PostingRow[];
    return Object.freeze(rows.map((row) => Object.freeze({
      operationId: row.id,
      draftVersion: row.draft_version,
      payloadHash: row.payload_hash,
      state: row.state,
    })));
  }
}
