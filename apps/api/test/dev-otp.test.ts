/**
 * The development OTP echo must be impossible to switch on outside
 * development.
 *
 * This prints a live credential to the log. The whole safety argument rests on
 * two independent gates, so the gates get their own tests — a feature that
 * leaks credentials when misconfigured is exactly the kind that gets
 * misconfigured.
 */
import { describe, expect, it } from 'vitest';

import { loadEnv } from '../src/config/env.js';
import { isDevOtpEchoEnabled } from '../src/security/dev-otp.js';

describe('the dev OTP echo is off unless both gates pass', () => {
  it('is on only in development with the flag explicitly true', () => {
    expect(isDevOtpEchoEnabled({ NODE_ENV: 'development', DEV_OTP_ECHO: true })).toBe(true);
  });

  it('is off in production even with the flag set', () => {
    // The case that matters: someone copies a development .env forward.
    expect(isDevOtpEchoEnabled({ NODE_ENV: 'production', DEV_OTP_ECHO: true })).toBe(false);
  });

  it('is off in test even with the flag set', () => {
    expect(isDevOtpEchoEnabled({ NODE_ENV: 'test', DEV_OTP_ECHO: true })).toBe(false);
  });

  it('is off in development without the flag', () => {
    // The other case that matters: NODE_ENV defaults to development, so the
    // environment alone must not be enough.
    expect(isDevOtpEchoEnabled({ NODE_ENV: 'development', DEV_OTP_ECHO: false })).toBe(false);
  });

  it('is off for every production-shaped configuration', () => {
    for (const nodeEnv of ['production', 'test'] as const) {
      for (const flag of [true, false]) {
        expect(isDevOtpEchoEnabled({ NODE_ENV: nodeEnv, DEV_OTP_ECHO: flag })).toBe(false);
      }
    }
  });
});

describe('the flag defaults off and fails closed on a typo', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/d',
    PASSWORD_PEPPER: 'x'.repeat(32),
    OTP_CODE_HMAC_SECRET: 'x'.repeat(32),
    JWT_ISSUER: 'i',
    JWT_AUDIENCE_MEMBER: 'm',
    JWT_AUDIENCE_STAFF: 's',
    JWT_SIGNING_KEY: 'x'.repeat(32),
    IDENTITY_CODE_HMAC_SECRET: 'x'.repeat(32),
  };

  it('is false when the variable is absent', () => {
    expect(loadEnv({ ...base }).DEV_OTP_ECHO).toBe(false);
  });

  it.each(['1', 'TRUE', 'True', 'yes', 'on', '', ' true'])(
    'is false for %o, which is not exactly "true"',
    (value) => {
      // A near-miss must not enable it. Anything looser would mean a stray
      // value in a deployment config quietly switching credentials into logs.
      expect(loadEnv({ ...base, DEV_OTP_ECHO: value }).DEV_OTP_ECHO).toBe(false);
    },
  );

  it('is true only for exactly "true"', () => {
    expect(loadEnv({ ...base, DEV_OTP_ECHO: 'true' }).DEV_OTP_ECHO).toBe(true);
  });
});

describe('the code never reaches an HTTP response', () => {
  it('is not returned by any route', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join, resolve } = await import('node:path');

    const routesDir = resolve(import.meta.dirname, '..', 'src', 'routes');
    const offenders = readdirSync(routesDir)
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => {
        const source = readFileSync(join(routesDir, file), 'utf8');
        // `issued.code` may be handed to the echo helper, never to `send`.
        return /send\([^)]*\bcode\b\s*[,:}]/.test(source) && source.includes('issueOtp');
      });

    expect(offenders).toEqual([]);
  });
});
