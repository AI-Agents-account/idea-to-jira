import { createHash, randomUUID } from "node:crypto";

import type { VersionedDraft } from "../domain/draft.js";
import type { JiraMetadataSnapshot } from "./types.js";
import type { JiraPayloadResult } from "./dynamic-fields.js";

export interface JiraPreview {
  readonly draftId: string;
  readonly draftVersion: number;
  readonly metadataHash: string;
  readonly payloadHash: string;
  /** Binds payload plus the exact duplicate decision and override shown for confirmation. */
  readonly bindingHash: string;
  readonly text: string;
}
export interface JiraConfirmation {
  readonly id: string;
  readonly draftId: string;
  readonly draftVersion: number;
  readonly metadataHash: string;
  readonly bindingHash: string;
  readonly confirmedAt: string;
}
export interface JiraConfirmationExpectation {
  readonly actorId: string;
  readonly chatId: string;
  readonly draftId: string;
  readonly draftVersion: number;
  readonly metadataHash: string;
  readonly bindingHash: string;
}
interface StoredJiraConfirmation extends JiraConfirmation { readonly actorId: string; readonly chatId: string }
function bounded(value: string, maximum: number): string {
  if (Buffer.byteLength(value) <= maximum) return value;
  let result = value;
  while (result && Buffer.byteLength(`${result}…`) > maximum) result = result.slice(0, -1);
  return `${result}…`;
}
export function createJiraPreview(
  draft: VersionedDraft,
  metadata: JiraMetadataSnapshot,
  payload: JiraPayloadResult,
  maximumBytes = 16_384,
  confirmationContext = payload.hash,
  warningLines: readonly string[] = [],
): JiraPreview {
  if (payload.hash.length !== 64 || metadata.hash.length !== 64) throw new Error("JIRA_PREVIEW_INVALID");
  const content = [
    `Project: ${metadata.project.key} (${metadata.project.name})`, `Issue type: ${metadata.issueType.name}`,
    ...warningLines,
    `Summary: ${String(payload.fields.summary)}`, "Description:", String(payload.fields.description),
    ...payload.displayFields.map((item) => `${item.label}: ${item.value}`),
  ].join("\n");
  const bindingHash = createHash("sha256").update(`${draft.id}\u0000${draft.version}\u0000${metadata.hash}\u0000${payload.hash}\u0000${confirmationContext}`).digest("hex");
  return Object.freeze({ draftId: draft.id, draftVersion: draft.version, metadataHash: metadata.hash, payloadHash: payload.hash, bindingHash, text: bounded(content, maximumBytes) });
}
export class JiraConfirmationStore {
  private readonly values = new Map<string, StoredJiraConfirmation>();
  constructor(private readonly now: () => string = () => new Date().toISOString(), private readonly newId: () => string = randomUUID) {}
  confirm(preview: JiraPreview, actorId: string, chatId: string): JiraConfirmation {
    if (!actorId || !chatId) throw new Error("JIRA_CONFIRMATION_INVALID");
    const stored = Object.freeze({ id: this.newId(), actorId, chatId, draftId: preview.draftId, draftVersion: preview.draftVersion, metadataHash: preview.metadataHash, bindingHash: preview.bindingHash, confirmedAt: this.now() });
    this.values.set(stored.id, stored);
    return Object.freeze({ id: stored.id, draftId: stored.draftId, draftVersion: stored.draftVersion, metadataHash: stored.metadataHash, bindingHash: stored.bindingHash, confirmedAt: stored.confirmedAt });
  }
  require(id: string, expected: JiraConfirmationExpectation): JiraConfirmation {
    const value = this.values.get(id);
    if (!value || value.actorId !== expected.actorId || value.chatId !== expected.chatId || value.draftId !== expected.draftId || value.draftVersion !== expected.draftVersion || value.metadataHash !== expected.metadataHash || value.bindingHash !== expected.bindingHash) throw new Error("JIRA_CONFIRMATION_STALE");
    return Object.freeze({ id: value.id, draftId: value.draftId, draftVersion: value.draftVersion, metadataHash: value.metadataHash, bindingHash: value.bindingHash, confirmedAt: value.confirmedAt });
  }
}
