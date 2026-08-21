import { createHash, randomUUID } from "node:crypto";

import type { StorageUnitOfWork } from "../storage/repository.js";
import type { DuplicateDecision, JiraSemanticAnswer } from "./types.js";
import type { JiraConfirmation, JiraPreview } from "./confirmation.js";

function identityHash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined; } catch { return undefined; }
}

export interface DurableConfirmationBinding {
  readonly id: string;
  readonly actorHash: string;
  readonly chatHash: string;
  readonly draftId: string;
  readonly draftVersion: number;
  readonly metadataHash: string;
  readonly payloadHash: string;
}

export class JiraWorkflowPersistence {
  constructor(private readonly unitOfWork: StorageUnitOfWork, private readonly now: () => string = () => new Date().toISOString(), private readonly newId: () => string = randomUUID) {}

  saveDecision(decision: DuplicateDecision): void {
    this.unitOfWork.transaction(({ sql }) => { sql.prepare(`INSERT INTO jira_duplicate_decisions(draft_id,draft_version,config_hash,metadata_hash,outcome,decision_json,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(draft_id,draft_version,config_hash,metadata_hash) DO UPDATE SET outcome=excluded.outcome,decision_json=excluded.decision_json,created_at=excluded.created_at`).run(decision.binding.draftId, decision.binding.draftVersion, decision.binding.configHash, decision.binding.metadataHash, decision.outcome, JSON.stringify(decision), this.now()); });
  }
  loadDecision(draftId: string, draftVersion: number, configHash: string, metadataHash: string): DuplicateDecision | undefined {
    return this.unitOfWork.transaction(({ sql }) => {
      const row = sql.prepare(`SELECT decision_json FROM jira_duplicate_decisions WHERE draft_id=? AND draft_version=? AND config_hash=? AND metadata_hash=?`).get(draftId, draftVersion, configHash, metadataHash) as Record<string, unknown> | undefined;
      const parsed = parseObject(row?.decision_json); return parsed as unknown as DuplicateDecision | undefined;
    });
  }
  saveAnswer(draftId: string, draftVersion: number, metadataHash: string, fieldId: string, value: JiraSemanticAnswer): void {
    this.unitOfWork.transaction(({ sql }) => { sql.prepare(`INSERT INTO jira_field_answers(draft_id,draft_version,metadata_hash,field_id,semantic_value_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(draft_id,draft_version,metadata_hash,field_id) DO UPDATE SET semantic_value_json=excluded.semantic_value_json,updated_at=excluded.updated_at`).run(draftId, draftVersion, metadataHash, fieldId, JSON.stringify(value), this.now()); });
  }
  loadAnswers(draftId: string, draftVersion: number, metadataHash: string): Readonly<Record<string, JiraSemanticAnswer>> {
    return this.unitOfWork.transaction(({ sql }) => {
      const rows = sql.prepare(`SELECT field_id,semantic_value_json FROM jira_field_answers WHERE draft_id=? AND draft_version=? AND metadata_hash=?`).all(draftId, draftVersion, metadataHash) as readonly Record<string, unknown>[];
      const answers: Record<string, JiraSemanticAnswer> = {};
      for (const row of rows) { if (typeof row.field_id !== "string" || typeof row.semantic_value_json !== "string") continue; try { answers[row.field_id] = JSON.parse(row.semantic_value_json) as JiraSemanticAnswer; } catch { /* migration constraint only proves JSON syntax */ } }
      return Object.freeze(answers);
    });
  }
  confirm(preview: JiraPreview, actorId: string, chatId: string): JiraConfirmation {
    const value = Object.freeze({ id: this.newId(), actorId, chatId, draftId: preview.draftId, draftVersion: preview.draftVersion, metadataHash: preview.metadataHash, payloadHash: preview.payloadHash, confirmedAt: this.now() });
    this.unitOfWork.criticalTransaction(({ sql }) => { sql.prepare(`INSERT INTO jira_confirmations(id,actor_hash,chat_hash,draft_id,draft_version,metadata_hash,payload_hash,confirmed_at,consumed_at) VALUES(?,?,?,?,?,?,?,?,NULL)`).run(value.id, identityHash(actorId), identityHash(chatId), value.draftId, value.draftVersion, value.metadataHash, value.payloadHash, value.confirmedAt); });
    return value;
  }
  require(id: string, expected: Omit<JiraConfirmation, "id" | "confirmedAt">): DurableConfirmationBinding {
    return this.unitOfWork.transaction(({ sql }) => {
      const row = sql.prepare(`SELECT id,actor_hash,chat_hash,draft_id,draft_version,metadata_hash,payload_hash FROM jira_confirmations WHERE id=?`).get(id) as Record<string, unknown> | undefined;
      if (!row || row.actor_hash !== identityHash(expected.actorId) || row.chat_hash !== identityHash(expected.chatId) || row.draft_id !== expected.draftId || row.draft_version !== expected.draftVersion || row.metadata_hash !== expected.metadataHash || row.payload_hash !== expected.payloadHash) throw new Error("JIRA_CONFIRMATION_STALE");
      return Object.freeze({ id, actorHash: String(row.actor_hash), chatHash: String(row.chat_hash), draftId: expected.draftId, draftVersion: expected.draftVersion, metadataHash: expected.metadataHash, payloadHash: expected.payloadHash });
    });
  }
}
