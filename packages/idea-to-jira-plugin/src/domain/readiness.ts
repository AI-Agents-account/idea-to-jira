import type {
  CatalogReference,
  CompletenessResult,
  DraftDependencies,
  ReadinessReason,
  ReadinessResult,
} from "./draft.js";

export interface ReadinessProofs {
  readonly role: { readonly state: "ACTIVE" | "INACTIVE" | "UNAVAILABLE"; readonly version?: number };
  readonly transcript: {
    readonly state: "NOT_REQUIRED" | "CONFIRMED" | "PENDING_CONFIRMATION" | "FAILED";
    readonly draftVersion?: number;
  };
  readonly catalog: {
    readonly state: "CURRENT" | "STALE" | "UNAVAILABLE";
    readonly reference?: CatalogReference;
  };
  readonly metadata: {
    readonly state: "VALID" | "STALE" | "UNAVAILABLE";
    readonly draftVersion?: number;
  };
  readonly duplicate: {
    readonly state:
      | "NO_CANDIDATES"
      | "NOT_DUPLICATE"
      | "DUPLICATE_SELECTED"
      | "NEEDS_CLARIFICATION"
      | "PENDING"
      | "FAILED"
      | "STALE"
      | "UNAVAILABLE";
    readonly draftVersion?: number;
    readonly catalogVersion?: number;
  };
  readonly operation: {
    readonly state:
      | "NONE"
      | "PENDING"
      | "POSTING"
      | "CREATED"
      | "FAILED_RETRYABLE"
      | "FAILED_FINAL"
      | "UNKNOWN"
      | "MANUAL_RESOLUTION_REQUIRED";
    readonly draftVersion?: number;
  };
}

export const BLOCKED_READINESS_PROOFS: ReadinessProofs = Object.freeze({
  role: Object.freeze({ state: "UNAVAILABLE" }),
  transcript: Object.freeze({ state: "NOT_REQUIRED" }),
  catalog: Object.freeze({ state: "UNAVAILABLE" }),
  metadata: Object.freeze({ state: "UNAVAILABLE" }),
  duplicate: Object.freeze({ state: "UNAVAILABLE" }),
  operation: Object.freeze({ state: "NONE" }),
});

function reason(code: string, disposition: ReadinessReason["disposition"]): ReadinessReason {
  return Object.freeze({ code, disposition });
}

function sameCatalog(left: CatalogReference | null, right: CatalogReference | undefined): boolean {
  return left !== null && right !== undefined &&
    left.version === right.version && left.checksum === right.checksum;
}

function transcriptCurrent(
  draftVersion: number,
  dependencies: DraftDependencies,
  proofs: ReadinessProofs,
): boolean {
  if (dependencies.transcript.state !== proofs.transcript.state) return false;
  if (proofs.transcript.state === "NOT_REQUIRED") return true;
  return proofs.transcript.state === "CONFIRMED" &&
    dependencies.transcript.draftVersion === draftVersion && proofs.transcript.draftVersion === draftVersion;
}

function duplicateCurrent(
  draftVersion: number,
  dependencies: DraftDependencies,
  proofs: ReadinessProofs,
): boolean {
  const reference = dependencies.duplicate;
  if (!reference || !dependencies.catalog) return false;
  if (reference.draftVersion !== draftVersion || proofs.duplicate.draftVersion !== draftVersion) return false;
  if (reference.catalogVersion !== dependencies.catalog.version ||
      proofs.duplicate.catalogVersion !== dependencies.catalog.version) return false;
  if (proofs.duplicate.state === "NO_CANDIDATES") {
    return reference.state === "NO_CANDIDATES" ||
      (reference.state === "DECIDED" && reference.decision === "NO_CANDIDATES");
  }
  return proofs.duplicate.state === "NOT_DUPLICATE" &&
    reference.state === "DECIDED" && reference.decision === "NOT_DUPLICATE";
}

/** Pure fail-closed predicate. It imports no transport and performs no I/O. */
export function evaluateReadiness(
  draftVersion: number,
  completeness: CompletenessResult,
  description: string,
  dependencies: DraftDependencies,
  proofs: ReadinessProofs,
): ReadinessResult {
  const reasons: ReadinessReason[] = [];
  if (!completeness.complete) reasons.push(reason("DRAFT_INCOMPLETE", "MISSING"));
  if (!description.trim()) reasons.push(reason("DESCRIPTION_INCOMPLETE", "MISSING"));
  if (proofs.role.state !== "ACTIVE") reasons.push(reason("ROLE_NOT_ACTIVE", "BLOCKED"));
  if (!transcriptCurrent(draftVersion, dependencies, proofs)) {
    reasons.push(reason("TRANSCRIPT_UNRESOLVED", "BLOCKED"));
  }
  if (proofs.catalog.state !== "CURRENT" || !sameCatalog(dependencies.catalog, proofs.catalog.reference)) {
    reasons.push(reason("CATALOG_STALE", "BLOCKED"));
  }
  if (proofs.metadata.state !== "VALID" || proofs.metadata.draftVersion !== draftVersion) {
    reasons.push(reason("METADATA_UNVERIFIED", "BLOCKED"));
  }
  if (!duplicateCurrent(draftVersion, dependencies, proofs)) {
    const code = proofs.duplicate.state === "DUPLICATE_SELECTED"
      ? "DUPLICATE_SELECTED"
      : proofs.duplicate.state === "NO_CANDIDATES" || proofs.duplicate.state === "NOT_DUPLICATE"
        ? "DUPLICATE_STALE"
        : "DUPLICATE_BLOCKED";
    reasons.push(reason(code, "BLOCKED"));
  }
  const currentPostingBlocks = dependencies.posting !== null && dependencies.posting.state !== "FAILED_FINAL";
  if (proofs.operation.state !== "NONE" || currentPostingBlocks || dependencies.blockingPriorOperations.length > 0) {
    reasons.push(reason("OPERATION_BLOCKED", "BLOCKED"));
  }
  return Object.freeze({ ready: reasons.length === 0, reasons: Object.freeze(reasons) });
}
