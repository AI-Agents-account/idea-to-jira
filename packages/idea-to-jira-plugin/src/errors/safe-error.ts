import type { SafeErrorCode } from "./codes.js";
export type { SafeErrorCode } from "./codes.js";

export type ErrorAudience = "USER" | "OPERATOR";

export interface SafeErrorView {
  readonly code: SafeErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

function userMessage(code: SafeErrorCode): string {
  if (code === "RATE_LIMITED" || code === "JIRA_RATE_LIMITED") {
    return "This request is temporarily unavailable.";
  }
  if (code === "JIRA_UNKNOWN_RESULT") return "The result is not confirmed.";
  if (code === "DRAFT_INVALID" || code === "PAYLOAD_INVALID" || code === "PAYLOAD_TOO_LARGE") {
    return "The request could not be validated.";
  }
  return "This request is unavailable.";
}

/** Internal cause is retained for in-process handling but never exposed by toJSON/toSafeView. */
export class SafeError extends Error {
  readonly name = "SafeError";

  constructor(
    readonly code: SafeErrorCode,
    readonly retryable: boolean,
    options?: { readonly cause?: unknown },
  ) {
    super(userMessage(code), options);
  }

  toSafeView(_audience: ErrorAudience): SafeErrorView {
    return Object.freeze({ code: this.code, message: userMessage(this.code), retryable: this.retryable });
  }

  toJSON(): SafeErrorView {
    return this.toSafeView("OPERATOR");
  }
}

export function normalizeSafeError(error: unknown): SafeError {
  if (error instanceof SafeError) return error;
  return new SafeError("INTERNAL_ERROR", false, { cause: error });
}
