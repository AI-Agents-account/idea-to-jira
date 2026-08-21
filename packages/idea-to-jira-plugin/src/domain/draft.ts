import type { DraftState } from "./draft-state.js";
import {
  applyProvenanceTransition,
  confirmProposedValue,
  provenancedValue,
  unknownValue,
  type PatchProvenance,
  type ProvenancedValue,
} from "./provenance.js";

export const DRAFT_FIELD_NAMES = Object.freeze([
  "summary",
  "context",
  "goalProblemOpportunity",
  "targetAudience",
  "proposedSolution",
  "acceptanceCriteria",
  "successMetrics",
  "risksConstraintsDependencies",
  "additionalDetails",
  "links",
  "marketingRequired",
  "categoryId",
  "moscowId",
  "impactedMetricIds",
  "routeCandidates",
  "selectedRouteId",
] as const);

export type DraftFieldName = (typeof DRAFT_FIELD_NAMES)[number];
export type DraftTextFieldName = Extract<DraftFieldName,
  | "summary"
  | "context"
  | "goalProblemOpportunity"
  | "targetAudience"
  | "proposedSolution"
  | "marketingRequired"
  | "categoryId"
  | "moscowId"
  | "selectedRouteId"
>;
export type DraftListFieldName = Exclude<DraftFieldName, DraftTextFieldName>;

export interface DraftContent {
  readonly summary: ProvenancedValue<string>;
  readonly context: ProvenancedValue<string>;
  readonly goalProblemOpportunity: ProvenancedValue<string>;
  readonly targetAudience: ProvenancedValue<string>;
  readonly proposedSolution: ProvenancedValue<string>;
  readonly acceptanceCriteria: ProvenancedValue<readonly string[]>;
  readonly successMetrics: ProvenancedValue<readonly string[]>;
  readonly risksConstraintsDependencies: ProvenancedValue<readonly string[]>;
  readonly additionalDetails: ProvenancedValue<readonly string[]>;
  readonly links: ProvenancedValue<readonly string[]>;
  readonly marketingRequired: ProvenancedValue<string>;
  readonly categoryId: ProvenancedValue<string>;
  readonly moscowId: ProvenancedValue<string>;
  readonly impactedMetricIds: ProvenancedValue<readonly string[]>;
  readonly routeCandidates: ProvenancedValue<readonly string[]>;
  readonly selectedRouteId: ProvenancedValue<string>;
}

export interface CatalogReference {
  readonly version: number;
  readonly checksum: string;
}

export type TranscriptState = "NOT_REQUIRED" | "PENDING_CONFIRMATION" | "CONFIRMED" | "FAILED";

export interface TranscriptReference {
  readonly state: TranscriptState;
  /** Immutable Draft version whose source voice/transcript was reviewed. */
  readonly draftVersion?: number;
  readonly transcriptRef?: string;
}

export interface DuplicateReference {
  readonly checkId: string;
  readonly draftVersion: number;
  readonly catalogVersion: number;
  readonly fingerprint: string;
  readonly state: "PENDING" | "NO_CANDIDATES" | "CANDIDATES" | "DECIDED" | "FAILED" | "EXPIRED";
  readonly decision?: "DUPLICATE_SELECTED" | "NOT_DUPLICATE" | "NO_CANDIDATES" | "NEEDS_CLARIFICATION";
}

export interface PostingReference {
  readonly operationId: string;
  readonly draftVersion: number;
  readonly payloadHash: string;
  readonly state:
    | "PENDING"
    | "POSTING"
    | "CREATED"
    | "FAILED_RETRYABLE"
    | "FAILED_FINAL"
    | "UNKNOWN"
    | "MANUAL_RESOLUTION_REQUIRED";
}

export interface DraftDependencies {
  readonly catalog: CatalogReference | null;
  readonly transcript: TranscriptReference;
  readonly duplicate: DuplicateReference | null;
  readonly posting: PostingReference | null;
  readonly payloadHashRef: string | null;
  readonly invalidatedByVersion: number | null;
  readonly blockingPriorOperations: readonly PostingReference[];
}

export interface CompletenessResult {
  readonly complete: boolean;
  readonly reasons: readonly string[];
}

export interface ReadinessReason {
  readonly code: string;
  readonly disposition: "MISSING" | "BLOCKED";
}

export interface ReadinessResult {
  readonly ready: boolean;
  readonly reasons: readonly ReadinessReason[];
}

export interface VersionedDraft {
  readonly id: string;
  readonly state: DraftState;
  readonly version: number;
  readonly schemaVersion: 1;
  readonly formatterVersion: 1;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly content: DraftContent;
  readonly description: string;
  readonly completeness: CompletenessResult;
  readonly readiness: ReadinessResult;
  readonly dependencies: DraftDependencies;
}

export interface CreateDraftInput {
  readonly summary: string;
  readonly context: string;
  readonly goalProblemOpportunity: string;
  readonly targetAudience?: string;
  readonly proposedSolution?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly successMetrics?: readonly string[];
  readonly risksConstraintsDependencies?: readonly string[];
  readonly additionalDetails?: readonly string[];
  readonly links?: readonly string[];
  readonly marketingRequired?: string;
  readonly categoryId?: string;
  readonly moscowId?: string;
  readonly impactedMetricIds?: readonly string[];
}

export interface DraftPatchValue {
  readonly value: string | readonly string[] | null;
  readonly source: PatchProvenance;
  readonly evidenceRef?: string;
}

export interface PatchDraftInput {
  readonly draftId: string;
  readonly expectedVersion: number;
  readonly updates?: Readonly<Partial<Record<DraftFieldName, DraftPatchValue>>>;
  readonly confirmFields?: readonly DraftFieldName[];
}

export interface CancelDraftInput {
  readonly draftId: string;
  readonly expectedVersion: number;
}

const FIELD_NAME_SET: ReadonlySet<string> = new Set(DRAFT_FIELD_NAMES);
const TEXT_FIELDS: ReadonlySet<DraftFieldName> = new Set([
  "summary",
  "context",
  "goalProblemOpportunity",
  "targetAudience",
  "proposedSolution",
  "marketingRequired",
  "categoryId",
  "moscowId",
  "selectedRouteId",
]);
const REQUIRED_CONTENT_FIELDS: readonly DraftFieldName[] = Object.freeze([
  "summary",
  "context",
  "goalProblemOpportunity",
  "targetAudience",
  "proposedSolution",
  "acceptanceCriteria",
  "marketingRequired",
  "categoryId",
  "moscowId",
  "impactedMetricIds",
  "selectedRouteId",
]);
const PLACEHOLDERS = new Set(["-", "tbd", "todo", "unknown", "неизвестно", "не определено", "уточнить"]);
const SECRET_LIKE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:authorization\s*:\s*(?:bearer|basic)|password\s*=|github_pat_|ghp_[A-Za-z0-9]|xox[baprs]-|sk-[A-Za-z0-9]{16})/i;

function invalid(): never {
  throw new Error("DRAFT_INVALID");
}

function normalizeText(value: unknown, maximum: number): string {
  if (typeof value !== "string") invalid();
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > maximum || PLACEHOLDERS.has(normalized.toLocaleLowerCase("ru"))) invalid();
  if (SECRET_LIKE.test(normalized)) invalid();
  return normalized;
}

function normalizeList(value: unknown, maximumItems: number, itemMaximum = 2_000): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumItems) invalid();
  const normalized = value.map((item) => normalizeText(item, itemMaximum));
  if (new Set(normalized).size !== normalized.length) invalid();
  return Object.freeze(normalized);
}

function normalizeLinks(value: unknown): readonly string[] {
  const links = normalizeList(value, 10, 2_048);
  for (const link of links) {
    let parsed: URL;
    try {
      parsed = new URL(link);
    } catch {
      invalid();
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) invalid();
  }
  return links;
}

function normalizeFieldValue(field: DraftFieldName, value: unknown): string | readonly string[] | null {
  if (value === null) return null;
  if (TEXT_FIELDS.has(field)) return normalizeText(value, field === "summary" ? 255 : 10_000);
  switch (field) {
    case "acceptanceCriteria":
    case "successMetrics":
    case "risksConstraintsDependencies":
    case "additionalDetails":
      return normalizeList(value, 20);
    case "links":
      return normalizeLinks(value);
    case "impactedMetricIds":
      return normalizeList(value, 20, 128);
    case "routeCandidates":
      return normalizeList(value, 3, 128);
    default:
      return invalid();
  }
}

function statedText(value: string, field: DraftFieldName): ProvenancedValue<string> {
  return provenancedValue(normalizeFieldValue(field, value) as string, "USER_STATED");
}

function optionalText(value: string | undefined, field: DraftFieldName): ProvenancedValue<string> {
  return value === undefined ? unknownValue<string>() : statedText(value, field);
}

function optionalList(value: readonly string[] | undefined, field: DraftFieldName): ProvenancedValue<readonly string[]> {
  return value === undefined
    ? unknownValue<readonly string[]>()
    : provenancedValue(normalizeFieldValue(field, value) as readonly string[], "USER_STATED");
}

export function createDraftContent(input: CreateDraftInput): DraftContent {
  return Object.freeze({
    summary: statedText(input.summary, "summary"),
    context: statedText(input.context, "context"),
    goalProblemOpportunity: statedText(input.goalProblemOpportunity, "goalProblemOpportunity"),
    targetAudience: optionalText(input.targetAudience, "targetAudience"),
    proposedSolution: optionalText(input.proposedSolution, "proposedSolution"),
    acceptanceCriteria: optionalList(input.acceptanceCriteria, "acceptanceCriteria"),
    successMetrics: optionalList(input.successMetrics, "successMetrics"),
    risksConstraintsDependencies: optionalList(input.risksConstraintsDependencies, "risksConstraintsDependencies"),
    additionalDetails: optionalList(input.additionalDetails, "additionalDetails"),
    links: optionalList(input.links, "links"),
    marketingRequired: optionalText(input.marketingRequired, "marketingRequired"),
    categoryId: optionalText(input.categoryId, "categoryId"),
    moscowId: optionalText(input.moscowId, "moscowId"),
    impactedMetricIds: optionalList(input.impactedMetricIds, "impactedMetricIds"),
    routeCandidates: unknownValue<readonly string[]>(),
    selectedRouteId: unknownValue<string>(),
  });
}

function fieldValue(content: DraftContent, field: DraftFieldName): ProvenancedValue<string | readonly string[]> {
  return content[field] as ProvenancedValue<string | readonly string[]>;
}

export function applyDraftPatch(content: DraftContent, input: PatchDraftInput): DraftContent {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) invalid();
  const updates = input.updates ?? {};
  for (const key of Object.keys(updates)) if (!FIELD_NAME_SET.has(key)) invalid();
  const confirmations: readonly DraftFieldName[] = input.confirmFields ?? [];
  if (!Array.isArray(confirmations) || new Set(confirmations).size !== confirmations.length) invalid();
  for (const field of confirmations) if (!FIELD_NAME_SET.has(field)) invalid();
  if (Object.keys(updates).some((field) => confirmations.includes(field as DraftFieldName))) invalid();

  const next = { ...content } as Record<DraftFieldName, ProvenancedValue<string | readonly string[]>>;
  for (const [rawField, rawPatch] of Object.entries(updates)) {
    const field = rawField as DraftFieldName;
    if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) invalid();
    const patch = rawPatch as DraftPatchValue;
    const keys = Object.keys(patch);
    if (keys.some((key) => !["value", "source", "evidenceRef"].includes(key)) || !keys.includes("value") || !keys.includes("source")) invalid();
    if (!["USER_STATED", "MODEL_PROPOSED", "UNKNOWN"].includes(patch.source)) invalid();
    const normalized = normalizeFieldValue(field, patch.value);
    next[field] = applyProvenanceTransition(fieldValue(content, field), normalized, patch.source, patch.evidenceRef);
  }
  for (const rawField of confirmations as readonly string[]) {
    assertDraftFieldName(rawField);
    const field: DraftFieldName = rawField;
    next[field] = confirmProposedValue(fieldValue(content, field));
  }
  return Object.freeze(next) as unknown as DraftContent;
}

export function contentCompleteness(content: DraftContent): CompletenessResult {
  const reasons: string[] = [];
  for (const field of REQUIRED_CONTENT_FIELDS) {
    const value = fieldValue(content, field);
    if (value.provenance === "MODEL_PROPOSED") reasons.push(`UNCONFIRMED_${field}`);
    else if (value.value === null || value.provenance === "UNKNOWN") reasons.push(`MISSING_${field}`);
  }
  return Object.freeze({ complete: reasons.length === 0, reasons: Object.freeze(reasons) });
}

export function draftContentEquals(left: DraftContent, right: DraftContent): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function assertDraftFieldName(value: string): asserts value is DraftFieldName {
  if (!FIELD_NAME_SET.has(value)) invalid();
}
