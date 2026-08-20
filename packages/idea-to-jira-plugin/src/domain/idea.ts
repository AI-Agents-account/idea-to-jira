export interface IdeaInput {
  summary: string;
  problem: string;
  desiredOutcome: string;
  evidence?: readonly string[];
  labels?: readonly string[];
}

export interface JiraIssueDraft {
  status: "ready";
  projectKey: string;
  issueType: "Feature";
  summary: string;
  description: string;
  labels: string[];
}
