import type { VersionedDraft } from "../domain/draft.js";

export interface JiraCreateResult {
  key: string;
  url: string;
}

export interface JiraIssueClient {
  createIssue(draft: VersionedDraft): Promise<JiraCreateResult>;
}

/** Explicit fail-closed adapter until the Jira create and reconciliation pipeline is implemented. */
export class DisabledJiraIssueClient implements JiraIssueClient {
  async createIssue(_draft: VersionedDraft): Promise<JiraCreateResult> {
    throw new Error("Jira writes are disabled in the scaffold");
  }
}
