import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The member identity payload carried by the QR code on the digital card.
 *
 * security-implementation.md §7:
 *
 *     v1.<member_ref>.<issued_at>.<hmac>
 *
 *   - `member_ref` is the opaque internal identifier, never the printed PG
 *     number, which is sequential and guessable (R3)
 *   - HMAC over the full payload, keyed from the key management service
 *   - `issued_at` refreshed whenever the app regenerates the code; the
 *     verification page rejects payloads older than a configured window,
 *     which is what defeats a forwarded screenshot
 *   - **identifies only.** Entitlement is resolved server-side against the
 *     member record. Possession of the code never itself applies a discount
 *     (R10).
 */

const VERSION = 'v1';

/**
 * TODO(stage-14): §7 says the key comes from the key management service. No
 * KMS exists in this build; the environment variable is the nearest
 * equivalent, the same compromise as PASSWORD_PEPPER. Recorded in PROGRESS.md.
 */
function hmacSecret(): string {
  const value = process.env['IDENTITY_CODE_HMAC_SECRET'];
  if (!value) {
    throw new Error('IDENTITY_CODE_HMAC_SECRET is not set.');
  }
  return value;
}

/** Signed over version, reference and timestamp together, so none can be swapped. */
function sign(body: string): string {
  return createHmac('sha256', hmacSecret()).update(body).digest('base64url');
}

export function issueIdentityCode(memberRef: string, now: Date = new Date()): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const body = `${VERSION}.${memberRef}.${issuedAt}`;
  return `${body}.${sign(body)}`;
}

export type IdentityCodeFailureReason = 'malformed' | 'bad_signature' | 'stale';

export type IdentityCodeResult =
  | { ok: true; memberRef: string; issuedAt: Date }
  | { ok: false; reason: IdentityCodeFailureReason };

export interface VerifyIdentityCodeOptions {
  /** R9 — read from configuration, default 24 hours. */
  windowHours: number;
  now?: Date;
}

export function verifyIdentityCode(
  payload: string,
  options: VerifyIdentityCodeOptions,
): IdentityCodeResult {
  const parts = payload.split('.');
  if (parts.length !== 4) {
    return { ok: false, reason: 'malformed' };
  }

  const [version, memberRef, issuedAtRaw, signature] = parts;
  if (version !== VERSION || !memberRef || !issuedAtRaw || !signature) {
    return { ok: false, reason: 'malformed' };
  }

  const issuedAtSeconds = Number.parseInt(issuedAtRaw, 10);
  if (!Number.isFinite(issuedAtSeconds) || issuedAtSeconds <= 0) {
    return { ok: false, reason: 'malformed' };
  }

  // Signature first, then freshness. Checking freshness on an unverified
  // payload would be reasoning about a timestamp an attacker chose.
  const expected = sign(`${version}.${memberRef}.${issuedAtRaw}`);
  const provided = Buffer.from(signature, 'utf8');
  const computed = Buffer.from(expected, 'utf8');

  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const now = options.now ?? new Date();
  const ageMs = now.getTime() - issuedAtSeconds * 1000;
  const windowMs = options.windowHours * 60 * 60 * 1000;

  // A payload from the future is as wrong as one that is too old, and would
  // otherwise never expire.
  if (ageMs > windowMs || ageMs < -windowMs) {
    return { ok: false, reason: 'stale' };
  }

  return { ok: true, memberRef, issuedAt: new Date(issuedAtSeconds * 1000) };
}
