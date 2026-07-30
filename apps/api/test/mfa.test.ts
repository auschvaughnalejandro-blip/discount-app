/**
 * Stage 19 — staff MFA (PROGRESS.md Q5).
 *
 * The cryptographic and policy layer. Endpoint behaviour is covered by
 * `auth.test.ts`, which needs a database; everything here is pure and runs
 * without one.
 */
import { generateSync } from 'otplib';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  codesMatch,
  decryptMfaSecret,
  encryptMfaSecret,
  generateMfaSecret,
  generateRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  mfaEnrollmentUri,
  MfaSecretError,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
  roleRequiresMfa,
  verifyRecoveryCode,
  verifyTotp,
} from '../src/security/mfa.js';

beforeAll(() => {
  // 32 bytes, hex. A fixed value so failures are reproducible.
  process.env['MFA_SECRET_ENCRYPTION_KEY'] = 'a'.repeat(64);
});

describe('which roles require a second factor', () => {
  /**
   * §3 says both "mandatory on every dashboard account, without exception" and
   * "MFA for any staff account that can reach more than the verification page".
   * The second is the specific one; OUTLET_STAFF reaches only the verification
   * page and so is not a dashboard account. See DECISIONS.md.
   */
  it('requires it for every role that reaches more than the verification page', () => {
    expect(roleRequiresMfa('ADMINISTRATOR')).toBe(true);
    expect(roleRequiresMfa('MANAGER')).toBe(true);
    expect(roleRequiresMfa('SUPPORT')).toBe(true);
  });

  it('does not require it for outlet staff', () => {
    expect(roleRequiresMfa('OUTLET_STAFF')).toBe(false);
  });

  it('does not require it for an unrecognised role', () => {
    // Fails closed in the sense that matters: an unknown role gets no MFA
    // *gate*, but it also gets no permissions from the matrix, so it can reach
    // nothing. The gate is not the thing holding the door here.
    expect(roleRequiresMfa('SOMETHING_NEW')).toBe(false);
  });
});

describe('the TOTP secret is encrypted at rest', () => {
  it('round-trips', () => {
    const secret = generateMfaSecret();
    expect(decryptMfaSecret(encryptMfaSecret(secret))).toBe(secret);
  });

  it('never stores the secret in a recoverable form', () => {
    const secret = generateMfaSecret();
    const stored = encryptMfaSecret(secret);
    // The whole point: a database dump alone must not yield working factors.
    expect(stored).not.toContain(secret);
  });

  it('produces different ciphertext each time for the same secret', () => {
    // A fresh IV per encryption. Identical ciphertexts would tell an attacker
    // holding a dump which accounts share a secret.
    const secret = generateMfaSecret();
    expect(encryptMfaSecret(secret)).not.toBe(encryptMfaSecret(secret));
  });

  it('rejects a tampered ciphertext rather than decrypting to garbage', () => {
    const stored = encryptMfaSecret(generateMfaSecret());
    const [iv, ciphertext, tag] = stored.split('.') as [string, string, string];
    // Flip the ciphertext but keep the tag. GCM authenticates, so this must
    // fail rather than yield a wrong secret that then verifies nothing.
    const flipped = `${iv}.${ciphertext.slice(0, -2)}${ciphertext.slice(-2) === 'AA' ? 'BB' : 'AA'}.${tag}`;
    expect(() => decryptMfaSecret(flipped)).toThrow(MfaSecretError);
  });

  it('rejects a malformed stored value', () => {
    expect(() => decryptMfaSecret('nonsense')).toThrow(MfaSecretError);
    expect(() => decryptMfaSecret('a.b')).toThrow(MfaSecretError);
  });
});

describe('TOTP verification', () => {
  it('accepts a code generated from the same secret', async () => {
    const secret = generateMfaSecret();
    const token = generateSync({ secret });
    const result = await verifyTotp({ token, secret });
    expect(result.valid).toBe(true);
  });

  it('reports the period the code matched, for replay rejection', async () => {
    const secret = generateMfaSecret();
    const result = await verifyTotp({ token: generateSync({ secret }), secret });
    expect(result.valid && typeof result.epoch === 'number').toBe(true);
  });

  it('rejects a code from a different secret', async () => {
    const token = generateSync({ secret: generateMfaSecret() });
    const result = await verifyTotp({ token, secret: generateMfaSecret() });
    expect(result.valid).toBe(false);
  });

  it('rejects an obviously wrong code', async () => {
    const secret = generateMfaSecret();
    expect((await verifyTotp({ token: '000000', secret })).valid).toBe(false);
    expect((await verifyTotp({ token: '', secret })).valid).toBe(false);
  });

  it('returns invalid rather than throwing on a corrupt secret', async () => {
    // A truncated row must read as "wrong code", not a 500 that tells an
    // attacker this account's secret is damaged.
    const result = await verifyTotp({ token: '123456', secret: 'not-base32!!' });
    expect(result.valid).toBe(false);
  });
});

/**
 * A TOTP code stays cryptographically valid for its whole period plus the skew
 * tolerance either side — about 90 seconds. §3 requires the *member* OTP to be
 * single use, and there is no principled reason a staff second factor should be
 * weaker, so a spent period is refused.
 */
describe('TOTP replay', () => {
  it('refuses a code from a period already spent', async () => {
    const secret = generateMfaSecret();
    const token = generateSync({ secret });

    const first = await verifyTotp({ token, secret });
    expect(first.valid).toBe(true);

    const replayed = await verifyTotp({
      token,
      secret,
      afterEpoch: first.valid ? first.epoch : 0,
    });
    expect(replayed.valid).toBe(false);
  });

  it('refuses a code from an earlier period than the last one used', async () => {
    const secret = generateMfaSecret();
    const result = await verifyTotp({ token: generateSync({ secret }), secret });
    expect(result.valid).toBe(true);

    // A watermark in the future stands for "a later code has since been used".
    const stale = await verifyTotp({
      token: generateSync({ secret }),
      secret,
      afterEpoch: (result.valid ? result.epoch : 0) + 300,
    });
    expect(stale.valid).toBe(false);
  });

  it('accepts a code when no period has been spent yet', async () => {
    const secret = generateMfaSecret();
    const result = await verifyTotp({ token: generateSync({ secret }), secret, afterEpoch: null });
    expect(result.valid).toBe(true);
  });
});

describe('the enrollment URI', () => {
  it('is an otpauth TOTP URI carrying the issuer and the account', () => {
    const uri = mfaEnrollmentUri({
      email: 'admin@pgp.test',
      secret: generateMfaSecret(),
      issuerLabel: 'Privilege Guest',
    });

    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain(encodeURIComponent('admin@pgp.test'));
    expect(uri).toContain('secret=');
  });
});

describe('recovery codes', () => {
  it('issues ten of them', () => {
    expect(generateRecoveryCodes()).toHaveLength(RECOVERY_CODE_COUNT);
  });

  it('excludes characters that are misread from a printout', () => {
    // No 0/O, no 1/I/L — these get read aloud and typed by someone locked out.
    for (const code of generateRecoveryCodes()) {
      expect(code).not.toMatch(/[01OIL]/);
      expect(code).toHaveLength(10);
    }
  });

  it('does not repeat within a batch', () => {
    const codes = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('forgives case and separators when typed back', () => {
    expect(normalizeRecoveryCode(' abcd-efgh23 ')).toBe('ABCDEFGH23');
  });

  it('verifies against its Argon2id hash, case-insensitively', async () => {
    const code = generateRecoveryCode();
    const hash = await hashRecoveryCode(code);

    await expect(verifyRecoveryCode(code, hash)).resolves.toBe(true);
    await expect(verifyRecoveryCode(code.toLowerCase(), hash)).resolves.toBe(true);
    await expect(verifyRecoveryCode(generateRecoveryCode(), hash)).resolves.toBe(false);
  });

  it('stores a hash, not the code', async () => {
    const code = generateRecoveryCode();
    const hash = await hashRecoveryCode(code);
    expect(hash).not.toContain(code);
    // Argon2id, matching the password parameters — same §3 requirements apply.
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });
});

describe('constant-time code comparison', () => {
  it('matches equal codes and rejects unequal ones', () => {
    expect(codesMatch('123456', '123456')).toBe(true);
    expect(codesMatch('123456', '123457')).toBe(false);
  });

  it('returns false on a length mismatch rather than throwing', () => {
    expect(codesMatch('123456', '1234567')).toBe(false);
  });
});
