import {
  definePluginEntry,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { parsePluginConfig } from "./config.js";
import type { IdeaInput } from "./domain/idea.js";
import { IdeaToJiraDraftService } from "./workflow/draft-service.js";

function parseIdeaInput(value: unknown): IdeaInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("tool input must be an object");
  }
  const input = value as Record<string, unknown>;
  for (const field of ["summary", "problem", "desiredOutcome"] as const) {
    if (typeof input[field] !== "string") {
      throw new Error(`${field} must be a string`);
    }
  }
  for (const field of ["evidence", "labels"] as const) {
    if (
      input[field] !== undefined &&
      (!Array.isArray(input[field]) || input[field].some((item) => typeof item !== "string"))
    ) {
      throw new Error(`${field} must be an array of strings`);
    }
  }

  return {
    summary: input.summary as string,
    problem: input.problem as string,
    desiredOutcome: input.desiredOutcome as string,
    ...(Array.isArray(input.evidence) ? { evidence: input.evidence as string[] } : {}),
    ...(Array.isArray(input.labels) ? { labels: input.labels as string[] } : {}),
  };
}

const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: "idea-to-jira",
  name: "Idea to Jira",
  description: "Supports idea intake, duplicate search and Jira Feature creation.",
  register(api) {
    const service = new IdeaToJiraDraftService(parsePluginConfig(api.pluginConfig));

    api.registerTool({
      label: "Validate Jira Feature draft",
      name: "idea_to_jira_validate_draft",
      description:
        "Validate and normalize a structured Jira Feature draft before duplicate search and creation.",
      parameters: Type.Object(
        {
          summary: Type.String({ minLength: 1 }),
          problem: Type.String({ minLength: 1 }),
          desiredOutcome: Type.String({ minLength: 1 }),
          evidence: Type.Optional(Type.Array(Type.String())),
          labels: Type.Optional(Type.Array(Type.String())),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        const draft = service.createDraft(parseIdeaInput(params));
        return {
          content: [{ type: "text", text: JSON.stringify(draft, null, 2) }],
          details: draft,
        };
      },
    });
  },
});

export default plugin;
