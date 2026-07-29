/**
 * Fixed-window rate limiting, in-memory, per process.
 *
 * security-implementation.md §3/§4/§8 requires rate limiting "per IP and per
 * identifier" on OTP and login. Exact thresholds are not specified there; the
 * values used are recorded as an assumption in DECISIONS.md and
 * PROGRESS.md's open questions.
 *
 * In-memory means limits reset on restart and are not shared across
 * processes. Acceptable for a single Fastify instance; revisit (a shared
 * store such as Redis) before running more than one instance.
 */

interface Bucket {
  count: number;
  windowStartMs: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitRule {
  windowSeconds: number;
  max: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export function checkRateLimit(key: string, rule: RateLimitRule): RateLimitResult {
  const now = Date.now();
  const windowMs = rule.windowSeconds * 1000;
  const existing = buckets.get(key);

  if (!existing || now - existing.windowStartMs >= windowMs) {
    buckets.set(key, { count: 1, windowStartMs: now });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (existing.count < rule.max) {
    existing.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  const retryAfterSeconds = Math.ceil((existing.windowStartMs + windowMs - now) / 1000);
  return { allowed: false, retryAfterSeconds };
}

/** Test-only: clears all buckets so tests do not leak state between runs. */
export function resetRateLimits(): void {
  buckets.clear();
}
