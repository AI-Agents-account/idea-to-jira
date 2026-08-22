import { createHash, randomUUID } from "node:crypto";

import type { EffectiveConfig } from "../config.js";
import type { StorageUnitOfWork } from "../storage/repository.js";
import { JiraHttpClient } from "./http-client.js";
import type { DurableConfirmationBinding } from "./persistence.js";
import { JiraFailure } from "./types.js";

export type JiraPostingState = "PENDING" | "POSTING" | "CREATED" | "FAILED_RETRYABLE" | "FAILED_FINAL" | "UNKNOWN" | "MANUAL_RESOLUTION_REQUIRED";
export interface JiraPostingResult { readonly operationId: string; readonly state: JiraPostingState; readonly jiraKey?: string; readonly jiraUrl?: string; readonly errorCode?: string }
interface Row { id: string; state: JiraPostingState; jira_issue_id: string | null; jira_issue_key: string | null; error_code: string | null }
function validDraftId(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value); }
function validHash(value: string): boolean { return /^[a-f0-9]{64}$/.test(value); }
function result(row: Row, origin: string): JiraPostingResult {
  return Object.freeze({ operationId: row.id, state: row.state, ...(row.jira_issue_key ? { jiraKey: row.jira_issue_key, jiraUrl: `${origin}/browse/${encodeURIComponent(row.jira_issue_key)}` } : {}), ...(row.error_code ? { errorCode: row.error_code } : {}) });
}
function response(value: unknown, projectKey: string): { id: string; key: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>; const id = typeof item.id === "string" ? item.id : undefined; const key = typeof item.key === "string" ? item.key : undefined;
  return id && /^[1-9][0-9]*$/.test(id) && key && new RegExp(`^${projectKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[1-9][0-9]*$`).test(key) ? { id, key } : undefined;
}

export class JiraPostingService {
  private readonly now: () => string; private readonly newId: () => string;
  constructor(
    private readonly unitOfWork: StorageUnitOfWork,
    private readonly config: EffectiveConfig["jira"],
    private readonly http: JiraHttpClient,
    options: { readonly now?: () => string; readonly newId?: () => string } = {},
  ) { this.now = options.now ?? (() => new Date().toISOString()); this.newId = options.newId ?? randomUUID; }

  /** Must run during startup: a prior POSTING row may already have reached Jira. */
  recoverInterrupted(): number {
    return this.unitOfWork.criticalTransaction(({ sql }) => Number(sql.prepare(
      "UPDATE posting_operations SET state = 'UNKNOWN', error_code = 'PROCESS_RESTART_DURING_POST', record_version = record_version + 1, updated_at = ? WHERE state = 'POSTING'",
    ).run(this.now()).changes));
  }

  async create(draftId: string, draftVersion: number, payloadHash: string, fields: Readonly<Record<string, unknown>>, confirmation?: DurableConfirmationBinding): Promise<JiraPostingResult> {
    if (!validDraftId(draftId) || !Number.isSafeInteger(draftVersion) || draftVersion < 1 || !validHash(payloadHash)) throw new Error("JIRA_POSTING_INPUT_INVALID");
    const operationId = this.newId(); const idempotencyKey = createHash("sha256").update(`${draftId}\u0000${draftVersion}\u0000${payloadHash}`).digest("hex"); const now = this.now();
    const claim = this.unitOfWork.criticalTransaction(({ sql }) => {
      sql.prepare("INSERT OR IGNORE INTO posting_operations(id, draft_id, draft_version, payload_hash, idempotency_key, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)").run(operationId, draftId, draftVersion, payloadHash, idempotencyKey, now, now);
      const row = sql.prepare("SELECT id, state, jira_issue_id, jira_issue_key, error_code FROM posting_operations WHERE draft_id = ? AND draft_version = ? AND payload_hash = ?").get(draftId, draftVersion, payloadHash) as unknown as Row;
      if (row.state !== "PENDING") return { owner: false, row };
      if (confirmation) {
        const consumed = sql.prepare("UPDATE jira_confirmations SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND actor_hash = ? AND chat_hash = ? AND draft_id = ? AND draft_version = ? AND metadata_hash = ? AND payload_hash = ?").run(
          now, confirmation.id, confirmation.actorHash, confirmation.chatHash, confirmation.draftId, confirmation.draftVersion, confirmation.metadataHash, confirmation.confirmationHash,
        ).changes;
        if (Number(consumed) !== 1) throw new Error("JIRA_CONFIRMATION_STALE");
      }
      const changed = sql.prepare("UPDATE posting_operations SET state = 'POSTING', attempt_count = 1, network_started_at = ?, last_attempt_at = ?, record_version = record_version + 1, updated_at = ? WHERE id = ? AND state = 'PENDING'").run(now, now, now, row.id).changes;
      if (Number(changed) !== 1) {
        const latest = sql.prepare("SELECT id, state, jira_issue_id, jira_issue_key, error_code FROM posting_operations WHERE id = ?").get(row.id) as unknown as Row;
        return { owner: false, row: latest };
      }
      return { owner: true, row: { ...row, state: "POSTING" as const } };
    });
    if (!claim.owner) return result(claim.row, this.config.url);

    try {
      const created = await this.http.createIssue(fields); const issue = response(created.value, this.config.projectKey);
      if (!issue) return this.finish(claim.row.id, "UNKNOWN", "JIRA_MALFORMED");
      return this.unitOfWork.criticalTransaction(({ sql }) => {
        sql.prepare("UPDATE posting_operations SET state = 'CREATED', jira_issue_id = ?, jira_issue_key = ?, error_code = NULL, record_version = record_version + 1, updated_at = ? WHERE id = ? AND state = 'POSTING'").run(issue.id, issue.key, this.now(), claim.row.id);
        return result(sql.prepare("SELECT id, state, jira_issue_id, jira_issue_key, error_code FROM posting_operations WHERE id = ?").get(claim.row.id) as unknown as Row, this.config.url);
      });
    } catch (error) {
      const failure = error instanceof JiraFailure ? error : new JiraFailure("JIRA_NETWORK_ERROR");
      const finalCodes = new Set(["JIRA_UNAUTHORIZED", "JIRA_FORBIDDEN", "JIRA_RATE_LIMITED", "JIRA_REDIRECT_DENIED", "JIRA_REQUEST_REJECTED"]);
      return this.finish(claim.row.id, failure.definitelyNotSent || finalCodes.has(failure.code) ? "FAILED_FINAL" : "UNKNOWN", failure.code);
    }
  }

  private finish(id: string, state: "FAILED_FINAL" | "UNKNOWN", code: string): JiraPostingResult {
    return this.unitOfWork.criticalTransaction(({ sql }) => {
      sql.prepare("UPDATE posting_operations SET state = ?, error_code = ?, record_version = record_version + 1, updated_at = ? WHERE id = ? AND state = 'POSTING'").run(state, code, this.now(), id);
      return result(sql.prepare("SELECT id, state, jira_issue_id, jira_issue_key, error_code FROM posting_operations WHERE id = ?").get(id) as unknown as Row, this.config.url);
    });
  }
}
