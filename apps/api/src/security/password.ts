import { hash, verify, type Algorithm } from '@node-rs/argon2';

/**
 * `Algorithm` is an ambient `const enum`, which `verbatimModuleSyntax` cannot
 * import as a value. Annotating with the type keeps the value checked against
 * the enum rather than being a bare magic number.
 */
const ARGON2ID: Algorithm = 2;

/**
 * security-implementation.md §3 — exact parameters, not configurable. Making
 * these environment-tunable would add a way to silently weaken password
 * hashing via misconfiguration.
 *
 *   memory      : 64 MB  (m = 65536)
 *   iterations  : 3
 *   parallelism : 2
 *   output      : 32 bytes
 *
 * The library generates a fresh 16-byte cryptographically random salt per
 * call and encodes algorithm + parameters into the returned hash string, so
 * parameters can be raised later and existing hashes upgraded on next login
 * (see `needsRehash`).
 */
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 2,
  outputLen: 32,
} as const;

/**
 * TODO(stage-2-followup): §3 also requires a pepper held in the key management
 * service, not the database — "a stolen dump alone is then not crackable."
 * No KMS exists in this build; `PASSWORD_PEPPER` is read from the environment
 * as the nearest equivalent available here. Recorded as a deviation in
 * PROGRESS.md.
 */
function pepper(): string {
  const value = process.env['PASSWORD_PEPPER'];
  if (!value) {
    throw new Error('PASSWORD_PEPPER is not set.');
  }
  return value;
}

function withPepper(plaintext: string): string {
  return `${plaintext}${pepper()}`;
}

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(withPepper(plaintext), ARGON2_OPTIONS);
}

/**
 * `verify` from `@node-rs/argon2` runs the same Argon2 computation the hash
 * was created with and compares digests via a constant-time routine
 * internally — never `===` on the raw hash string.
 */
export async function verifyPassword(plaintext: string, encodedHash: string): Promise<boolean> {
  return verify(encodedHash, withPepper(plaintext));
}

/**
 * A hash computed with the current parameters, checked against nothing.
 * Used to keep login timing uniform between an existing account (real hash,
 * real compare) and a non-existent one (this hash, a compare guaranteed to
 * fail) — see security-implementation.md §3 "Account enumeration".
 *
 * Generated once per process rather than per request: hashing itself is the
 * expensive, timing-relevant operation, and the dummy only needs to *look
 * like* a password check from the outside, not defend a real secret.
 */
let dummyHashPromise: Promise<string> | undefined;

function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('dummy-password-for-timing-uniformity');
  return dummyHashPromise;
}

/**
 * Runs a real Argon2 verification against a fixed dummy hash so that looking
 * up a non-existent account costs the same wall-clock time as checking a real
 * password. Always returns `false`.
 */
export async function verifyAgainstDummy(): Promise<false> {
  await verifyPassword('irrelevant', await getDummyHash());
  return false;
}
