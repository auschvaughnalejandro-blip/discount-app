/**
 * `STAFF_MFA_REQUIRED` — the one switch that lets a dashboard password complete
 * sign-in on its own.
 *
 * ## Why it exists
 *
 * The second factor is a TOTP code. A developer without the secret in an
 * authenticator app has to run `npm run mfa:code` in a second terminal and read a
 * number that rolls over every thirty seconds — on every sign-in, all day, to
 * protect a database of fictional members on 127.0.0.1. The switch removes that.
 *
 * ## Why it is tested this hard
 *
 * Because it is a hole in §3 ("every dashboard account, without exception"), and
 * a hole is only acceptable while it is provably unreachable where it matters.
 * These tests pin three things: the default is on, production refuses to start
 * with it off, and turning it off skips the *second* factor and not the first.
 *
 * Signing in twice with the same TOTP code inside one 30-second window is
 * refused by Stage 19's replay check — correctly — so this file uses its own
 * account rather than the seeded administrator, the way session-cookie.test.ts
 * does and for the same reason.
 */
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { encryptMfaSecret, generateMfaSecret } from '../src/security/mfa.js';
import { hashPassword } from '../src/security/password.js';
import { resetRateLimits } from '../src/security/rate-limit.js';
import { REFRESH_COOKIE } from '../src/security/session-cookie.js';

const ownerUrl = process.env['DATABASE_MIGRATION_URL'];
if (!ownerUrl) {
  throw new Error('DATABASE_MIGRATION_URL must be set to run staff-mfa-gate.test.ts.');
}

const ownerPrisma = new PrismaClient({ datasourceUrl: ownerUrl });

const ACCOUNT_EMAIL = `mfa-gate-${Date.now()}@pgp.test`;
const ACCOUNT_PASSWORD = 'mfa-gate-test-password-8823';

/** With the second factor required, as every deployment runs. */
let enforcing: FastifyInstance;
/** With it switched off, as a developer's machine may run. */
let relaxed: FastifyInstance;
let accountId: string;

beforeAll(async () => {
  // Enrolled from the start: this file never presents a TOTP code, and an
  // unenrolled account would take the `stage: 'enroll'` branch instead, which is
  // not the branch under test.
  const account = await ownerPrisma.staffUser.create({
    data: {
      fullName: 'MFA Gate Test Admin',
      email: ACCOUNT_EMAIL,
      passwordHash: await hashPassword(ACCOUNT_PASSWORD),
      role: 'ADMINISTRATOR',
      mfaSecret: encryptMfaSecret(generateMfaSecret()),
      mfaEnrolledAt: new Date(),
    },
    select: { id: true },
  });
  accountId = account.id;

  enforcing = await buildApp({ env: loadEnv({ ...process.env, STAFF_MFA_REQUIRED: 'true' }) });
  relaxed = await buildApp({ env: loadEnv({ ...process.env, STAFF_MFA_REQUIRED: 'false' }) });
  await Promise.all([enforcing.ready(), relaxed.ready()]);

  resetRateLimits();
});

afterAll(async () => {
  await ownerPrisma.refreshToken.deleteMany({ where: { subjectId: accountId } });
  await ownerPrisma.auditLog.deleteMany({ where: { subjectId: accountId } });
  await ownerPrisma.mfaRecoveryCode.deleteMany({ where: { staffUserId: accountId } });
  await ownerPrisma.staffUser.delete({ where: { id: accountId } });
  await Promise.all([enforcing.close(), relaxed.close()]);
  await ownerPrisma.$disconnect();
});

describe('the switch cannot weaken a live deployment', () => {
  it('requires the second factor unless something says otherwise', () => {
    // Deleted rather than left as `process.env` has it: `test/setup.ts` pins the
    // variable, and asserting a *default* against a value something else set
    // would prove only that the pin works.
    const { STAFF_MFA_REQUIRED: _unset, ...withoutTheVariable } = process.env;

    // The default is the safe value, so an operator who has never heard of this
    // variable gets §3's behaviour.
    expect(loadEnv(withoutTheVariable).STAFF_MFA_REQUIRED).toBe(true);
  });

  it('treats anything other than the exact string "false" as required', () => {
    // A typo must fail closed. `'no'`, `'0'` and `'False'` all mean "on" here —
    // the alternative is a mistyped value silently disabling a second factor.
    for (const value of ['no', '0', 'False', 'FALSE', 'off', '']) {
      expect(loadEnv({ ...process.env, STAFF_MFA_REQUIRED: value }).STAFF_MFA_REQUIRED).toBe(true);
    }
  });

  it('refuses to start at all when switched off in production', () => {
    // A boot failure, not a logged warning: §3 admits no exception, and a
    // misconfigured production API must not be reachable with one factor for
    // however long it takes somebody to read a log.
    expect(() =>
      loadEnv({ ...process.env, NODE_ENV: 'production', STAFF_MFA_REQUIRED: 'false' }),
    ).toThrow(/STAFF_MFA_REQUIRED/);
  });

  it('starts happily when switched off outside production', () => {
    expect(
      loadEnv({ ...process.env, NODE_ENV: 'development', STAFF_MFA_REQUIRED: 'false' })
        .STAFF_MFA_REQUIRED,
    ).toBe(false);
  });
});

describe('with the second factor required', () => {
  it('answers a correct password with a challenge and no tokens', async () => {
    const response = await request(enforcing.server)
      .post('/auth/staff/login')
      .send({ email: ACCOUNT_EMAIL, password: ACCOUNT_PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body.mfaRequired).toBe(true);
    expect(response.body.challengeToken).toBeTruthy();

    // The property that matters: a password alone yields nothing that opens a
    // single admin route, and no session cookie to resume from later.
    expect(response.body.accessToken).toBeUndefined();
    expect(response.body.refreshToken).toBeUndefined();
    const cookies = (response.headers['set-cookie'] ?? []) as string[];
    expect(cookies.find((value) => value.startsWith(`${REFRESH_COOKIE}=`))).toBeUndefined();
  });
});

describe('with the second factor switched off', () => {
  it('completes sign-in on the password alone', async () => {
    resetRateLimits();

    const response = await request(relaxed.server)
      .post('/auth/staff/login')
      .send({ email: ACCOUNT_EMAIL, password: ACCOUNT_PASSWORD });

    expect(response.status).toBe(200);
    // Explicitly false rather than absent — the dashboard branches on this, and a
    // missing field meaning "you are in" is a shape a later edit inverts by
    // accident.
    expect(response.body.mfaRequired).toBe(false);
    expect(response.body.challengeToken).toBeUndefined();
    expect(response.body.accessToken).toBeTruthy();

    // A real session, not a token-shaped consolation prize: the refresh cookie
    // has to be set too, or the dashboard signs the developer out again on the
    // first page reload.
    const cookies = (response.headers['set-cookie'] ?? []) as string[];
    expect(cookies.find((value) => value.startsWith(`${REFRESH_COOKIE}=`))).toBeDefined();

    // And the token opens an administrator route, which is the only claim about
    // it anybody cares about.
    const members = await request(relaxed.server)
      .get('/admin/members')
      .set('Authorization', `Bearer ${response.body.accessToken as string}`);
    expect(members.status).toBe(200);
  });

  it('still refuses a wrong password', async () => {
    resetRateLimits();

    // The switch removes the second factor. It is not a way past the first one,
    // and a test that only checked the happy path would not notice if it became
    // one.
    const response = await request(relaxed.server)
      .post('/auth/staff/login')
      .send({ email: ACCOUNT_EMAIL, password: `${ACCOUNT_PASSWORD}-wrong` });

    expect(response.status).toBe(401);
    expect(response.body.accessToken).toBeUndefined();
  });

  it('records the skip as its own audit action', async () => {
    resetRateLimits();

    await request(relaxed.server)
      .post('/auth/staff/login')
      .send({ email: ACCOUNT_EMAIL, password: ACCOUNT_PASSWORD });

    const actions = await ownerPrisma.auditLog.findMany({
      where: { subjectId: accountId },
      select: { action: true },
    });

    // §9 wants every authentication event, and "signed in without a second
    // factor" is not the same event as "signed in". Rolling them together would
    // hide the only rows that could show a misconfiguration after the fact.
    expect(actions.map((row) => row.action)).toContain('auth.mfa.skipped');
  });
});
