import { createHash } from "node:crypto";

import type { VersionedDraft } from "../domain/draft.js";
import type { JiraCreateForm, JiraFieldMetadata, JiraFieldQuestion, JiraMetadataSnapshot, JiraSemanticAnswer } from "./types.js";

const MANAGED_SYSTEM_FIELDS = new Set(["project", "issuetype", "summary", "description"]);
const FORBIDDEN_SYSTEM_FIELDS = new Set(["assignee", "reporter", "status", "transition"]);
const SECRET_LIKE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:authorization\s*:\s*(?:bearer|basic)|password\s*=|github_pat_|ghp_[A-Za-z0-9]|xox[baprs]-|sk-[A-Za-z0-9]{16})/i;
function cleanText(value: unknown, maximum = 10_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return clean && clean.length <= maximum && !SECRET_LIKE.test(clean) ? clean : undefined;
}
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
export function jiraQuestionId(metadataHash: string, fieldId: string): string {
  return createHash("sha256").update(`${metadataHash}\u0000${fieldId}`).digest("hex");
}
function question(field: JiraFieldMetadata, metadataHash: string): JiraFieldQuestion | undefined {
  const questionId = jiraQuestionId(metadataHash, field.id);
  if (FORBIDDEN_SYSTEM_FIELDS.has(field.id) || FORBIDDEN_SYSTEM_FIELDS.has(field.schema.system ?? "")) return undefined;
  if (field.allowedValues.length > 0) {
    const multiple = field.schema.type === "array";
    return Object.freeze({ questionId, label: field.name, kind: multiple ? "multi-choice" : "single-choice", required: true, choices: Object.freeze(field.allowedValues.map((entry) => entry.label)) });
  }
  switch (field.schema.type) {
    case "string": return Object.freeze({ questionId, label: field.name, kind: "text", required: true });
    case "number": return Object.freeze({ questionId, label: field.name, kind: "number", required: true });
    case "date": return Object.freeze({ questionId, label: field.name, kind: "date", required: true });
    case "datetime": return Object.freeze({ questionId, label: field.name, kind: "datetime", required: true });
    default: return undefined;
  }
}
export function buildCreateForm(snapshot: JiraMetadataSnapshot): JiraCreateForm {
  const questions: JiraFieldQuestion[] = []; const defaults: string[] = []; const blockers: string[] = [];
  for (const field of Object.values(snapshot.fields)) {
    if (!field.required || MANAGED_SYSTEM_FIELDS.has(field.id) || MANAGED_SYSTEM_FIELDS.has(field.schema.system ?? "")) continue;
    if (field.hasDefaultValue) { defaults.push(field.name); continue; }
    const item = question(field, snapshot.hash);
    if (item) questions.push(item); else blockers.push(`UNSUPPORTED_REQUIRED_FIELD:${field.name}`);
  }
  questions.sort((a, b) => a.label.localeCompare(b.label) || a.questionId.localeCompare(b.questionId)); defaults.sort(); blockers.sort();
  return Object.freeze({ metadataHash: snapshot.hash, questions: Object.freeze(questions), defaults: Object.freeze(defaults), blockers: Object.freeze(blockers) });
}

function resolveOption(field: JiraFieldMetadata, label: string): Readonly<{ id: string }> | undefined {
  const matches = field.allowedValues.filter((entry) => entry.label.localeCompare(label, undefined, { sensitivity: "accent" }) === 0);
  return matches.length === 1 ? Object.freeze({ id: matches[0]!.id }) : undefined;
}
function answerValue(field: JiraFieldMetadata, answer: JiraSemanticAnswer): unknown | undefined {
  if (field.allowedValues.length > 0) {
    if (field.schema.type === "array") {
      if (!Array.isArray(answer) || answer.length < 1 || answer.length > 50) return undefined;
      const resolved = answer.map((item) => typeof item === "string" ? resolveOption(field, item) : undefined);
      return resolved.every(Boolean) ? resolved : undefined;
    }
    return typeof answer === "string" ? resolveOption(field, answer) : undefined;
  }
  if (field.schema.type === "number") return typeof answer === "number" && Number.isFinite(answer) ? answer : undefined;
  if (field.schema.type === "string") return cleanText(answer);
  if (field.schema.type === "date") return typeof answer === "string" && validDate(answer) ? answer : undefined;
  if (field.schema.type === "datetime") return typeof answer === "string" && /^\d{4}-\d{2}-\d{2}T/.test(answer) && !Number.isNaN(Date.parse(answer)) ? answer : undefined;
  return undefined;
}
export function isValidSemanticAnswer(field: JiraFieldMetadata, answer: JiraSemanticAnswer): boolean { return answerValue(field, answer) !== undefined; }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export interface JiraPayloadResult {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly canonicalJson: string;
  readonly hash: string;
  readonly displayFields: readonly Readonly<{ label: string; value: string }>[];
}
export function buildCanonicalPayload(
  draft: VersionedDraft,
  snapshot: JiraMetadataSnapshot,
  answers: Readonly<Record<string, JiraSemanticAnswer>>,
): JiraPayloadResult {
  const form = buildCreateForm(snapshot);
  if (snapshot.readiness !== "JIRA_CREATE_READY" || form.blockers.length) throw new Error("JIRA_CREATE_NOT_READY");
  const summary = cleanText(draft.content.summary.value, 255); const description = typeof draft.description === "string" && draft.description.trim() ? draft.description.slice(0, 30_000) : undefined;
  if (!summary || !description) throw new Error("JIRA_DRAFT_INVALID");
  const fields: Record<string, unknown> = {
    project: Object.freeze({ id: snapshot.project.id }), issuetype: Object.freeze({ id: snapshot.issueType.id }), summary, description,
  };
  const display: Array<Readonly<{ label: string; value: string }>> = [];
  for (const item of form.questions) {
    const metadata = Object.values(snapshot.fields).find((field) => jiraQuestionId(snapshot.hash, field.id) === item.questionId);
    const answer = metadata ? answers[metadata.id] : undefined;
    if (!metadata || answer === undefined) throw new Error("JIRA_REQUIRED_ANSWER_MISSING");
    const resolved = answerValue(metadata, answer);
    if (resolved === undefined) throw new Error("JIRA_REQUIRED_ANSWER_INVALID");
    fields[metadata.id] = resolved;
    display.push(Object.freeze({ label: item.label, value: Array.isArray(answer) ? answer.join(", ") : String(answer) }));
  }
  for (const supplied of Object.keys(answers)) if (!form.questions.some((item) => jiraQuestionId(snapshot.hash, supplied) === item.questionId)) throw new Error("JIRA_ANSWER_FIELD_NOT_ALLOWED");
  const canonicalJson = canonical(Object.freeze({ fields }));
  return Object.freeze({ fields: Object.freeze(fields), canonicalJson, hash: createHash("sha256").update(canonicalJson).digest("hex"), displayFields: Object.freeze(display) });
}
