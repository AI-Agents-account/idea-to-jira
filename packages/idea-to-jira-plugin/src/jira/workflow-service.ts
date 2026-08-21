import type { EffectiveConfig } from "../config.js";
import type { VersionedDraft } from "../domain/draft.js";
import { classifyDuplicates } from "../duplicates/classifier.js";
import { createJiraPreview, JiraConfirmationStore, type JiraConfirmation, type JiraPreview } from "./confirmation.js";
import { buildCanonicalPayload, buildCreateForm, isValidSemanticAnswer, type JiraPayloadResult } from "./dynamic-fields.js";
import { JiraMetadataClient } from "./metadata-client.js";
import type { DurableConfirmationBinding, JiraWorkflowPersistence } from "./persistence.js";
import { JiraPostingService, type JiraPostingResult } from "./posting-service.js";
import { jiraSearchConfigHash, JiraSearchClient } from "./search-client.js";
import { JiraFailure, type DuplicateDecision, type JiraCreateForm, type JiraMetadataSnapshot, type JiraReadiness, type JiraSearchResult, type JiraSemanticAnswer } from "./types.js";

export interface JiraWorkflowStatus { readonly readiness: JiraReadiness; readonly metadataHash?: string; readonly blockers: readonly string[] }
export interface JiraPreparedPreview { readonly preview: JiraPreview; readonly payload: JiraPayloadResult; readonly duplicate: DuplicateDecision }
function draftKey(draft: Pick<VersionedDraft, "id" | "version">, metadataHash: string): string { return `${draft.id}\u0000${draft.version}\u0000${metadataHash}`; }

/** High-level, version-bound Jira MVP workflow. No method accepts URL, JQL, fields, HTTP paths, or arbitrary payload JSON. */
export class JiraWorkflowService {
  private statusValue: JiraWorkflowStatus = Object.freeze({ readiness: "JIRA_UNAVAILABLE", blockers: Object.freeze(["NOT_DISCOVERED"]) });
  private readonly decisions = new Map<string, DuplicateDecision>();
  private readonly answers = new Map<string, Readonly<Record<string, JiraSemanticAnswer>>>();
  private refreshTimer: NodeJS.Timeout | undefined;
  constructor(
    private readonly config: EffectiveConfig["jira"], private readonly metadata: JiraMetadataClient,
    private readonly searchClient: JiraSearchClient, private readonly posting: JiraPostingService,
    private readonly persistence?: JiraWorkflowPersistence,
    private readonly confirmations = new JiraConfirmationStore(),
  ) {}
  status(): JiraWorkflowStatus { return this.statusValue; }
  async start(): Promise<JiraWorkflowStatus> {
    const status = await this.discover();
    if (!this.refreshTimer && this.config.enabled && this.config.credentialAvailable) {
      this.refreshTimer = setInterval(() => { void this.discover(); }, this.config.metadata.refreshIntervalMinutes * 60_000);
      this.refreshTimer.unref();
    }
    return status;
  }
  stop(): void { if (this.refreshTimer) clearInterval(this.refreshTimer); this.refreshTimer = undefined; }
  async discover(): Promise<JiraWorkflowStatus> {
    if (!this.config.enabled || !this.config.credentialAvailable) {
      this.statusValue = Object.freeze({ readiness: "JIRA_UNAVAILABLE", blockers: Object.freeze([!this.config.enabled ? "JIRA_DISABLED" : "JIRA_CREDENTIAL_MISSING"]) }); return this.statusValue;
    }
    try {
      const snapshot = await this.metadata.refresh(); this.statusValue = Object.freeze({ readiness: snapshot.readiness, metadataHash: snapshot.hash, blockers: snapshot.blockers }); return this.statusValue;
    } catch (error) {
      const code = error instanceof JiraFailure ? error.code : "JIRA_NETWORK_ERROR";
      this.statusValue = Object.freeze({ readiness: "JIRA_UNAVAILABLE", blockers: Object.freeze([code]) }); return this.statusValue;
    }
  }
  recoverAfterRestart(): number { return this.posting.recoverInterrupted(); }
  async searchDuplicates(draft: VersionedDraft): Promise<{ readonly search: JiraSearchResult; readonly decision: DuplicateDecision }> {
    const snapshot = await this.readyMetadata("search"); const search = await this.searchClient.search(draft, snapshot); const decision = classifyDuplicates(draft, search);
    this.decisions.set(draftKey(draft, snapshot.hash), decision); this.persistence?.saveDecision(decision); return Object.freeze({ search, decision });
  }
  async form(draft: VersionedDraft): Promise<JiraCreateForm> { return buildCreateForm(await this.readyMetadata("create")); }
  async answerField(draft: VersionedDraft, fieldId: string, value: JiraSemanticAnswer): Promise<JiraCreateForm> {
    const snapshot = await this.readyMetadata("create"); const form = buildCreateForm(snapshot);
    if (!form.questions.some((question) => question.fieldId === fieldId)) throw new Error("JIRA_ANSWER_FIELD_NOT_ALLOWED");
    const field = snapshot.fields[fieldId]; if (!field || !isValidSemanticAnswer(field, value)) throw new Error("JIRA_REQUIRED_ANSWER_INVALID");
    const key = draftKey(draft, snapshot.hash); const existing = this.answers.get(key) ?? this.persistence?.loadAnswers(draft.id, draft.version, snapshot.hash) ?? {};
    this.answers.set(key, Object.freeze({ ...existing, [fieldId]: value })); this.persistence?.saveAnswer(draft.id, draft.version, snapshot.hash, fieldId, value);
    return form;
  }
  async preview(draft: VersionedDraft, allowBlockedDuplicate = false): Promise<JiraPreparedPreview> {
    const snapshot = await this.readyMetadata("create"); const key = draftKey(draft, snapshot.hash); const duplicate = this.decisions.get(key) ?? this.persistence?.loadDecision(draft.id, draft.version, jiraSearchConfigHash(this.config), snapshot.hash);
    if (!duplicate) throw new Error("JIRA_DUPLICATE_DECISION_REQUIRED");
    if (["DUPLICATE", "UNCERTAIN"].includes(duplicate.outcome) && !allowBlockedDuplicate) throw new Error("JIRA_DUPLICATE_USER_DECISION_REQUIRED");
    if (duplicate.binding.draftId !== draft.id || duplicate.binding.draftVersion !== draft.version || duplicate.binding.metadataHash !== snapshot.hash) throw new Error("JIRA_STALE_BINDING");
    const answers = this.answers.get(key) ?? this.persistence?.loadAnswers(draft.id, draft.version, snapshot.hash) ?? {};
    const payload = buildCanonicalPayload(draft, snapshot, answers); const preview = createJiraPreview(draft, snapshot, payload);
    return Object.freeze({ preview, payload, duplicate });
  }
  confirm(prepared: JiraPreparedPreview, actorId: string, chatId: string): JiraConfirmation { return this.persistence?.confirm(prepared.preview, actorId, chatId) ?? this.confirmations.confirm(prepared.preview, actorId, chatId); }
  async create(draft: VersionedDraft, actorId: string, chatId: string, confirmationId: string, allowBlockedDuplicate = false): Promise<JiraPostingResult> {
    const prepared = await this.preview(draft, allowBlockedDuplicate);
    let durableConfirmation: DurableConfirmationBinding | undefined;
    if (this.config.create.requireConfirmation) {
      const expected = { actorId, chatId, draftId: draft.id, draftVersion: draft.version, metadataHash: prepared.preview.metadataHash, payloadHash: prepared.payload.hash };
      durableConfirmation = this.persistence?.require(confirmationId, expected);
      if (!durableConfirmation) this.confirmations.require(confirmationId, expected);
    }
    return this.posting.create(draft.id, draft.version, prepared.payload.hash, prepared.payload.fields, durableConfirmation);
  }
  private async readyMetadata(operation: "search" | "create"): Promise<JiraMetadataSnapshot> {
    if (!this.config.enabled || !this.config.credentialAvailable) throw new JiraFailure(!this.config.enabled ? "JIRA_DISABLED" : "JIRA_CREDENTIAL_MISSING", true);
    const snapshot = await this.metadata.currentOrRefresh();
    if (snapshot.readiness === "JIRA_UNAVAILABLE" || (operation === "create" && snapshot.readiness !== "JIRA_CREATE_READY")) throw new Error(operation === "create" ? "JIRA_CREATE_NOT_READY" : "JIRA_SEARCH_NOT_READY");
    return snapshot;
  }
}
