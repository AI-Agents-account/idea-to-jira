import type { EffectiveConfig } from "../config.js";
import type { TrustedRequesterContext } from "./requester-context.js";

export type PolicyOperation = "model_run" | "draft_tool" | "access_request";

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterMs?: number;
}

export interface RateLimiter {
  consume(requester: TrustedRequesterContext, operation: PolicyOperation): RateLimitDecision;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Process-local guard for stage 01. Durable/distributed rate limiting remains a later storage concern. */
export class TokenBucketRateLimiter implements RateLimiter {
  readonly #requestsPerMinute: number;
  readonly #burst: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(config: EffectiveConfig["limits"], now: () => number = Date.now) {
    this.#requestsPerMinute = config.requestsPerMinute;
    this.#burst = config.burst;
    this.#now = now;
  }

  consume(requester: TrustedRequesterContext, operation: PolicyOperation): RateLimitDecision {
    const now = this.#now();
    const key = `${requester.accountId}:${requester.senderId}:${operation}`;
    const previous = this.#buckets.get(key) ?? { tokens: this.#burst, updatedAt: now };
    const elapsedMs = Math.max(0, now - previous.updatedAt);
    const refill = elapsedMs * (this.#requestsPerMinute / 60_000);
    const tokens = Math.min(this.#burst, previous.tokens + refill);

    if (tokens < 1) {
      this.#buckets.set(key, { tokens, updatedAt: now });
      return {
        allowed: false,
        retryAfterMs: Math.ceil((1 - tokens) * (60_000 / this.#requestsPerMinute)),
      };
    }

    this.#buckets.set(key, { tokens: tokens - 1, updatedAt: now });
    return { allowed: true };
  }
}

export function assertPayloadWithinLimit(value: unknown, config: EffectiveConfig): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("PAYLOAD_INVALID");
  }
  if (serialized.length > config.limits.inputTextChars) {
    throw new Error("PAYLOAD_TOO_LARGE");
  }
}

export function requireRateLimit(
  limiter: RateLimiter,
  requester: TrustedRequesterContext,
  operation: PolicyOperation,
): void {
  if (!limiter.consume(requester, operation).allowed) throw new Error("RATE_LIMITED");
}
