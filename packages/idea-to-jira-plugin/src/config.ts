export interface IdeaToJiraConfig {
  jiraProjectKey: string;
  catalogPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePluginConfig(value: unknown): IdeaToJiraConfig {
  if (value === undefined) {
    return { jiraProjectKey: "FPF" };
  }
  if (!isRecord(value)) {
    throw new Error("idea-to-jira config must be an object");
  }

  const jiraProjectKey = value.jiraProjectKey ?? "FPF";
  if (typeof jiraProjectKey !== "string" || !/^[A-Z][A-Z0-9_]{1,19}$/.test(jiraProjectKey)) {
    throw new Error("jiraProjectKey must match ^[A-Z][A-Z0-9_]{1,19}$");
  }

  const catalogPath = value.catalogPath;
  if (catalogPath !== undefined && (typeof catalogPath !== "string" || !catalogPath.trim())) {
    throw new Error("catalogPath must be a non-empty string");
  }

  return {
    jiraProjectKey,
    ...(typeof catalogPath === "string" ? { catalogPath } : {}),
  };
}
