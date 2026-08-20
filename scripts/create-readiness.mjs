import { readFile } from "node:fs/promises";

const manifestCandidates = [
  process.env.IDEA_TO_JIRA_PLUGIN_MANIFEST,
  "/app/extensions/idea-to-jira-plugin/openclaw.plugin.json",
  new URL("../packages/idea-to-jira-plugin/openclaw.plugin.json", import.meta.url),
].filter(Boolean);

let manifest;
for (const candidate of manifestCandidates) {
  try {
    manifest = JSON.parse(await readFile(candidate, "utf8"));
    break;
  } catch {
    // Try the next known deployment/local path. Never print paths or file contents.
  }
}

const writeMode = manifest?.configSchema?.properties?.jira?.properties?.writeMode?.const;
if (manifest?.id !== "idea-to-jira" || writeMode !== "disabled") {
  console.error("create-readiness status=invalid code=CREATE_GATE_INVALID");
  process.exit(2);
}

console.log("create-readiness status=not-ready code=CREATE_DISABLED");
process.exit(process.argv.includes("--expect-disabled") ? 0 : 1);
