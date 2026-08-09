/**
 * Stage 25 — staff accounts.
 *
 * The gap PROGRESS.md carried from Stage 12: `StaffUser.tokenVersion` and
 * `status` were the mechanism behind §3's "instant revocation from the
 * dashboard", both worked, and no endpoint reached either. Offboarding was a
 * manual UPDATE against production.
 *
 * The tests that matter here are the revocation ones: suspending has to kill a
 * live session, not wait for a token to expire.
 */
import { PrismaClient, type Role } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { screenPassword } from '../src/security/breached-passwords.js';
import { hashPassword } from '../src/security/password.js';
import { resetRateLimits } from '../src/security/rate-limit.js';
import { issueAccessToken } from '../src/security/tokens.js';

const ownerUrl = process.env['DATABASE_MIGRATION_URL'];
if (!ownerUrl) {
  throw new Error('DATABASE_MIGRATION_URL must be set to run staff-management.test.ts.');
}

let app: FastifyInstance;
let env: Env;
const ownerPrisma = new PrismaClient({ datasourceUrl: ownerUrl });

let adminToken: string;
let adminId: string;

/** Long, and not in any breach corpus. */
const GOOD_PASSWORD = 'correct-horse-battery-staple-9471';
const RETIRED_ROLES = ['MANAGER', 'OUTLET_STAFF', 'SUPPORT'] as const satisfies readonly Role[];
type RetiredRole = (typeof RETIRED_ROLES)[number];

function email(label: string): string {
  return `stafftest-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@pgp.test`;
}

async function tokenFor(id: string) {
  const staff = await ownerPrisma.staffUser.findUniqueOrThrow({ where: { id } });
  return issueAccessToken({
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE_STAFF,
    subject: staff.id,
    subjectType: 'STAFF',
    role: 'ADMINISTRATOR',
    tokenVersion: staff.tokenVersion,
    ttlSeconds: 900,
  });
}

async function createRetiredStaff(role: RetiredRole) {
  const outlet =
    role === 'OUTLET_STAFF'
      ? await ownerPrisma.outlet.findFirstOrThrow({ where: { active: true } })
      : null;

  return ownerPrisma.staffUser.create({
    data: {
      fullName: `Retired ${role}`,
      email: email(`retired-${role.toLowerCase()}`),
      passwordHash: await hashPassword(GOOD_PASSWORD),
      role,
      outletId: outlet?.id ?? null,
      // Retired enum values are retained only for historical attribution. The
      // database constraint permits them only in this suspended state.
      status: 'SUSPENDED',
    },
  });
}

beforeAll(async () => {
  env = loadEnv();
  app = await buildApp({ env });
  await app.ready();

  const admin = await ownerPrisma.staffUser.findUniqueOrThrow({
    where: { email: 'admin@pgp.test' },
  });
  adminId = admin.id;
  adminToken = await tokenFor(admin.id);
});

afterEach(() => {
  resetRateLimits();
});

afterAll(async () => {
  const created = await ownerPrisma.staffUser.findMany({
    where: { email: { startsWith: 'stafftest-' } },
    select: { id: true },
  });
  const ids = created.map((s) => s.id);
  await ownerPrisma.mfaRecoveryCode.deleteMany({ where: { staffUserId: { in: ids } } });
  await ownerPrisma.refreshToken.deleteMany({
    where: { subjectId: { in: ids }, subjectType: 'STAFF' },
  });
  await ownerPrisma.staffUser.deleteMany({ where: { id: { in: ids } } });
  await app.close();
  await ownerPrisma.$disconnect();
});

// ── Creating ───────────────────────────────────────────────────────────────

describe('creating a staff account', () => {
  it('creates one and never returns the password hash or MFA secret', async () => {
    const response = await request(app.server)
      .post('/admin/staff')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        fullName: 'New Administrator',
        email: email('create'),
        password: GOOD_PASSWORD,
      });

    expect(response.status).toBe(201);
    expect(response.body.role).toBe('ADMINISTRATOR');
    expect(response.body).not.toHaveProperty('passwordHash');
    expect(response.body).not.toHaveProperty('mfaSecret');
    // Not yet enrolled: they must set up a second factor before reaching
    // anything, which §3 requires without exception.
    expect(response.body.mfaEnrolledAt).toBeNull();
  });

  it.each(RETIRED_ROLES)('refuses the retired %s role', async (role) => {
    const address = email(`create-${role.toLowerCase()}`);
    const response = await request(app.server)
      .post('/admin/staff')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        fullName: `Not a ${role}`,
        email: address,
        role,
        password: GOOD_PASSWORD,
      });

    expect(response.status).toBe(400);
    await expect(ownerPrisma.staffUser.findUnique({ where: { email: address } })).resolves.toBeNull();
  });

  it('does not accept an outlet scope on a new administrator', async () => {
    const outlet = await ownerPrisma.outlet.findFirstOrThrow({ where: { active: true } });
    const response = await request(app.server)
      .post('/admin/staff')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        fullName: 'Scoped Administrator',
        email: email('outlet-scope'),
        outletId: outlet.id,
        password: GOOD_PASSWORD,
      });

    expect(response.status).toBe(400);
  });

  it('refuses a duplicate email address', async () => {
    const address = email('dupe');
    const first = await request(app.server)
      .post('/admin/staff')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fullName: 'First', email: address, password: GOOD_PASSWORD });
    expect(first.status).toBe(201);

    const second = await request(app.server)
      .post('/admin/staff')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fullName: 'Second', email: address, password: GOOD_PASSWORD });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('email_already_used');
  });

  it.each(RETIRED_ROLES)(
    'rejects an old access token belonging to a stored retired %s account',
    async (role) => {
      const retired = await createRetiredStaff(role);
      const token = await issueAccessToken({
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE_STAFF,
        subject: retired.id,
        subjectType: 'STAFF',
        role: 'ADMINISTRATOR',
        tokenVersion: retired.tokenVersion,
        ttlSeconds: 900,
      });

      const response = await request(app.server)
        .post('/admin/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({ fullName: 'X', email: email('retired-token'), password: GOOD_PASSWORD });

      expect(response.status).toBe(401);
    },
  );
});

describe('retired staff accounts cannot sign in', () => {
  it.each(RETIRED_ROLES)(
    'returns the uniform credential failure for a correct-password %s account',
    async (role) => {
      const retired = await createRetiredStaff(role);
      const response = await request(app.server)
        .post('/auth/staff/login')
        .send({ email: retired.email, password: GOOD_PASSWORD });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'invalid_credentials', message: 'Invalid credentials.' });
      expect(response.body).not.toHaveProperty('challengeToken');
      expect(response.body).not.toHaveProperty('accessToken');
      expect(response.body).not.toHaveProperty('refreshToken');
      expect(response.headers['set-cookie']).toBeUndefined();
    },
  );
});

// ── §3: passwords ──────────────────────────────────────────────────────────

describe('§3 — minimum length, screened against a breach list', () => {
  it('refuses a short password', async () => {
    const response = await request(app.server)
      .post('/admin/staff')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fullName: 'Short', email: email('short'), password: 'short1' });

    // Rejected by the schema before the handler, which is the right place.
    expect(response.status).toBe(400);
  });

  it('refuses a password known to be breached', async () => {
    // A stubbed HIBP response rather than the real service: the suite must not
    // depend on an external host, and this exercises the comparison itself.
    // SHA-1 of "Password123!" — suffix taken from the same hash the code
    // computes, so the match is real rather than asserted.
    const { createHash } = await import('node:crypto');
    const sha1 = createHash('sha1').update('Password123!', 'utf8').digest('hex').toUpperCase();

    const result = await screenPassword('Password123!', {
      fetchImpl: (async () =>
        new Response(`${sha1.slice(5)}:34291\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0\n`, {
          status: 200,
        })) as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.screened).toBe(true);
    if (!result.ok && result.reason === 'breached') {
      expect(result.occurrences).toBe(34_291);
    }
  });

  it('allows a password the list does not know', async () => {
    const result = await screenPassword(GOOD_PASSWORD, {
      fetchImpl: (async () =>
        new Response('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:12\n', { status: 200 })) as never,
    });

    expect(result.ok).toBe(true);
    expect(result.screened).toBe(true);
  });

  it('fails open, and says so, when the breach list is unreachable', async () => {
    // An outage must not stop somebody changing a password — the ones people
    // most urgently want to change are the ones already compromised.
    const result = await screenPassword(GOOD_PASSWORD, {
      fetchImpl: (async () => {
        throw new Error('network down');
      }) as never,
    });

    expect(result.ok).toBe(true);
    expect(result.screened).toBe(false);
  });

  it('never sends the password anywhere — only five hash characters', async () => {
    let requested = '';
    await screenPassword('a-very-secret-password-nobody-knows', {
      fetchImpl: (async (url: string) => {
        requested = String(url);
        return new Response('', { status: 200 });
      }) as never,
    });

    expect(requested).not.toContain('a-very-secret-password');
    expect(requested).toMatch(/\/range\/[0-9A-F]{5}$/);
  });
});

// ── §3: instant revocation ─────────────────────────────────────────────────

describe('§3 — instant revocation from the dashboard', () => {
  it('kills a live session the moment an account is suspended', async () => {
    const created = await request(app.server)
      .post('/admin/staff')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        fullName: 'Departing Administrator',
        email: email('revoke'),
        password: GOOD_PASSWORD,
      });
    expect(created.status).toBe(201);

    // A valid, unexpired token — the sort somebody walks out of the building
    // still holding.
    const theirToken = await tokenFor(created.body.id);
    const before = await request(app.server)
      .get('/admin/members')
      .set('Authorization', `Bearer ${theirToken}`);
    expect(before.status).toBe(200);

    const suspended = await request(app.server)
      .post(`/admin/staff/${created.body.id}/suspend`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(suspended.status).toBe(200);
    expect(suspended.body.status).toBe('SUSPENDED');

    // The same token, still within its lifetime, now reaches nothing.
    const after = await request(app.server)
      .get('/admin/members')
      .set('Authorization', `Bearer ${theirToken}`);
    expect(after.status).toBe(401);
  });

  it('reinstates without handing back the old tokens', async () => {
    const created = await request(app.server)
      .post('/admin/staff')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        fullName: 'Returning Administrator',
        email: email('reinstate'),
        password: GOOD_PASSWORD,
      });

    const theirToken = await tokenFor(created.body.id);

    await request(app.server)
      .post(`/admin/staff/${created.body.id}/suspend`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    await request(app.server)
      .post(`/admin/staff/${created.body.id}/reinstate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    // Reinstated, but the token issued before the suspension stays dead.
    const after = await request(app.server)
      .get('/admin/members')
      .set('Authorization', `Bearer ${theirToken}`);
    expect(after.status).toBe(401);
  });

  it('refuses to suspend the last active administrator', async () => {
    const response = await request(app.server)
      .post(`/admin/staff/${adminId}/suspend`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    // Self-suspension is caught first; either way the dashboard cannot be
    // locked by a single click.
    expect(response.status).toBe(409);
  });
});

// ── MFA reset ──────────────────────────────────────────────────────────────

describe('resetting a lost second factor', () => {
  it('clears the secret and its recovery codes, and forces re-enrollment', async () => {
    const created = await request(app.server)
      .post('/admin/staff')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        fullName: 'Lost Authenticator',
        email: email('mfa'),
        password: GOOD_PASSWORD,
      });

    // Enrolled, with recovery codes, as a real account would be.
    await ownerPrisma.staffUser.update({
      where: { id: created.body.id },
      data: { mfaSecret: 'pretend-ciphertext', mfaEnrolledAt: new Date() },
    });
    await ownerPrisma.mfaRecoveryCode.create({
      data: { staffUserId: created.body.id, codeHash: 'pretend-hash' },
    });

    const response = await request(app.server)
      .post(`/admin/staff/${created.body.id}/reset-mfa`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(response.status).toBe(200);

    const after = await ownerPrisma.staffUser.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(after.mfaSecret).toBeNull();
    expect(after.mfaEnrolledAt).toBeNull();

    // The old codes belonged to the old secret.
    const codes = await ownerPrisma.mfaRecoveryCode.count({
      where: { staffUserId: created.body.id },
    });
    expect(codes).toBe(0);
  });

  it('refuses to reset your own', async () => {
    // A stolen dashboard session must not be able to clear the second factor
    // that protects it. Clearing one always takes a different account.
    const response = await request(app.server)
      .post(`/admin/staff/${adminId}/reset-mfa`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('cannot_reset_own_mfa');
  });
});

// ── Changing your own password ─────────────────────────────────────────────

describe('a staff member changes their own password', () => {
  it('requires the current one', async () => {
    const address = email('self-pw');
    const created = await request(app.server)
      .post('/admin/staff')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fullName: 'Self Service', email: address, password: GOOD_PASSWORD });

    const theirToken = await tokenFor(created.body.id);

    const wrong = await request(app.server)
      .post('/auth/staff/password')
      .set('Authorization', `Bearer ${theirToken}`)
      .send({ currentPassword: 'not-the-right-one-at-all', newPassword: `${GOOD_PASSWORD}-b` });
    expect(wrong.status).toBe(401);

    const right = await request(app.server)
      .post('/auth/staff/password')
      .set('Authorization', `Bearer ${theirToken}`)
      .send({ currentPassword: GOOD_PASSWORD, newPassword: `${GOOD_PASSWORD}-b` });
    expect(right.status).toBe(200);

    // §4: a password change invalidates outstanding tokens, including the one
    // that made the change.
    const after = await request(app.server)
      .get('/admin/members')
      .set('Authorization', `Bearer ${theirToken}`);
    expect(after.status).toBe(401);
  });
});
