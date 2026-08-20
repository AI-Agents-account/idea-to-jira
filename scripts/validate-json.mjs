import { readFile } from "node:fs/promises";

const files = [
  "package.json",
  "packages/idea-to-jira-plugin/package.json",
  "packages/idea-to-jira-plugin/openclaw.plugin.json",
  "packages/idea-to-jira-plugin/tsconfig.json",
  "tests/fixtures/idea.example.json",
];

for (const file of files) {
  JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
  console.log(`valid JSON: ${file}`);
}
