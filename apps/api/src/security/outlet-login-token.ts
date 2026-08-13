import { createHash, randomBytes } from 'node:crypto';

/**
 * A recognisable prefix keeps this credential from being mistaken for an
 * access token, refresh token or claim code when somebody provisions a device.
 */
export const OUTLET_LOGIN_TOKEN_PREFIX = 'pgo_';

/** 32 cryptographically random bytes = 256 bits of entropy. */
const OUTLET_LOGIN_TOKEN_RANDOM_BYTES = 32;

/**
 * Thirty-two bytes encode to exactly 43 unpadded base64url characters.
 * Deliberately exact: accepting arbitrary strings buys nothing and makes an
 * accidentally truncated credential harder to diagnose.
 */
const OUTLET_LOGIN_TOKEN_PATTERN = /^pgo_[A-Za-z0-9_-]{43}$/;

/** Generates the plaintext shown to an administrator exactly once. */
export function generateOutletLoginToken(): string {
  return `${OUTLET_LOGIN_TOKEN_PREFIX}${randomBytes(OUTLET_LOGIN_TOKEN_RANDOM_BYTES).toString('base64url')}`;
}

/** Narrow an untrusted request value before attempting a credential lookup. */
export function isOutletLoginToken(value: unknown): value is string {
  return typeof value === 'string' && OUTLET_LOGIN_TOKEN_PATTERN.test(value);
}

/**
 * Outlet tokens are uniformly random high-entropy values, not passwords. A
 * fast SHA-256 hash is therefore appropriate and lets PostgreSQL perform one
 * indexed lookup; a slow password hash would only make every login expensive.
 */
export function hashOutletLoginToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
