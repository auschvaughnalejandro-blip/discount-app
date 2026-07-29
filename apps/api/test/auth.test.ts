/**
 * Stage 2 acceptance — everything that needs a database: refresh reuse
 * detection, the token-version check, OTP lockout, and login timing
 * uniformity. Pure JWT checks (alg: none, tampered claims, expiry, audience)
 * are in tokens.test.ts.
 */
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { issueOtp, verifyOtp } from '../src/security/otp.js';
import { PrincipalResolutionError, resolvePrincipal } from '../src/security/principal.js';
import { resetRateLimits } from '../src/security/rate-limit.js';
import {
  RefreshTokenError,
  issueRefreshToken,
  rotateRefreshToken,
} from '../src/security/refresh-tokens.js';
import { issueAccessToken } from '../src/security/tokens.js';

const ownerUrl = process.env['DATABASE_MIGRATION_URL'];
if (!ownerUrl) {
  throw new Error('DATABASE_MIGRATION_URL must be set to run auth.test.ts.');
}

let app: FastifyInstance;
let env: Env;
const ownerPrisma = new PrismaClient({ datasourceUrl: ownerUrl });

const REFRESH_TEST_SUBJECT = 'test-auth-refresh-subject';
const OTP_TEST_PHONE = '+97455559999';

beforeAll(async () => {
  env = loadEnv();
  app = await buildApp({ env });
  await app.ready();
});

afterAll(async () => {
  await ownerPrisma.refreshToken.deleteMany({ where: { subjectId: REFRESH_TEST_SUBJECT } });
  await ownerPrisma.otpCode.deleteMany({ where: { phone: OTP_TEST_PHONE } });
  await app.close();
  await ownerPrisma.$disconnect();
});

describe('replaying a used refresh token revokes the family and forces re-auth', () => {
  it('rejects the replayed token and also kills the legitimate successor', async () => {
    const first = await issueRefreshToken(ownerPrisma, {
      subjectId: REFRESH_TEST_SUBJECT,
      subjectType: 'STAFF',
      ttlSeconds: 3600,
    });

    const rotated = await rotateRefreshToken(ownerPrisma, first.token, 3600);
    expect(rotated.token).not.toBe(first.token);
    expect(rotated.familyId).toBe(first.familyId);

    // Replay: presenting the already-consumed original token again.
    await expect(rotateRefreshToken(ownerPrisma, first.token, 3600)).rejects.toMatchObject({
      reason: 'reuse_detected',
    } satisfies Partial<RefreshTokenError>);

    // The whole family is now dead — even the legitimately rotated successor
    // the real client is holding no longer works. This is what "forces
    // re-auth" means: there is no way to continue the chain.
    await expect(rotateRefreshToken(ownerPrisma, rotated.token, 3600)).rejects.toThrow(
      RefreshTokenError,
    );
  });
});

describe('incrementing tokenVersion invalidates existing access tokens', () => {
  it('rejects a still-unexpired, still-correctly-signed token once tv is bumped', async () => {
    const staff = await ownerPrisma.staffUser.findUniqueOrThrow({
      where: { email: 'admin@pgp.test' },
    });

    const token = await issueAccessToken({
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE_STAFF,
      subject: staff.id,
      subjectType: 'STAFF',
      role: staff.role,
      tokenVersion: staff.tokenVersion,
      ttlSeconds: 600,
    });

    const expected = { issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE_STAFF };

    const before = await resolvePrincipal(ownerPrisma, token, expected);
    expect(before.subjectId).toBe(staff.id);

    try {
      await ownerPrisma.staffUser.update({
        where: { id: staff.id },
        data: { tokenVersion: { increment: 1 } },
      });

      await expect(resolvePrincipal(ownerPrisma, token, expected)).rejects.toThrow(
        PrincipalResolutionError,
      );
    } finally {
      await ownerPrisma.staffUser.update({
        where: { id: staff.id },
        data: { tokenVersion: staff.tokenVersion },
      });
    }
  });
});

describe('OTP fails after 5 attempts', () => {
  it('locks out after the configured maximum, rejecting even the correct code afterward', async () => {
    const issued = await issueOtp(ownerPrisma, OTP_TEST_PHONE);
    const wrongCode = ((Number(issued.code) + 1) % 1_000_000).toString().padStart(6, '0');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await verifyOtp(ownerPrisma, OTP_TEST_PHONE, wrongCode);
      expect(result).toEqual({ ok: false, reason: 'mismatch' });
    }

    const finalAttempt = await verifyOtp(ownerPrisma, OTP_TEST_PHONE, issued.code);
    expect(finalAttempt).toEqual({ ok: false, reason: 'max_attempts' });
  });
});

describe('login timing does not differ measurably between existing and non-existent accounts', () => {
  it('takes comparable wall-clock time either way', async () => {
    resetRateLimits();

    const iterations = 5;
    const existingAccountTimes: number[] = [];
    const nonExistentAccountTimes: number[] = [];

    for (let i = 0; i < iterations; i += 1) {
      const startExisting = performance.now();
      await request(app.server)
        .post('/auth/staff/login')
        .send({ email: 'admin@pgp.test', password: 'definitely-the-wrong-password' });
      existingAccountTimes.push(performance.now() - startExisting);

      const startMissing = performance.now();
      await request(app.server)
        .post('/auth/staff/login')
        .send({ email: `nobody-${i}-${Date.now()}@pgp.test`, password: 'whatever' });
      nonExistentAccountTimes.push(performance.now() - startMissing);
    }

    const average = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
    const existingAvg = average(existingAccountTimes);
    const missingAvg = average(nonExistentAccountTimes);
    const ratio = Math.max(existingAvg, missingAvg) / Math.min(existingAvg, missingAvg);

    // Best-effort rather than exact: both paths run one real Argon2id
    // verification (against the real hash or the fixed dummy hash), so
    // timing should be close. A generous bound avoids flakiness on shared or
    // loaded hardware while still catching a genuinely missing dummy-hash
    // branch, which would make the non-existent-account path near-instant
    // and push the ratio well past this bound.
    expect(ratio).toBeLessThan(3);
  });
});
