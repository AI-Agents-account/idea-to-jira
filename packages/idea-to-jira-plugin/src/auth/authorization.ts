import type { EffectiveConfig } from "../config.js";
import { SafeError } from "../errors/index.js";
import type { TrustedRequesterContext } from "../runtime/requester-context.js";

export type UserState = "GUEST" | "PENDING" | "CREATOR" | "SUSPENDED" | "BLOCKED";
export type RoleGrantState = "ACTIVE" | "SUSPENDED" | "REVOKED";

export type AuthorizationDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code:
        | "ADMIN_REQUIRED"
        | "CREATOR_REQUIRED"
        | "OWNER_REQUIRED"
        | "SUBJECT_BLOCKED"
        | "SUBJECT_UNKNOWN";
    };

export interface AuthorizationSubject {
  readonly userId: string;
  readonly senderId: string;
  readonly state: UserState;
}

export interface CreatorGrantSnapshot {
  readonly role: "CREATOR";
  readonly state: RoleGrantState;
  readonly recordVersion: number;
}

const ALLOW: AuthorizationDecision = Object.freeze({ allowed: true });

function deny(code: Extract<AuthorizationDecision, { allowed: false }>["code"]): AuthorizationDecision {
  return Object.freeze({ allowed: false, code });
}

/** Business Admin is an independent server-side capability, never a model or command parameter. */
export function authorizeBusinessAdmin(
  requester: TrustedRequesterContext,
  config: EffectiveConfig,
): AuthorizationDecision {
  return config.telegram.adminSenderIds.includes(requester.senderId)
    ? ALLOW
    : deny("ADMIN_REQUIRED");
}

/** Own-resource authorization compares the trusted sender to the stored owner identity. */
export function authorizeOwnResource(
  requester: TrustedRequesterContext,
  subject: AuthorizationSubject | undefined,
  ownerUserId: string | undefined,
): AuthorizationDecision {
  if (!subject || !ownerUserId) return deny("SUBJECT_UNKNOWN");
  if (subject.state === "BLOCKED") return deny("SUBJECT_BLOCKED");
  if (subject.senderId !== requester.senderId || ownerUserId !== subject.userId) {
    return deny("OWNER_REQUIRED");
  }
  return ALLOW;
}

/** Reusable precheck for duplicate disclosure, operation claim and the immediate pre-POST gate. */
export function authorizeActiveCreator(
  requester: TrustedRequesterContext,
  subject: AuthorizationSubject | undefined,
  grant: CreatorGrantSnapshot | undefined,
): AuthorizationDecision {
  if (!subject) return deny("SUBJECT_UNKNOWN");
  if (subject.senderId !== requester.senderId) return deny("OWNER_REQUIRED");
  if (subject.state === "BLOCKED") return deny("SUBJECT_BLOCKED");
  if (subject.state !== "CREATOR" || !grant || grant.role !== "CREATOR" || grant.state !== "ACTIVE") {
    return deny("CREATOR_REQUIRED");
  }
  return ALLOW;
}

export function requireAuthorization(decision: AuthorizationDecision): void {
  if (!decision.allowed) throw new SafeError("ACCESS_DENIED", false);
}
