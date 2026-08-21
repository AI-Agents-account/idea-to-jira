export type JiraReadiness = "JIRA_UNAVAILABLE" | "JIRA_SEARCH_READY" | "JIRA_CREATE_READY";

export interface JiraAllowedValue {
  readonly id: string;
  readonly label: string;
}

export interface JiraFieldMetadata {
  readonly id: string;
  readonly name: string;
  readonly required: boolean;
  readonly schema: Readonly<{ type: string; items?: string; system?: string; custom?: string }>;
  readonly hasDefaultValue: boolean;
  readonly defaultValue?: unknown;
  readonly allowedValues: readonly JiraAllowedValue[];
}

export interface JiraMetadataSnapshot {
  readonly project: Readonly<{ id: string; key: string; name: string }>;
  readonly issueType: Readonly<{ id: string; name: string }>;
  readonly fields: Readonly<Record<string, JiraFieldMetadata>>;
  readonly permissions: Readonly<{ browse: boolean; create: boolean }>;
  readonly fetchedAt: string;
  readonly hash: string;
  readonly readiness: JiraReadiness;
  readonly blockers: readonly string[];
}

export type JiraFailureCode =
  | "JIRA_DISABLED" | "JIRA_CREDENTIAL_MISSING" | "JIRA_TIMEOUT" | "JIRA_UNAUTHORIZED"
  | "JIRA_FORBIDDEN" | "JIRA_RATE_LIMITED" | "JIRA_SERVER_ERROR" | "JIRA_REDIRECT_DENIED"
  | "JIRA_MALFORMED" | "JIRA_REQUEST_REJECTED" | "JIRA_RESPONSE_TOO_LARGE" | "JIRA_NETWORK_ERROR" | "JIRA_SCOPE_NOT_FOUND" | "JIRA_CIRCUIT_OPEN"
  | "JIRA_UNSUPPORTED_FIELD" | "JIRA_STALE_BINDING" | "JIRA_CONFIRMATION_REQUIRED";

export class JiraFailure extends Error {
  constructor(
    readonly code: JiraFailureCode,
    /** True only when transport proves no bytes could have been sent. */
    readonly definitelyNotSent = false,
    options?: ErrorOptions,
  ) { super(code, options); this.name = "JiraFailure"; }
}

export interface JiraCandidate {
  readonly key: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface JiraSearchBinding {
  readonly draftId: string;
  readonly draftVersion: number;
  readonly configHash: string;
  readonly metadataHash: string;
}

export interface JiraSearchResult {
  readonly complete: boolean;
  readonly candidates: readonly JiraCandidate[];
  readonly context: string;
  readonly contextBytes: number;
  readonly binding: JiraSearchBinding;
  readonly errorCode?: JiraFailureCode;
}

export type DuplicateOutcome = "DUPLICATE" | "RELATED" | "UNIQUE" | "UNCERTAIN";
export interface DuplicateDecision {
  readonly outcome: DuplicateOutcome;
  readonly candidateKeys: readonly string[];
  readonly confidence: number;
  readonly reason: string;
  readonly recommendedAction: "USE_EXISTING" | "REVIEW_RELATED" | "PROCEED" | "CLARIFY_OR_OVERRIDE";
  readonly binding: JiraSearchBinding;
}

export type JiraQuestionKind = "text" | "number" | "date" | "datetime" | "single-choice" | "multi-choice";
export interface JiraFieldQuestion {
  readonly fieldId: string;
  readonly label: string;
  readonly kind: JiraQuestionKind;
  readonly required: true;
  readonly choices?: readonly string[];
}

export type JiraSemanticAnswer = string | number | readonly string[];
export interface JiraCreateForm {
  readonly metadataHash: string;
  readonly questions: readonly JiraFieldQuestion[];
  readonly defaults: readonly string[];
  readonly blockers: readonly string[];
}
