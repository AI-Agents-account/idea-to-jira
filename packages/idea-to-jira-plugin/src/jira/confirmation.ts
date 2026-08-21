import { randomUUID } from "node:crypto";

import type { VersionedDraft } from "../domain/draft.js";
import type { JiraMetadataSnapshot } from "./types.js";
import type { JiraPayloadResult } from "./dynamic-fields.js";

export interface JiraPreview {
  readonly draftId: string;
  readonly draftVersion: number;
  readonly metadataHash: string;
  readonly payloadHash: string;
  readonly text: string;
}
export interface JiraConfirmation {
  readonly id: string;
  readonly actorId: string;
  readonly chatId: string;
  readonly draftId: string;
  readonly draftVersion: number;
  readonly metadataHash: string;
  readonly payloadHash: string;
  readonly confirmedAt: string;
}
function bounded(value: string, maximum: number): string {
  if (Buffer.byteLength(value) <= maximum) return value;
  let result = value;
  while (result && Buffer.byteLength(`${result}…`) > maximum) result = result.slice(0, -1);
  return `${result}…`;
}
export function createJiraPreview(draft: VersionedDraft, metadata: JiraMetadataSnapshot, payload: JiraPayloadResult, maximumBytes = 16_384): JiraPreview {
  if (payload.hash.length !== 64 || metadata.hash.length !== 64) throw new Error("JIRA_PREVIEW_INVALID");
  const content = [
    `Project: ${metadata.project.key} (${metadata.project.name})`, `Issue type: ${metadata.issueType.name}`,
    `Summary: ${String(payload.fields.summary)}`, "Description:", String(payload.fields.description),
    ...payload.displayFields.map((item) => `${item.label}: ${item.value}`),
  ].join("\n");
  return Object.freeze({ draftId: draft.id, draftVersion: draft.version, metadataHash: metadata.hash, payloadHash: payload.hash, text: bounded(content, maximumBytes) });
}
export class JiraConfirmationStore {
  private readonly values = new Map<string, JiraConfirmation>();
  constructor(private readonly now: () => string = () => new Date().toISOString(), private readonly newId: () => string = randomUUID) {}
  confirm(preview: JiraPreview, actorId: string, chatId: string): JiraConfirmation {
    if (!actorId || !chatId) throw new Error("JIRA_CONFIRMATION_INVALID");
    const confirmation = Object.freeze({ id: this.newId(), actorId, chatId, draftId: preview.draftId, draftVersion: preview.draftVersion, metadataHash: preview.metadataHash, payloadHash: preview.payloadHash, confirmedAt: this.now() });
    this.values.set(confirmation.id, confirmation); return confirmation;
  }
  require(id: string, expected: Omit<JiraConfirmation, "id" | "confirmedAt">): JiraConfirmation {
    const value = this.values.get(id);
    if (!value || value.actorId !== expected.actorId || value.chatId !== expected.chatId || value.draftId !== expected.draftId || value.draftVersion !== expected.draftVersion || value.metadataHash !== expected.metadataHash || value.payloadHash !== expected.payloadHash) throw new Error("JIRA_CONFIRMATION_STALE");
    return value;
  }
}
