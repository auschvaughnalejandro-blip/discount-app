import { createHash, randomBytes } from 'node:crypto';

/**
 * Invitation claim codes.
 *
 * security-implementation.md §3:
 *   - single use, consumed atomically on first successful activation
 *   - cryptographically random, at least 128 bits of entropy
 *   - never derived from the membership number, which is printed on a card
 *     and sequential
 *   - stored hashed
 *   - expires after a defined period; regenerable by an administrator
 *   - bound to a specific member record on issue
 *
 * Consumption, expiry and binding live in the route that owns the transaction;
 * this module owns generation, formatting and hashing.
 */

/**
 * Crockford base32: no I, L, O or U. The first three are excluded because a
 * code is read off a printed invitation letter and typed by hand, where they
 * are indistinguishable from 1, 1 and 0; U is excluded so that random codes
 * cannot spell anything unfortunate.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * 20 bytes = 160 bits, comfortably above the 128-bit floor, and an exact
 * multiple of 5 bits so the base32 encoding needs no padding.
 */
const ENTROPY_BYTES = 20;

const GROUP_SIZE = 4;

function encodeBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * Groups the code for printing: `XXXX-XXXX-…`. The hyphens are presentation
 * only — `normalizeClaimCode` strips them, so a member may type the code with
 * or without.
 */
function group(code: string): string {
  const groups: string[] = [];
  for (let i = 0; i < code.length; i += GROUP_SIZE) {
    groups.push(code.slice(i, i + GROUP_SIZE));
  }
  return groups.join('-');
}

/**
 * Accepts what a human actually types: any case, hyphens or spaces anywhere
 * or nowhere, and the Crockford substitutions for characters the alphabet
 * deliberately omits.
 */
export function normalizeClaimCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
}

export interface GeneratedClaimCode {
  /** Shown to the administrator once, to print on the invitation letter. */
  plaintext: string;
  /** What is stored. The plaintext is never persisted. */
  hash: string;
}

export function generateClaimCode(): GeneratedClaimCode {
  const code = encodeBase32(randomBytes(ENTROPY_BYTES));
  return { plaintext: group(code), hash: hashClaimCode(code) };
}

/**
 * SHA-256, not Argon2id — the same reasoning as refresh tokens (see
 * DECISIONS.md): 160 bits of server-generated randomness cannot be brute
 * forced at any hash speed, so a deliberately slow hash defends nothing and
 * would only add latency. What is needed is that a stolen database contains
 * nothing usable, which a one-way hash already provides.
 *
 * Lookup is by unique index on the hash rather than by scanning and
 * comparing, so no timing signal distinguishes a near miss from a miss.
 */
export function hashClaimCode(code: string): string {
  return createHash('sha256').update(normalizeClaimCode(code)).digest('hex');
}
