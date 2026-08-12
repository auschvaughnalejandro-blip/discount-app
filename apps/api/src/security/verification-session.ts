import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The short-lived verification session from security-implementation.md §5:
 *
 *   "The result is bound to a short-lived verification session — staff can act
 *    on that member for a few minutes, then the context expires."
 *
 * Without it, recording a redemption would accept any member id the caller cared
 * to send, whether or not they had ever had that member's card in front of them.
 * With it, recording requires having just resolved the member at this outlet:
 * the two calls are bound together by the signature.
 *
 *     vs1.<staffUserId>.<memberId>.<issuedAt>.<hmac>
 *
 * Stateless on purpose. A database row would need a cleanup job and a second
 * round trip and buys nothing: the binding is in the signature, and expiry is
 * arithmetic on a signed timestamp.
 *
 * ## Why the account and not the outlet
 *
 * The subject is the signed-in outlet account, which is bound to exactly one
 * outlet — so binding to the account binds to the outlet transitively, and also
 * refuses a session handed to a different account at the same outlet. Binding to
 * the outlet alone would let two devices share one resolve.
 */

const VERSION = 'vs1';

/**
 * Shares IDENTITY_CODE_HMAC_SECRET with the identity payload. The two are
 * separated by the version prefix, which is inside the signed body — a
 * verification session can therefore never be verified as an identity code, or
 * the reverse, even though one key covers both.
 */
function hmacSecret(): string {
  const value = process.env['IDENTITY_CODE_HMAC_SECRET'];
  if (!value) {
    throw new Error('IDENTITY_CODE_HMAC_SECRET is not set.');
  }
  return value;
}

function sign(body: string): string {
  return createHmac('sha256', hmacSecret()).update(body).digest('base64url');
}

export function issueVerificationSession(
  staffUserId: string,
  memberId: string,
  now: Date = new Date(),
): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const body = `${VERSION}.${staffUserId}.${memberId}.${issuedAt}`;
  return `${body}.${sign(body)}`;
}

export type VerificationSessionFailure = 'malformed' | 'bad_signature' | 'expired' | 'not_bound';

export type VerificationSessionResult =
  | { ok: true }
  | { ok: false; reason: VerificationSessionFailure };

export interface VerifySessionOptions {
  /** The account presenting it, from the access token — never the body. */
  staffUserId: string;
  /** The member the redemption is being recorded against. */
  memberId: string;
  ttlSeconds: number;
  now?: Date;
}

export function verifyVerificationSession(
  token: string,
  options: VerifySessionOptions,
): VerificationSessionResult {
  const parts = token.split('.');
  if (parts.length !== 5) {
    return { ok: false, reason: 'malformed' };
  }

  const [version, staffUserId, memberId, issuedAtRaw, signature] = parts;
  if (version !== VERSION || !staffUserId || !memberId || !issuedAtRaw || !signature) {
    return { ok: false, reason: 'malformed' };
  }

  const issuedAtSeconds = Number.parseInt(issuedAtRaw, 10);
  if (!Number.isFinite(issuedAtSeconds) || issuedAtSeconds <= 0) {
    return { ok: false, reason: 'malformed' };
  }

  const expected = sign(`${version}.${staffUserId}.${memberId}.${issuedAtRaw}`);
  const provided = Buffer.from(signature, 'utf8');
  const computed = Buffer.from(expected, 'utf8');

  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
    return { ok: false, reason: 'bad_signature' };
  }

  // The session belongs to the account that created it and to one member. A
  // valid token for a different member, or handed to a colleague, is not a
  // session for this call.
  if (staffUserId !== options.staffUserId || memberId !== options.memberId) {
    return { ok: false, reason: 'not_bound' };
  }

  const now = options.now ?? new Date();
  const ageMs = now.getTime() - issuedAtSeconds * 1000;
  const ttlMs = options.ttlSeconds * 1000;

  if (ageMs > ttlMs || ageMs < -ttlMs) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true };
}
