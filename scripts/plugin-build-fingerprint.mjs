#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inputs = [
  "package.json",
  "package-lock.json",
  "packages/idea-to-jira-plugin/package.json",
  "packages/idea-to-jira-plugin/openclaw.plugin.json",
  "packages/idea-to-jira-plugin/src",
];

function filesUnder(path) {
  const absolute = resolve(repositoryRoot, path);
  const metadata = statSync(absolute);
  if (metadata.isFile()) return [absolute];
  if (!metadata.isDirectory()) throw new Error(`unsupported fingerprint input: ${path}`);
  return readdirSync(absolute, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => filesUnder(resolve(path, entry.name)));
}

const files = inputs.flatMap(filesUnder).sort((left, right) => left.localeCompare(right));
const hash = createHash("sha256");
for (const file of files) {
  const portablePath = relative(repositoryRoot, file).split(sep).join("/");
  hash.update(portablePath, "utf8");
  hash.update("\0", "utf8");
  hash.update(readFileSync(file));
  hash.update("\0", "utf8");
}
process.stdout.write(`${hash.digest("hex")}\n`);
