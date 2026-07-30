/**
 * Signs a staff account in the way a real client has to, since Stage 19.
 *
 * A dashboard account no longer gets tokens from a password: it gets a
 * challenge, and must present a second factor. Tests that need an authenticated
 * administrator therefore have to walk the same path the admin client walks,
 * which is the point — a test that bypassed MFA would stop proving the journey
 * works.
 *
 * Outlet staff are returned straight through, because §3 does not require MFA
 * for an account that reaches only the verification page.
 */
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { generateSync } from 'otplib';
import request from 'supertest';
import { expect } from 'vitest';

import { decryptMfaSecret } from '../../src/security/mfa.js';

/**
 * Owner-scoped client, so the helper can read `mfaSecret`.
 *
 * Enrollment persists: once a test run has enrolled the seeded administrator,
 * every later run — and every other test file in the same run — finds the
 * account at `stage: 'verify'`. Recovering the secret from the row is what makes
 * this helper idempotent, and it is the only reasonable option, since the whole
 * point of TOTP is that the server cannot be talked out of wanting a code.
 */
let ownerPrisma: PrismaClient | null = null;

function owner(): PrismaClient {
  const url = process.env['DATABASE_MIGRATION_URL'];
  if (!url) {
    throw new Error('DATABASE_MIGRATION_URL must be set to sign a staff account in.');
  }
  ownerPrisma ??= new PrismaClient({ datasourceUrl: url });
  return ownerPrisma;
}

export interface StaffSession {
  accessToken: string;
  refreshToken: string;
  /** Present only when this call performed enrollment. */
  recoveryCodes?: string[];
  /** The TOTP secret, so a test can produce further codes for the same account. */
  mfaSecret?: string;
}

export async function signInStaff(
  app: FastifyInstance,
  credentials: { email: string; password: string },
): Promise<StaffSession> {
  const login = await request(app.server).post('/auth/staff/login').send(credentials);
  expect(login.status).toBe(200);

  // OUTLET_STAFF: password alone, no challenge.
  if (!login.body.mfaRequired) {
    expect(login.body.accessToken).toBeTruthy();
    return { accessToken: login.body.accessToken, refreshToken: login.body.refreshToken };
  }

  const challengeToken = login.body.challengeToken as string;
  expect(challengeToken).toBeTruthy();
  // A challenge must never itself be usable as an access token.
  expect(login.body.accessToken).toBeUndefined();

  if (login.body.stage === 'enroll') {
    const started = await request(app.server)
      .post('/auth/staff/mfa/enroll')
      .send({ challengeToken });
    expect(started.status).toBe(200);

    const secret = started.body.secret as string;
    const confirmed = await request(app.server)
      .post('/auth/staff/mfa/enroll/confirm')
      .send({ challengeToken, code: generateSync({ secret }) });
    expect(confirmed.status).toBe(200);

    return {
      accessToken: confirmed.body.accessToken,
      refreshToken: confirmed.body.refreshToken,
      recoveryCodes: confirmed.body.recoveryCodes,
      mfaSecret: secret,
    };
  }

  // Already enrolled — read the stored secret and produce a code from it.
  const staff = await owner().staffUser.findUnique({
    where: { email: credentials.email },
    select: { mfaSecret: true },
  });
  expect(staff?.mfaSecret).toBeTruthy();

  const secret = decryptMfaSecret(staff!.mfaSecret!);
  const verified = await request(app.server)
    .post('/auth/staff/mfa/verify')
    .send({ challengeToken, code: generateSync({ secret }) });
  expect(verified.status).toBe(200);

  return {
    accessToken: verified.body.accessToken,
    refreshToken: verified.body.refreshToken,
    mfaSecret: secret,
  };
}

/** Signs in an account already enrolled, using a secret a previous call returned. */
export async function signInEnrolledStaff(
  app: FastifyInstance,
  credentials: { email: string; password: string },
  mfaSecret: string,
): Promise<StaffSession> {
  const login = await request(app.server).post('/auth/staff/login').send(credentials);
  expect(login.status).toBe(200);
  expect(login.body.stage).toBe('verify');

  const verified = await request(app.server)
    .post('/auth/staff/mfa/verify')
    .send({ challengeToken: login.body.challengeToken, code: generateSync({ secret: mfaSecret }) });
  expect(verified.status).toBe(200);

  return {
    accessToken: verified.body.accessToken,
    refreshToken: verified.body.refreshToken,
    mfaSecret,
  };
}
