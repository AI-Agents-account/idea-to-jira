export const PROVENANCE_KINDS = Object.freeze([
  "USER_STATED",
  "USER_CONFIRMED",
  "MODEL_PROPOSED",
  "UNKNOWN",
  "CATALOG_DERIVED",
] as const);

export type ProvenanceKind = (typeof PROVENANCE_KINDS)[number];
export type PatchProvenance = Extract<ProvenanceKind, "USER_STATED" | "MODEL_PROPOSED" | "UNKNOWN">;

export interface ProvenancedValue<T> {
  readonly value: T | null;
  readonly provenance: ProvenanceKind;
  /** Opaque bounded reference to source evidence; never a copy of the source content. */
  readonly evidenceRef?: string;
}

const EVIDENCE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function validateEvidenceRef(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!EVIDENCE_REF.test(normalized)) throw new Error("DRAFT_INVALID");
  return normalized;
}

export function unknownValue<T>(): ProvenancedValue<T> {
  return Object.freeze({ value: null, provenance: "UNKNOWN" });
}

export function provenancedValue<T>(
  value: T | null,
  provenance: ProvenanceKind,
  evidenceRef?: string,
): ProvenancedValue<T> {
  if (provenance === "UNKNOWN" && value !== null) throw new Error("DRAFT_INVALID");
  if (provenance !== "UNKNOWN" && value === null) throw new Error("DRAFT_INVALID");
  const reference = validateEvidenceRef(evidenceRef);
  return Object.freeze({
    value,
    provenance,
    ...(reference ? { evidenceRef: reference } : {}),
  });
}

export function isConfirmed<T>(field: ProvenancedValue<T>): boolean {
  return field.value !== null && (
    field.provenance === "USER_STATED" ||
    field.provenance === "USER_CONFIRMED" ||
    field.provenance === "CATALOG_DERIVED"
  );
}

export function applyProvenanceTransition<T>(
  current: ProvenancedValue<T>,
  value: T | null,
  provenance: PatchProvenance,
  evidenceRef?: string,
): ProvenancedValue<T> {
  if (provenance === "MODEL_PROPOSED" && isConfirmed(current)) {
    throw new Error("DRAFT_INVALID");
  }
  return provenancedValue(value, provenance, evidenceRef);
}

export function confirmProposedValue<T>(
  current: ProvenancedValue<T>,
  evidenceRef?: string,
): ProvenancedValue<T> {
  if (current.provenance !== "MODEL_PROPOSED" || current.value === null) {
    throw new Error("DRAFT_INVALID");
  }
  return provenancedValue(current.value, "USER_CONFIRMED", evidenceRef ?? current.evidenceRef);
}
