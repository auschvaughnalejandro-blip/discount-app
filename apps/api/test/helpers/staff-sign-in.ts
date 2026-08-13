/**
 * Signs a staff account in the way a real client has to, since Stage 19.
 *
 * A staff account no longer gets tokens from a password: it gets a challenge,
 * and must present a second factor. Administrator is the only active staff
 * role, so a password-only success would be a security regression. Tests that
 * need an authenticated administrator therefore walk the same path the admin
 * client walks.
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

/**
 * Clear this account's TOTP replay marker, so the code about to be generated is
 * accepted regardless of when the account last signed in.
 *
 * ## The flake this removes
 *
 * `StaffUser.mfaLastUsedEpoch` records the period of the last code an account
 * accepted, and `verifyTotp` refuses anything at or before it — deliberately, so
 * a code read over a shoulder cannot be reused inside its ~90-second validity.
 *
 * That column is in the database, so it outlives the process. Run the suite twice
 * inside thirty seconds and the second run generates a code for a period the
 * first run already spent: `mfa/verify` answers 401, `signInStaff` fails its
 * status assertion, and all twelve `acceptance-journey` steps cascade — with
 * nothing in the output naming a TOTP period, so the first thing it resembles is
 * a broken authentication change. That is precisely the wrong conclusion, and it
 * cost an investigation to rule out.
 *
 * ## Why a reset, and not a wait or a skew trick
 *
 * Waiting for the next period was the first attempt and is wrong twice over: it
 * blows vitest's 5-second per-test budget (the sign-in happens inside `it`, not a
 * hook), and it is unbounded across chained runs, since the previous run may
 * itself have consumed a period ahead of the clock. Generating a code for the
 * *next* period instead — accepted under the ±30s `epochTolerance` — fixes the
 * timeout but not the chaining: two fast runs in a row push the first unspent
 * period outside the tolerance window and it fails again.
 *
 * Clearing the marker is instant, bounded and independent of the clock. It gives
 * a shared account the same isolation `session-cookie.test.ts` gets structurally
 * by owning its account — which remains the better answer wherever a file *can*
 * own one. `acceptance-journey.test.ts` cannot: it signs in as the *seeded*
 * administrator on purpose, because it asserts the journey a real operator walks,
 * and inventing an account for it would quietly stop testing that.
 *
 * Nothing is given up. Replay protection is asserted directly, against its own
 * account and its own recorded epoch, in `mfa.test.ts` and `auth.test.ts`. No
 * caller of this helper is testing it — they need a working administrator session,
 * and a code this helper just generated is not a replay of anything.
 */
async function clearReplayMarker(email: string): Promise<void> {
  await owner().staffUser.updateMany({
    where: { email },
    data: { mfaLastUsedEpoch: null },
  });
}

export async function signInStaff(
  app: FastifyInstance,
  credentials: { email: string; password: string },
): Promise<StaffSession> {
  const login = await request(app.server).post('/auth/staff/login').send(credentials);
  expect(login.status).toBe(200);
  expect(login.body.mfaRequired).toBe(true);

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
  await clearReplayMarker(credentials.email);

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

  // Same replay hazard as `signInStaff`; a caller holding the secret is no less
  // subject to the period this account has already spent.
  await clearReplayMarker(credentials.email);

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
