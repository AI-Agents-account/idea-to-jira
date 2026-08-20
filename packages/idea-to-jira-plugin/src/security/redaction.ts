import { createHash } from "node:crypto";

import { isSafeErrorCode, SafeError, type SafeErrorCode, type SafeErrorView } from "../errors/index.js";

const REDACTED = "[REDACTED]" as const;
const TOKEN_MARKERS = [
  /\bbearer\s+\S+/giu,
  /\bbasic\s+\S+/giu,
  /\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+/giu,
  /(?:токен|секрет|пароль|api[_-]?ключ)\s*[:=]\s*\S+/giu,
  /\b[a-z0-9_-]{20,}\.[a-z0-9_-]{20,}\.[a-z0-9_-]{20,}\b/giu,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{20,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g,
];
const SAFE_HEADER_NAMES = new Set(["content-type", "content-length", "retry-after", "x-request-id"]);

export function redactTokenLike(value: string): string {
  let result = value;
  for (const marker of TOKEN_MARKERS) result = result.replace(marker, REDACTED);
  return result;
}

/** URL diagnostics retain only trusted routing shape; credentials, query values and fragment are dropped. */
export function sanitizeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    const path = url.pathname
      .split("/")
      .map((segment) => segment && (/^[A-Za-z_-]{1,40}$/.test(segment) ? segment : ":id"))
      .join("/");
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return undefined;
  }
}

export function sanitizeHeaders(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return Object.freeze({});
  const output: Record<string, string> = {};
  let entries: [string, unknown][];
  try {
    entries = Object.entries(value as Record<string, unknown>);
  } catch {
    return Object.freeze({});
  }
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (!SAFE_HEADER_NAMES.has(name)) continue;
    if (typeof rawValue !== "string" && typeof rawValue !== "number") continue;
    const sanitized = redactTokenLike(String(rawValue));
    if (sanitized.includes(REDACTED)) {
      output[name] = REDACTED;
      continue;
    }
    if (name === "content-type" && /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,64}(?:;\s*charset=[A-Za-z0-9._-]{1,32})?$/.test(sanitized)) {
      output[name] = sanitized;
    } else if ((name === "content-length" || name === "retry-after") && /^\d{1,20}$/.test(sanitized)) {
      output[name] = sanitized;
    } else if (name === "x-request-id" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sanitized)) {
      output[name] = sanitized;
    }
  }
  return Object.freeze(output);
}

export interface SanitizedTelegramUpdate {
  readonly updateId?: number;
  readonly messageId?: number;
  readonly kind: "MESSAGE" | "CALLBACK" | "VOICE" | "UNKNOWN";
}

/** Never retains sender/chat IDs, text, captions, callback data, transcript, files or voice bytes. */
export function sanitizeTelegramUpdate(value: unknown): SanitizedTelegramUpdate {
  const input = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const message = input.message !== null && typeof input.message === "object" && !Array.isArray(input.message)
    ? input.message as Record<string, unknown>
    : undefined;
  const callback = input.callback_query !== null && typeof input.callback_query === "object" && !Array.isArray(input.callback_query)
    ? input.callback_query as Record<string, unknown>
    : undefined;
  const callbackMessage = callback?.message !== null && typeof callback?.message === "object" && !Array.isArray(callback.message)
    ? callback.message as Record<string, unknown>
    : undefined;
  const selectedMessage = message ?? callbackMessage;
  const integer = (candidate: unknown): number | undefined =>
    typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : undefined;
  const updateId = integer(input.update_id);
  const messageId = integer(selectedMessage?.message_id);
  const kind = callback ? "CALLBACK" : message?.voice ? "VOICE" : message ? "MESSAGE" : "UNKNOWN";
  return Object.freeze({ ...(updateId !== undefined ? { updateId } : {}), ...(messageId !== undefined ? { messageId } : {}), kind });
}

export type ProviderKind = "JIRA" | "MODEL" | "STT" | "TELEGRAM";
export interface SanitizedProviderError extends SafeErrorView {
  readonly provider: ProviderKind;
  readonly statusClass?: "4XX" | "5XX";
}

function integerStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function statusFromUnknown(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  try {
    const record = error as Record<string, unknown>;
    const direct = integerStatus(record.status);
    if (direct !== undefined) return direct;
    const response = record.response;
    if (response !== null && typeof response === "object" && !Array.isArray(response)) {
      return integerStatus((response as Record<string, unknown>).status);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function sanitizeProviderError(provider: ProviderKind, error: unknown): SanitizedProviderError {
  if (!["JIRA", "MODEL", "STT", "TELEGRAM"].includes(provider)) {
    throw new Error("PROVIDER_KIND_INVALID");
  }
  const status = statusFromUnknown(error);
  const requestCode: Record<ProviderKind, SafeErrorCode> = {
    JIRA: "JIRA_REQUEST_FAILED",
    MODEL: "MODEL_REQUEST_FAILED",
    STT: "STT_REQUEST_FAILED",
    TELEGRAM: "TELEGRAM_REQUEST_FAILED",
  };
  let code: SafeErrorCode = requestCode[provider];
  let retryable = true;
  if (status === 401 || status === 403) {
    code = provider === "JIRA" ? "JIRA_AUTH_FAILED" : requestCode[provider];
    retryable = false;
  } else if (status === 429) {
    code = provider === "JIRA" ? "JIRA_RATE_LIMITED" : requestCode[provider];
  } else if (error instanceof SafeError) {
    code = error.code;
    retryable = error.retryable;
  }
  const safe = new SafeError(code, retryable).toSafeView("OPERATOR");
  return Object.freeze({
    provider,
    ...safe,
    ...(status !== undefined && status >= 400 && status < 600
      ? { statusClass: status < 500 ? "4XX" as const : "5XX" as const }
      : {}),
  });
}

export type FieldClassification = "ID" | "VERSION" | "HASH" | "OUTCOME" | "ERROR_CODE" | "URL" | "HEADERS";
export type ClassificationSchema = Readonly<Record<string, FieldClassification>>;

/** Unknown fields are dropped. Known fields still fail closed unless they match their classification. */
export function sanitizeClassifiedRecord(
  value: unknown,
  schema: ClassificationSchema,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return Object.freeze({});
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [field, classification] of Object.entries(schema)) {
    const candidate = source[field];
    switch (classification) {
      case "ID":
        if (typeof candidate === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate)) output[field] = candidate;
        break;
      case "VERSION":
        if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 1) output[field] = candidate;
        break;
      case "HASH":
        if (typeof candidate === "string" && /^[a-f0-9]{64}$/.test(candidate)) output[field] = candidate;
        break;
      case "OUTCOME":
        if (typeof candidate === "string" && ["ALLOWED", "REJECTED", "SUCCEEDED", "FAILED", "UNKNOWN"].includes(candidate)) {
          output[field] = candidate;
        }
        break;
      case "ERROR_CODE":
        if (isSafeErrorCode(candidate)) output[field] = candidate;
        break;
      case "URL": {
        const sanitized = sanitizeUrl(candidate);
        if (sanitized) output[field] = sanitized;
        break;
      }
      case "HEADERS":
        output[field] = sanitizeHeaders(candidate);
        break;
    }
  }
  return Object.freeze(output);
}

export function hashSanitizedDetails(value: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
