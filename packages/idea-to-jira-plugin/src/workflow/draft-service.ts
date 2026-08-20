import type { IdeaToJiraConfig } from "../config.js";
import type { IdeaInput, JiraIssueDraft } from "../domain/idea.js";

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} must not be empty`);
  }
  return normalized;
}

function unique(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

export class IdeaToJiraDraftService {
  constructor(private readonly config: IdeaToJiraConfig) {}

  createDraft(input: IdeaInput): JiraIssueDraft {
    const summary = required(input.summary, "summary");
    const problem = required(input.problem, "problem");
    const desiredOutcome = required(input.desiredOutcome, "desiredOutcome");
    const evidence = unique(input.evidence);
    const description = [
      "## Problem",
      problem,
      "",
      "## Desired outcome",
      desiredOutcome,
      ...(evidence.length > 0
        ? ["", "## Evidence", ...evidence.map((item) => `- ${item}`)]
        : []),
    ].join("\n");

    return {
      status: "ready",
      projectKey: this.config.jiraProjectKey,
      issueType: "Feature",
      summary,
      description,
      labels: unique(input.labels),
    };
  }
}
