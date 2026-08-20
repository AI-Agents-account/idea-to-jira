import assert from "node:assert/strict";
import test from "node:test";
import { IdeaToJiraDraftService } from "../src/workflow/draft-service.js";

test("creates a deterministic validated Jira Feature draft", () => {
  const service = new IdeaToJiraDraftService({ jiraProjectKey: "FPF" });

  const draft = service.createDraft({
    summary: "Reduce onboarding friction",
    problem: "New users cannot find the import action.",
    desiredOutcome: "Make the first import discoverable.",
    evidence: ["Three usability sessions", "Three usability sessions"],
    labels: ["discovery", " discovery "],
  });

  assert.equal(draft.status, "ready");
  assert.equal(draft.projectKey, "FPF");
  assert.equal(draft.issueType, "Feature");
  assert.deepEqual(draft.labels, ["discovery"]);
  assert.match(draft.description, /## Evidence/);
});

test("rejects an incomplete draft", () => {
  const service = new IdeaToJiraDraftService({ jiraProjectKey: "FPF" });

  assert.throws(
    () =>
      service.createDraft({
        summary: "  ",
        problem: "Example problem",
        desiredOutcome: "Example outcome",
      }),
    /summary must not be empty/,
  );
});
