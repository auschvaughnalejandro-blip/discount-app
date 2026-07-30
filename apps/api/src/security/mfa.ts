/**
 * Multi-factor authentication for staff accounts — Stage 19, closing
 * PROGRESS.md **Q5**.
 *
 * ## Which accounts this applies to
 *
 * `security-implementation.md` §3 says two things that look contradictory:
 *
 * - "MFA is mandatory on every dashboard account, without exception."
 * - "MFA for any staff account that can reach more than the verification page."
 *
 * The second is the specific one and it resolves the first: a `OUTLET_STAFF`
 * account reaches only the verification page and is therefore not a dashboard
 * account. `ADMINISTRATOR`, `MANAGER` and `SUPPORT` all reach more than that,
 * so all three require MFA. §3 already covers outlet staff separately with
 * named individual accounts, no shared logins, shift-length session expiry and
 * instant revocation.
 *
 * This reading was recorded in DECISIONS.md rather than decided silently,
 * because BUILD-PLAN §0 rule 4 requires it and because the alternative — TOTP
 * on a shared counter tablet every shift — is the kind of control that gets
 * worked around rather than followed.
 *
 * ## Why TOTP and not SMS
 *
 * An SMS second factor would depend on Stage 18's delivery, which is currently
 * email (see `notifications/code-sender.ts`), and a code emailed to a mailbox is
 * not a second *factor* when the first is also something-you-know. TOTP is free,
 * offline, and already on every staff phone.
 *
 * ## Secret storage
 *
 * The TOTP secret is a bearer credential: anyone holding it can generate valid
 * codes forever. It is encrypted with AES-256-GCM before it reaches the
 * database, so a stolen dump alone does not yield working second factors — the
 * same reasoning §3 applies to the password pepper. The key lives in the
 * environment for now; moving it to a KMS is Stage 20, tracked in
 * SECURITY-REVIEW.md.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { generateSecret, generateURI, verify as verifyOtpToken } from 'otplib';

import { hashPassword, verifyPassword } from './password.js';

/** Roles that reach more than the verification page. See the note above. */
const MFA_REQUIRED_ROLES = new Set(['ADMINISTRATOR', 'MANAGER', 'SUPPORT']);

export function roleRequiresMfa(role: string): boolean {
  return MFA_REQUIRED_ROLES.has(role);
}

// ── Secret encryption ────────────────────────────────────────────────────

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
/** GCM's standard nonce length. 12 bytes, not 16 — longer is not better here. */
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * A 32-byte key, hex-encoded (64 characters).
 *
 * Read at call time rather than module load so a test can set it, and so a
 * missing key fails on the first MFA operation with a clear message rather than
 * preventing the process from starting for deployments that have no staff
 * accounts requiring MFA yet.
 */
function encryptionKey(): Buffer {
  const raw = process.env['MFA_SECRET_ENCRYPTION_KEY'];
  if (!raw) {
    throw new Error('MFA_SECRET_ENCRYPTION_KEY is not set.');
  }
  const key = Buffer.from(raw, 'hex');
  if (key.length !== 32) {
    throw new Error('MFA_SECRET_ENCRYPTION_KEY must be 32 bytes, hex-encoded (64 characters).');
  }
  return key;
}

/** Stored as `iv.ciphertext.tag`, all base64url. */
export function encryptMfaSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, encryptionKey(), iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join(
    '.',
  );
}

export class MfaSecretError extends Error {}

export function decryptMfaSecret(stored: string): string {
  const parts = stored.split('.');
  if (parts.length !== 3) {
    throw new MfaSecretError('Stored MFA secret is malformed.');
  }
  const [ivRaw, ciphertextRaw, tagRaw] = parts as [string, string, string];

  try {
    const decipher = createDecipheriv(
      ENCRYPTION_ALGORITHM,
      encryptionKey(),
      Buffer.from(ivRaw, 'base64url'),
      { authTagLength: AUTH_TAG_LENGTH },
    );
    // GCM authenticates as well as encrypts: a tampered ciphertext fails here
    // rather than decrypting to garbage that then gets used as a TOTP secret.
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch (cause) {
    throw new MfaSecretError(
      cause instanceof Error ? `Stored MFA secret failed to decrypt: ${cause.name}` : 'Stored MFA secret failed to decrypt.',
    );
  }
}

// ── TOTP ─────────────────────────────────────────────────────────────────

/**
 * Tolerance for clock skew, in **seconds** — otplib 13 takes seconds here, not
 * time steps. 30 seconds is one step either side of the current one, so a code
 * typed as the boundary passes still verifies.
 *
 * The library default is 0, which is correct in theory and produces support
 * calls in practice; one step is what RFC 6238 §5.2 anticipates for skew.
 * Wider than this meaningfully extends how long an intercepted code stays
 * usable, so it is a constant rather than configuration — there is no
 * legitimate reason for a deployment to raise it.
 */
const EPOCH_TOLERANCE_SECONDS = 30;

/** 20 bytes / 160 bits, the RFC 4226 recommendation and otplib's default. */
export function generateMfaSecret(): string {
  return generateSecret();
}

/**
 * The URI an authenticator app expects, rendered as a QR at enrollment.
 *
 * The label carries the account email so a member of staff with several
 * accounts can tell them apart in the app. That is the app's own local storage,
 * not a log, so §9 does not apply — but it is the reason the enrollment
 * response must never be cached or logged.
 */
export function mfaEnrollmentUri(input: {
  email: string;
  secret: string;
  issuerLabel: string;
}): string {
  return generateURI({
    issuer: input.issuerLabel,
    label: input.email,
    secret: input.secret,
  });
}

export type TotpResult =
  | { valid: false }
  /** `epoch` is the period start the code matched, used for replay rejection. */
  | { valid: true; epoch: number };

/**
 * otplib compares in constant time internally. The `try` is because a malformed
 * secret — a truncated ciphertext that decrypted to something non-base32, say —
 * throws rather than returning a false result, and a thrown error here would
 * turn a corrupt row into a 500 that distinguishes it from a wrong code.
 *
 * ## Replay
 *
 * A TOTP code stays valid for its whole period plus the skew tolerance either
 * side — about 90 seconds here. Without the `afterEpoch` check below, a code
 * observed over someone's shoulder or lifted from a keylogger could be used a
 * second time inside that window.
 *
 * §3 requires the *member* OTP to be single use, and there is no principled
 * reason for a staff second factor to be weaker. Callers pass the epoch of the
 * last code this account successfully used; anything at or before it is refused
 * even though it is cryptographically correct.
 */
export async function verifyTotp(input: {
  token: string;
  secret: string;
  /** The `epoch` of this account's last accepted code, if any. */
  afterEpoch?: number | null;
}): Promise<TotpResult> {
  try {
    const result = await verifyOtpToken({
      secret: input.secret,
      token: input.token,
      epochTolerance: EPOCH_TOLERANCE_SECONDS,
    });

    if (!result.valid) {
      return { valid: false };
    }

    // otplib's top-level `verify` returns a TOTP-or-HOTP union and only the
    // TOTP arm carries `epoch`. We never pass `strategy`, so this is always the
    // TOTP arm — but narrow rather than cast, so that if the call ever changed
    // to HOTP this would fail closed instead of silently losing replay
    // protection.
    if (!('epoch' in result) || typeof result.epoch !== 'number') {
      return { valid: false };
    }

    // Reject a code from a period already spent. `<=` not `<`: the same period
    // must not be reusable, which is the whole point.
    if (input.afterEpoch != null && result.epoch <= input.afterEpoch) {
      return { valid: false };
    }

    return { valid: true, epoch: result.epoch };
  } catch {
    return { valid: false };
  }
}

// ── Recovery codes ───────────────────────────────────────────────────────

/**
 * Ten codes, each 10 characters from an unambiguous alphabet.
 *
 * A hotel manager locked out of the dashboard at 2am needs a route in that is
 * not "telephone the developer". The alphabet excludes 0/O and 1/I/L because
 * these get read aloud and typed from a printout.
 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const RECOVERY_CODE_LENGTH = 10;
export const RECOVERY_CODE_COUNT = 10;

export function generateRecoveryCode(): string {
  // Rejection-free because 31 does not divide 256 evenly — but the bias from
  // modulo here is negligible against a 31-character alphabet, and each code
  // still carries ~49 bits. Using rejection sampling anyway costs nothing.
  const out: string[] = [];
  while (out.length < RECOVERY_CODE_LENGTH) {
    for (const byte of randomBytes(RECOVERY_CODE_LENGTH)) {
      if (out.length === RECOVERY_CODE_LENGTH) {
        break;
      }
      // 248 = 31 * 8, the largest multiple of the alphabet below 256.
      if (byte < 248) {
        out.push(RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]!);
      }
    }
  }
  return out.join('');
}

export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => generateRecoveryCode());
}

/**
 * Hashed with the same Argon2id parameters as passwords — these are
 * password-equivalent credentials, and §3's requirements do not stop applying
 * because the string was machine-generated.
 */
export function hashRecoveryCode(code: string): Promise<string> {
  return hashPassword(normalizeRecoveryCode(code));
}

export function verifyRecoveryCode(code: string, hash: string): Promise<boolean> {
  return verifyPassword(normalizeRecoveryCode(code), hash);
}

/** Typed from a printout, so case and separators are forgiven. */
export function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]/g, '');
}

/**
 * Compares two TOTP codes in constant time.
 *
 * Used only where a code must be checked against another code rather than
 * against a secret — currently nowhere, but exported so that a future path does
 * not reach for `===`.
 */
export function codesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
