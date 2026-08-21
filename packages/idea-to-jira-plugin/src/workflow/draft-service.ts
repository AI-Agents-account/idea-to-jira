import { createHash, randomUUID } from "node:crypto";

import { createAuditEvent, hashAuditActorReference, SqliteAuditWriter } from "../audit/index.js";
import {
  applyDraftPatch,
  contentCompleteness,
  createDraftContent,
  draftContentEquals,
  type CancelDraftInput,
  type CompletenessResult,
  type CreateDraftInput,
  type DraftContent,
  type DraftDependencies,
  type PatchDraftInput,
  type ReadinessResult,
  type VersionedDraft,
} from "../domain/draft.js";
import {
  DRAFT_SCHEMA_VERSION,
  DESCRIPTION_FORMATTER_VERSION,
  canEditDraft,
  type DraftState,
} from "../domain/draft-state.js";
import {
  BLOCKED_READINESS_PROOFS,
  evaluateReadiness,
  type ReadinessProofs,
} from "../domain/readiness.js";
import { SafeError } from "../errors/index.js";
import type { TrustedRequesterContext } from "../runtime/requester-context.js";
import { SqliteDraftRepository, type DraftHeadRow } from "../storage/draft-repository.js";
import type { StorageUnitOfWork } from "../storage/repository.js";
import { formatDescription } from "./description-formatter.js";
import { selectDraftQuestions, type DraftQuestion } from "./question-policy.js";

export interface DraftServiceOptions {
  readonly unitOfWork: StorageUnitOfWork;
  readonly maxActiveDrafts?: number;
  readonly repository?: SqliteDraftRepository;
  readonly auditWriter?: SqliteAuditWriter;
  readonly now?: () => string;
  readonly newId?: () => string;
}

export interface DraftServiceResult {
  readonly draft: VersionedDraft;
  readonly questions: readonly DraftQuestion[];
}

export class DraftVersionConflict extends SafeError {
  readonly currentVersion: number;

  constructor(currentVersion: number) {
    super("DRAFT_CONFLICT", true);
    this.currentVersion = currentVersion;
  }

  override toJSON(): ReturnType<SafeError["toJSON"]> & { readonly currentVersion: number } {
    return Object.freeze({ ...super.toJSON(), currentVersion: this.currentVersion });
  }
}

function parseObject<T>(raw: string): T {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value as T;
  } catch (error) {
    throw new SafeError("DRAFT_INVALID", false, { cause: error });
  }
}

function contentHash(content: DraftContent): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

function dependentResultFingerprint(content: DraftContent): string {
  const values = Object.fromEntries(Object.entries(content).map(([field, value]) => [field, {
    value: value.value,
    actionable: value.provenance === "USER_STATED" ||
      value.provenance === "USER_CONFIRMED" || value.provenance === "CATALOG_DERIVED",
  }]));
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

function initialDependencies(): DraftDependencies {
  return Object.freeze({
    catalog: null,
    transcript: Object.freeze({ state: "NOT_REQUIRED" }),
    duplicate: null,
    posting: null,
    payloadHashRef: null,
    invalidatedByVersion: null,
    blockingPriorOperations: Object.freeze([]),
  });
}

function stringValue(content: DraftContent, field: "summary" | "context" | "goalProblemOpportunity"): string {
  const value = content[field].value;
  if (value === null) throw new SafeError("DRAFT_INVALID", false);
  return value;
}

function evidenceJson(content: DraftContent): string {
  const values = content.successMetrics.value;
  return JSON.stringify(values ?? []);
}

function validateDraftId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new SafeError("DRAFT_INVALID", false);
}

export class IdeaToJiraDraftService {
  private readonly repository: SqliteDraftRepository;
  private readonly audit: SqliteAuditWriter;
  private readonly maxActiveDrafts: number;
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(private readonly options: DraftServiceOptions) {
    this.repository = options.repository ?? new SqliteDraftRepository();
    this.audit = options.auditWriter ?? new SqliteAuditWriter();
    this.maxActiveDrafts = options.maxActiveDrafts ?? 3;
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? randomUUID;
    if (!Number.isSafeInteger(this.maxActiveDrafts) || this.maxActiveDrafts < 1 || this.maxActiveDrafts > 100) {
      throw new Error("CONFIG_INVALID");
    }
  }

  createDraft(requester: TrustedRequesterContext, input: CreateDraftInput): DraftServiceResult {
    const content = createDraftContent(input);
    const completeness = contentCompleteness(content);
    const description = formatDescription(content);
    const dependencies = initialDependencies();
    const readiness = evaluateReadiness(1, completeness, description, dependencies, BLOCKED_READINESS_PROOFS);
    const draftId = this.newId();
    validateDraftId(draftId);
    const occurredAt = this.now();

    const row = this.options.unitOfWork.criticalTransaction(({ sql }) => {
      const ownerUserId = this.repository.findOwnerUserId(sql, requester.senderId);
      if (!ownerUserId) throw new SafeError("ACCESS_DENIED", false);
      if (this.repository.countActiveOwned(sql, requester.senderId) >= this.maxActiveDrafts) {
        throw new SafeError("DRAFT_LIMIT_REACHED", false);
      }
      this.repository.insertDraft(sql, draftId, ownerUserId, occurredAt);
      this.repository.insertVersion(sql, {
        draftId,
        version: 1,
        summary: stringValue(content, "summary"),
        problem: stringValue(content, "context"),
        desiredOutcome: stringValue(content, "goalProblemOpportunity"),
        evidenceJson: evidenceJson(content),
        provenanceHash: contentHash(content),
        content,
        description,
        completeness,
        readiness,
        dependencies,
        createdAt: occurredAt,
      });
      this.audit.append(sql, createAuditEvent({
        occurredAt,
        actor: {
          kind: "USER",
          userId: ownerUserId,
          refHash: hashAuditActorReference(requester.accountId, requester.senderId),
        },
        action: "DRAFT_TRANSITION",
        target: { type: "DRAFT", id: draftId },
        outcome: "SUCCEEDED",
        code: "DRAFT_CREATED",
        links: { draftId, draftVersion: 1 },
        retentionClass: "DRAFT_90D",
      }));
      const created = this.repository.findOwnedHead(sql, draftId, requester.senderId);
      if (!created) throw new SafeError("DRAFT_INVALID", false);
      return created;
    });
    return this.result(row);
  }

  readDraft(requester: TrustedRequesterContext, draftId: string): DraftServiceResult {
    validateDraftId(draftId);
    const row = this.options.unitOfWork.transaction(({ sql }) =>
      this.repository.findOwnedHead(sql, draftId, requester.senderId));
    if (!row) throw new SafeError("DRAFT_NOT_FOUND", false);
    return this.result(row);
  }

  patchDraft(
    requester: TrustedRequesterContext,
    input: PatchDraftInput,
    proofs: ReadinessProofs = BLOCKED_READINESS_PROOFS,
  ): DraftServiceResult {
    validateDraftId(input.draftId);
    return this.options.unitOfWork.criticalTransaction(({ sql }) => {
      const current = this.repository.findOwnedHead(sql, input.draftId, requester.senderId);
      if (!current) throw new SafeError("DRAFT_NOT_FOUND", false);
      if (current.head_version !== input.expectedVersion) throw new DraftVersionConflict(current.head_version);
      if (!canEditDraft(current.state)) throw new SafeError("DRAFT_STATE_INVALID", false);
      const currentContent = parseObject<DraftContent>(current.domain_json);
      let nextContent: DraftContent;
      try {
        nextContent = applyDraftPatch(currentContent, input);
      } catch (error) {
        throw new SafeError("DRAFT_INVALID", false, { cause: error });
      }
      if (draftContentEquals(currentContent, nextContent)) return this.result(current);

      const nextVersion = current.head_version + 1;
      const completeness = contentCompleteness(nextContent);
      const description = formatDescription(nextContent);
      const previousDependencies = parseObject<DraftDependencies>(current.dependencies_json);
      const significant = dependentResultFingerprint(currentContent) !== dependentResultFingerprint(nextContent);
      if (significant) {
        this.repository.invalidateUnstartedOperation(sql, current.id, this.now());
      }
      const dependencies: DraftDependencies = significant
        ? Object.freeze({
            catalog: null,
            transcript: previousDependencies.transcript,
            duplicate: null,
            posting: null,
            payloadHashRef: null,
            invalidatedByVersion: current.head_version,
            blockingPriorOperations: this.repository.blockingPriorOperations(sql, current.id),
          })
        : Object.freeze({
            ...previousDependencies,
            blockingPriorOperations: this.repository.blockingPriorOperations(sql, current.id),
          });
      const readiness = evaluateReadiness(nextVersion, completeness, description, dependencies, proofs);
      const state: DraftState = readiness.ready ? "READY" : "EDITING";
      const occurredAt = this.now();
      this.repository.insertVersion(sql, {
        draftId: current.id,
        version: nextVersion,
        summary: stringValue(nextContent, "summary"),
        problem: stringValue(nextContent, "context"),
        desiredOutcome: stringValue(nextContent, "goalProblemOpportunity"),
        evidenceJson: evidenceJson(nextContent),
        provenanceHash: contentHash(nextContent),
        content: nextContent,
        description,
        completeness,
        readiness,
        dependencies,
        createdAt: occurredAt,
      });
      if (!this.repository.advanceHead(
        sql,
        current.id,
        requester.senderId,
        current.head_version,
        nextVersion,
        state,
        occurredAt,
      )) throw new DraftVersionConflict(current.head_version);
      this.audit.append(sql, createAuditEvent({
        occurredAt,
        actor: {
          kind: "USER",
          userId: current.owner_user_id,
          refHash: hashAuditActorReference(requester.accountId, requester.senderId),
        },
        action: "DRAFT_TRANSITION",
        target: { type: "DRAFT", id: current.id },
        outcome: "SUCCEEDED",
        code: "DRAFT_PATCHED",
        links: { draftId: current.id, draftVersion: nextVersion },
        retentionClass: "DRAFT_90D",
      }));
      const updated = this.repository.findOwnedHead(sql, current.id, requester.senderId);
      if (!updated) throw new SafeError("DRAFT_INVALID", false);
      return this.result(updated);
    });
  }

  cancelDraft(requester: TrustedRequesterContext, input: CancelDraftInput): DraftServiceResult {
    validateDraftId(input.draftId);
    return this.options.unitOfWork.criticalTransaction(({ sql }) => {
      const current = this.repository.findOwnedHead(sql, input.draftId, requester.senderId);
      if (!current) throw new SafeError("DRAFT_NOT_FOUND", false);
      if (current.head_version !== input.expectedVersion) throw new DraftVersionConflict(current.head_version);
      if (!canEditDraft(current.state)) throw new SafeError("DRAFT_STATE_INVALID", false);
      const content = parseObject<DraftContent>(current.domain_json);
      const completeness = parseObject<CompletenessResult>(current.completeness_json);
      const dependencies: DraftDependencies = Object.freeze({
        ...parseObject<DraftDependencies>(current.dependencies_json),
        blockingPriorOperations: this.repository.blockingPriorOperations(sql, current.id),
      });
      const readiness: ReadinessResult = Object.freeze({
        ready: false,
        reasons: Object.freeze([{ code: "DRAFT_CANCELLED", disposition: "BLOCKED" as const }]),
      });
      const nextVersion = current.head_version + 1;
      const occurredAt = this.now();
      this.repository.invalidateUnstartedOperation(sql, current.id, occurredAt);
      this.repository.insertVersion(sql, {
        draftId: current.id,
        version: nextVersion,
        summary: stringValue(content, "summary"),
        problem: stringValue(content, "context"),
        desiredOutcome: stringValue(content, "goalProblemOpportunity"),
        evidenceJson: evidenceJson(content),
        provenanceHash: contentHash(content),
        content,
        description: current.description,
        completeness,
        readiness,
        dependencies,
        createdAt: occurredAt,
      });
      if (!this.repository.advanceHead(
        sql,
        current.id,
        requester.senderId,
        current.head_version,
        nextVersion,
        "CANCELLED",
        occurredAt,
      )) throw new DraftVersionConflict(current.head_version);
      this.audit.append(sql, createAuditEvent({
        occurredAt,
        actor: {
          kind: "USER",
          userId: current.owner_user_id,
          refHash: hashAuditActorReference(requester.accountId, requester.senderId),
        },
        action: "DRAFT_TRANSITION",
        target: { type: "DRAFT", id: current.id },
        outcome: "SUCCEEDED",
        code: "DRAFT_CANCELLED",
        links: { draftId: current.id, draftVersion: nextVersion },
        retentionClass: "DRAFT_90D",
      }));
      const updated = this.repository.findOwnedHead(sql, current.id, requester.senderId);
      if (!updated) throw new SafeError("DRAFT_INVALID", false);
      return this.result(updated);
    });
  }

  private result(row: DraftHeadRow): DraftServiceResult {
    const draft: VersionedDraft = Object.freeze({
      id: row.id,
      state: row.state,
      version: row.head_version,
      schemaVersion: DRAFT_SCHEMA_VERSION,
      formatterVersion: DESCRIPTION_FORMATTER_VERSION,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      content: parseObject<DraftContent>(row.domain_json),
      description: row.description,
      completeness: parseObject<CompletenessResult>(row.completeness_json),
      readiness: parseObject<ReadinessResult>(row.readiness_json),
      dependencies: parseObject<DraftDependencies>(row.dependencies_json),
    });
    return Object.freeze({ draft, questions: selectDraftQuestions(draft.content) });
  }
}
