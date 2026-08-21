export const DRAFT_SCHEMA_VERSION = 1 as const;
export const DESCRIPTION_FORMATTER_VERSION = 1 as const;

export const DRAFT_STATES = Object.freeze([
  "EDITING",
  "READY",
  "POSTING",
  "CREATED",
  "DUPLICATE_LINKED",
  "CANCELLED",
  "FAILED_FINAL",
  "UNKNOWN",
] as const);

export type DraftState = (typeof DRAFT_STATES)[number];

export const ACTIVE_DRAFT_STATES: ReadonlySet<DraftState> = new Set(["EDITING", "READY"]);

export function canEditDraft(state: DraftState): boolean {
  return state === "EDITING" || state === "READY";
}
