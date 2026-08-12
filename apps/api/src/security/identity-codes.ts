import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The member identity payload carried by the QR code — on the back of the
 * printed card, and on the same card inside the app.
 *
 * security-implementation.md §7 specified one form:
 *
 *     v1.<member_ref>.<issued_at>.<hmac>
 *
 * where `issued_at` was refreshed every 60 seconds and anything older than a
 * configured window was refused. That is what defeated a forwarded screenshot.
 *
 * ## Why there is now a second, static form
 *
 * The client's card carries the code in ink. **Ink cannot rotate.** A printed
 * payload has one `issued_at` for the life of the card, so a freshness window
 * either rejects the card on day two or is not a freshness window at all.
 *
 * So `v2` drops the timestamp entirely and says so in the version prefix rather
 * than pretending to a freshness it does not have:
 *
 *     v2.<member_ref>.<hmac>
 *
 * ## Why a static code is acceptable here
 *
 * Because this **identifies, and grants nothing** (R10). Resolving it returns
 * who the member is and what the programme offers them; applying a discount
 * still requires an authenticated outlet session, and recording one still writes
 * an immutable, attributed Redemption. A static QR is therefore no stronger and
 * no weaker than the membership number already printed in plain text on the
 * front of the same card, which staff can and do type in by hand.
 *
 * What it is not: a bearer credential. If that ever changes — if possession of
 * the payload alone starts to be worth something — this decision has to be
 * revisited, and `v1` is still here so it can be, without reissuing a single
 * card or updating a single scanner.
 *
 * Both forms verify through `verifyIdentityCode`. `v1` is still checked for
 * freshness; `v2` is not. The version is inside the signed body, so one form
 * cannot be re-read as the other.
 */

const ROTATING_VERSION = 'v1';
const STATIC_VERSION = 'v2';

/**
 * TODO(open-question): §7 says the key comes from the key management service.
 * No KMS exists in this build; the environment variable is the nearest
 * equivalent, the same compromise as PASSWORD_PEPPER. Recorded in PROGRESS.md.
 */
function hmacSecret(): string {
  const value = process.env['IDENTITY_CODE_HMAC_SECRET'];
  if (!value) {
    throw new Error('IDENTITY_CODE_HMAC_SECRET is not set.');
  }
  return value;
}

/** Signed over every field including the version, so none can be swapped. */
function sign(body: string): string {
  return createHmac('sha256', hmacSecret()).update(body).digest('base64url');
}

/**
 * The card code: one value per member, for the life of the membership.
 *
 * Derived rather than stored. Nothing on `Member` holds it, so there is no
 * column to migrate, no value to keep in sync with the printed card, and no
 * table whose leak would hand somebody a set of working payloads that a rotation
 * could not invalidate — changing `IDENTITY_CODE_HMAC_SECRET` invalidates every
 * code at once, which is the only recovery a printed credential can have.
 *
 * `memberRef` is the opaque internal id, never the sequential PG number printed
 * on the front (R3): a guessable reference would let somebody generate a
 * neighbour's payload from their own.
 */
export function issueCardCode(memberRef: string): string {
  const body = `${STATIC_VERSION}.${memberRef}`;
  return `${body}.${sign(body)}`;
}

/**
 * The rotating form, kept working for a client that refreshes it.
 *
 * Nothing in the product issues this today. It stays because reinstating
 * rotation later must not require reprinting cards or updating scanners — the
 * verifier below already accepts both.
 */
export function issueRotatingCode(memberRef: string, now: Date = new Date()): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const body = `${ROTATING_VERSION}.${memberRef}.${issuedAt}`;
  return `${body}.${sign(body)}`;
}

export type IdentityCodeFailureReason = 'malformed' | 'bad_signature' | 'stale';

export type IdentityCodeResult =
  | {
      ok: true;
      memberRef: string;
      /** Which form was presented. Audited, so "scanned from the card" stays
       * distinguishable from "scanned from the app" without either being
       * refused. */
      form: 'card' | 'rotating';
      /** Only the rotating form carries one. */
      issuedAt?: Date;
    }
  | { ok: false; reason: IdentityCodeFailureReason };

export interface VerifyIdentityCodeOptions {
  /** Applies to the rotating form only. Read from configuration (R9). */
  windowHours: number;
  now?: Date;
}

export function verifyIdentityCode(
  payload: string,
  options: VerifyIdentityCodeOptions,
): IdentityCodeResult {
  const parts = payload.split('.');
  const version = parts[0];

  if (version === STATIC_VERSION) {
    if (parts.length !== 3) {
      return { ok: false, reason: 'malformed' };
    }
    const [, memberRef, signature] = parts;
    if (!memberRef || !signature) {
      return { ok: false, reason: 'malformed' };
    }
    if (!signatureMatches(`${STATIC_VERSION}.${memberRef}`, signature)) {
      return { ok: false, reason: 'bad_signature' };
    }
    // No freshness check, deliberately. See the note at the top of this file.
    return { ok: true, memberRef, form: 'card' };
  }

  if (version !== ROTATING_VERSION || parts.length !== 4) {
    return { ok: false, reason: 'malformed' };
  }

  const [, memberRef, issuedAtRaw, signature] = parts;
  if (!memberRef || !issuedAtRaw || !signature) {
    return { ok: false, reason: 'malformed' };
  }

  const issuedAtSeconds = Number.parseInt(issuedAtRaw, 10);
  if (!Number.isFinite(issuedAtSeconds) || issuedAtSeconds <= 0) {
    return { ok: false, reason: 'malformed' };
  }

  // Signature first, then freshness. Checking freshness on an unverified payload
  // would be reasoning about a timestamp an attacker chose.
  if (!signatureMatches(`${ROTATING_VERSION}.${memberRef}.${issuedAtRaw}`, signature)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const now = options.now ?? new Date();
  const ageMs = now.getTime() - issuedAtSeconds * 1000;
  const windowMs = options.windowHours * 60 * 60 * 1000;

  // A payload from the future is as wrong as one too old, and would otherwise
  // never expire.
  if (ageMs > windowMs || ageMs < -windowMs) {
    return { ok: false, reason: 'stale' };
  }

  return { ok: true, memberRef, form: 'rotating', issuedAt: new Date(issuedAtSeconds * 1000) };
}

function signatureMatches(body: string, provided: string): boolean {
  const expected = Buffer.from(sign(body), 'utf8');
  const presented = Buffer.from(provided, 'utf8');
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}
