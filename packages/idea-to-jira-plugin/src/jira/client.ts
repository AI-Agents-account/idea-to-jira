import type { JiraIssueDraft } from "../domain/idea.js";

export interface JiraCreateResult {
  key: string;
  url: string;
}

export interface JiraIssueClient {
  createIssue(draft: JiraIssueDraft): Promise<JiraCreateResult>;
}

/** Explicit fail-closed adapter until the Jira create and reconciliation pipeline is implemented. */
export class DisabledJiraIssueClient implements JiraIssueClient {
  async createIssue(_draft: JiraIssueDraft): Promise<JiraCreateResult> {
    throw new Error("Jira writes are disabled in the scaffold");
  }
}
