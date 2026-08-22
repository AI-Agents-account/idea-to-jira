import { readFile } from "node:fs/promises";

const manifestCandidates = [
  process.env.IDEA_TO_JIRA_PLUGIN_MANIFEST,
  process.env.IDEA_TO_JIRA_PLUGIN_PATH ? `${process.env.IDEA_TO_JIRA_PLUGIN_PATH}/openclaw.plugin.json` : "/opt/openclaw-plugins/idea-to-jira/openclaw.plugin.json",
  new URL("../packages/idea-to-jira-plugin/openclaw.plugin.json", import.meta.url),
].filter(Boolean);
let manifest;
for (const candidate of manifestCandidates) {
  try { manifest = JSON.parse(await readFile(candidate, "utf8")); break; } catch { /* bounded candidate list */ }
}
const jira = manifest?.configSchema?.properties?.jira;
const confirmation = jira?.properties?.create?.properties?.requireConfirmation?.const;
const tools = manifest?.contracts?.tools;
const requiredTools = ["idea_to_jira_search_duplicates", "idea_to_jira_preview_issue", "idea_to_jira_confirm_issue", "idea_to_jira_create_issue"];
if (manifest?.id !== "idea-to-jira" || confirmation !== true || !Array.isArray(tools) || requiredTools.some((tool) => !tools.includes(tool))) {
  console.error("create-readiness status=invalid code=CREATE_GATE_INVALID");
  process.exit(2);
}
console.log("create-readiness status=contract-ready code=RUNTIME_DISCOVERY_REQUIRED");
process.exit(process.argv.includes("--verify-contract") ? 0 : 1);
