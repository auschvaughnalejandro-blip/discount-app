/**
 * The refresh token as an `httpOnly` cookie — security-implementation.md §4.
 *
 * The clients previously held it in a module variable, which no injected script
 * could read and no page reload survived. That cost a member a fresh passcode
 * every time they opened the app, which is how an app stops being opened.
 *
 * The cookie buys the persistence back without giving up the property that made
 * memory worth the friction, and everything that matters about it lives in the
 * attributes — a cookie set without `httpOnly` is `localStorage` with extra
 * steps, and one without `SameSite` needs a CSRF token this system does not
 * have. Neither mistake changes any behaviour a person would notice, which is
 * why they are asserted rather than eyeballed.
 *
 * ## Why this file signs in once, with its own account
 *
 * Presenting the same TOTP code twice inside its 30-second window is refused by
 * Stage 19's replay protection — correctly. That makes signing in twice a
 * problem *within* this file, and sharing the seeded administrator a problem
 * *between* files, since any other suite signing in as them during the same
 * window consumes the code this one was about to use.
 *
 * So: a dedicated account, signed into once, walked forward step by step. Which
 * also happens to be the shape of the thing under test — a session is a
 * sequence, not a set of independent facts.
 */
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { generateSync } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { encryptMfaSecret, generateMfaSecret } from '../src/security/mfa.js';
import { hashPassword } from '../src/security/password.js';
import { resetRateLimits } from '../src/security/rate-limit.js';
import { REFRESH_COOKIE, REFRESH_COOKIE_PATH } from '../src/security/session-cookie.js';

const ownerUrl = process.env['DATABASE_MIGRATION_URL'];
if (!ownerUrl) {
  throw new Error('DATABASE_MIGRATION_URL must be set to run session-cookie.test.ts.');
}

let app: FastifyInstance;
let env: Env;
const ownerPrisma = new PrismaClient({ datasourceUrl: ownerUrl });

const ACCOUNT_EMAIL = `session-cookie-${Date.now()}@pgp.test`;
const ACCOUNT_PASSWORD = 'session-cookie-test-password-4417';

/** The Set-Cookie header for the refresh cookie, if one was sent. */
function refreshHeader(response: { headers: Record<string, unknown> }): string | undefined {
  const values = (response.headers['set-cookie'] ?? []) as string[];
  return values.find((value) => value.startsWith(`${REFRESH_COOKIE}=`));
}

/** `name=value`, ready to send back as a Cookie header. */
function cookiePair(header: string | undefined): string {
  return header?.split(';')[0] ?? '';
}

/**
 * The session, advanced by the tests in order.
 *
 * One token, two transports. The cookie and the body carry the *same* value, so
 * spending it either way rotates both — which is why every step below records
 * the replacement rather than holding on to what it started with. A test that
 * kept the original and presented it later would be replaying a spent token,
 * and would trip family revocation rather than proving anything.
 */
let signInHeader: string | undefined;
let currentCookie = '';
let currentToken = '';

beforeAll(async () => {
  env = loadEnv();
  app = await buildApp({ env });
  await app.ready();

  // Created already enrolled, so the sign-in below is one TOTP presentation on
  // an account nothing else touches.
  const secret = generateMfaSecret();
  await ownerPrisma.staffUser.create({
    data: {
      fullName: 'Session Cookie Test Admin',
      email: ACCOUNT_EMAIL,
      passwordHash: await hashPassword(ACCOUNT_PASSWORD),
      role: 'ADMINISTRATOR',
      mfaSecret: encryptMfaSecret(secret),
      mfaEnrolledAt: new Date(),
    },
  });

  const login = await request(app.server)
    .post('/auth/staff/login')
    .send({ email: ACCOUNT_EMAIL, password: ACCOUNT_PASSWORD });
  expect(login.status).toBe(200);

  const verified = await request(app.server)
    .post('/auth/staff/mfa/verify')
    .send({ challengeToken: login.body.challengeToken, code: generateSync({ secret }) });
  expect(verified.status).toBe(200);

  signInHeader = refreshHeader(verified);
  currentCookie = cookiePair(signInHeader);
  currentToken = verified.body.refreshToken as string;

  resetRateLimits();
});

afterAll(async () => {
  const account = await ownerPrisma.staffUser.findUnique({
    where: { email: ACCOUNT_EMAIL },
    select: { id: true },
  });
  if (account) {
    await ownerPrisma.refreshToken.deleteMany({
      where: { subjectId: account.id, subjectType: 'STAFF' },
    });
    await ownerPrisma.staffUser.delete({ where: { id: account.id } });
  }
  await app.close();
  await ownerPrisma.$disconnect();
});

describe('§4 — the refresh token is a cookie no script can read', () => {
  it('sets httpOnly, SameSite=Strict, and scopes it to the refresh endpoint', () => {
    expect(signInHeader, 'signing in set no refresh cookie').toBeDefined();

    // Without this the cookie is readable by `document.cookie`, and the whole
    // exercise has moved the token from one script-readable place to another.
    expect(signInHeader).toMatch(/HttpOnly/i);

    // Without this the browser attaches it to requests other sites trigger,
    // and the absence of a CSRF token starts to matter.
    expect(signInHeader).toMatch(/SameSite=Strict/i);

    // A cookie sent to every route is a cookie every route could be tricked
    // into acting on. Exactly one endpoint reads this.
    expect(signInHeader).toMatch(new RegExp(`Path=${REFRESH_COOKIE_PATH}`, 'i'));
  });

  it('refreshes from the cookie alone, with nothing in the body', async () => {
    // This is the whole point: the page holds no token and the session
    // continues anyway, because the browser carries the cookie.
    const refreshed = await request(app.server)
      .post('/auth/refresh')
      .set('Cookie', currentCookie)
      .send({});

    expect(refreshed.status).toBe(200);
    expect(refreshed.body.accessToken).toBeTruthy();

    // Rotation replaces the token, so it has to replace the cookie too. A
    // browser left holding the spent one would trigger family revocation on
    // its next use and log the member out for no reason they could see.
    const rotated = refreshHeader(refreshed);
    expect(rotated, 'rotation did not update the cookie').toBeDefined();
    expect(cookiePair(rotated)).not.toBe(currentCookie);

    currentCookie = cookiePair(rotated);
    currentToken = refreshed.body.refreshToken as string;
  });

  it('refuses, and clears, a token that is not valid', async () => {
    const response = await request(app.server)
      .post('/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=not-a-real-token`)
      .send({});

    expect(response.status).toBe(401);
    // Otherwise the browser replays a dead token on every load, forever.
    expect(refreshHeader(response)).toMatch(new RegExp(`^${REFRESH_COOKIE}=;`));
  });

  it('still accepts a refresh token in the body, for a native shell', async () => {
    // A wrapped app has a platform keystore and no cookie jar. Dropping body
    // support would strand it — and would log out every existing session the
    // moment this deployed.
    const refreshed = await request(app.server)
      .post('/auth/refresh')
      .send({ refreshToken: currentToken });

    expect(refreshed.status).toBe(200);

    // The server sets the cookie on this path too, so a client that started in
    // the body and later gained a cookie jar converges rather than ending up
    // with two views of one session.
    currentCookie = cookiePair(refreshHeader(refreshed));
    currentToken = refreshed.body.refreshToken as string;
  });

  it('clears the cookie on logout, and revokes the token behind it', async () => {
    const response = await request(app.server)
      .post('/auth/logout')
      .set('Cookie', currentCookie)
      .send({});

    expect(response.status).toBe(200);
    expect(refreshHeader(response)).toMatch(new RegExp(`^${REFRESH_COOKIE}=;`));

    // Clearing the browser's copy is not enough on its own: anyone who had
    // captured the value would still be able to use it.
    const replay = await request(app.server)
      .post('/auth/refresh')
      .set('Cookie', currentCookie)
      .send({});
    expect(replay.status).toBe(401);
  });
});
