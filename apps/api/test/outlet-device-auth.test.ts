/**
 * Per-device outlet credentials.
 *
 * A standing device token is not a session token. It is shown once when an
 * administrator provisions (or rotates) one counter device, stored only as a
 * SHA-256 hash, and exchanged for the same short access token and rotating
 * refresh session used by the rest of the application.
 *
 * These are integration tests: they need the migrated, seeded PostgreSQL
 * database described in test/data-model.test.ts. Files run serially because the
 * suite deliberately shares that database (see vitest.config.ts).
 */
import { createHash, randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { resetRateLimits } from '../src/security/rate-limit.js';
import { REFRESH_COOKIE } from '../src/security/session-cookie.js';
import { issueAccessToken } from '../src/security/tokens.js';

const ownerUrl = process.env['DATABASE_MIGRATION_URL'];
if (!ownerUrl) {
  throw new Error(
    'DATABASE_MIGRATION_URL must be set to run outlet-device-auth.test.ts.',
  );
}

const ownerPrisma = new PrismaClient({ datasourceUrl: ownerUrl });

let app: FastifyInstance;
let env: Env;
let adminId: string;
let adminToken: string;
let outletId: string;
let inactiveOutletId: string;

/** Every device made here is an isolated fixture and is removed at the end. */
const deviceIds = new Set<string>();
const historicalGoogleIds = new Set<string>();

interface IssuedDevice {
  device: { id: string } & Record<string, unknown>;
  token: string;
}

interface OutletSession {
  accessToken: string;
  refreshToken: string;
  outlet: { id: string; name: string };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function refreshCookie(response: { headers: Record<string, unknown> }): string | undefined {
  const values = (response.headers['set-cookie'] ?? []) as string[];
  return values.find((value) => value.startsWith(`${REFRESH_COOKIE}=`));
}

async function createDevice(
  label: string,
  forOutletId = outletId,
): Promise<IssuedDevice> {
  const response = await request(app.server)
    .post(`/admin/outlets/${forOutletId}/devices`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ label });

  expect(response.status).toBe(201);
  expect(response.body).toEqual({
    device: expect.objectContaining({ id: expect.any(String) }),
    token: expect.stringMatching(/^pgo_[A-Za-z0-9_-]{43}$/),
  });

  const issued = response.body as IssuedDevice;
  deviceIds.add(issued.device.id);
  return issued;
}

async function signIn(token: string): Promise<{
  response: request.Response;
  session: OutletSession;
}> {
  const response = await request(app.server).post('/outlet/auth/token').send({ token });
  expect(response.status).toBe(200);
  expect(response.body).toEqual(
    expect.objectContaining({
      accessToken: expect.any(String),
      accessTokenExpiresIn: expect.any(Number),
      refreshToken: expect.any(String),
      outlet: expect.objectContaining({ id: outletId, name: expect.any(String) }),
    }),
  );
  return { response, session: response.body as OutletSession };
}

async function outletMe(accessToken: string) {
  return request(app.server)
    .get('/outlet/me')
    .set('Authorization', `Bearer ${accessToken}`);
}

async function refresh(refreshToken: string) {
  return request(app.server).post('/auth/refresh').send({ refreshToken });
}

beforeAll(async () => {
  // This suite observes authentication only. A developer may have the Sheets
  // mirror enabled in `.env`; do not let constructing a test server publish an
  // unrelated external snapshot.
  env = { ...loadEnv(), GOOGLE_SHEETS_SYNC_ENABLED: false };
  app = await buildApp({ env });
  await app.ready();

  const admin = await ownerPrisma.staffUser.findUniqueOrThrow({
    where: { email: 'admin@pgp.test' },
  });
  adminId = admin.id;
  adminToken = await issueAccessToken({
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE_STAFF,
    subject: admin.id,
    subjectType: 'STAFF',
    role: 'ADMINISTRATOR',
    tokenVersion: admin.tokenVersion,
    ttlSeconds: 900,
  });

  outletId = (await ownerPrisma.outlet.findFirstOrThrow({ where: { kind: 'SPA' } })).id;
  const inactive = await ownerPrisma.outlet.create({
    data: {
      name: `Inactive device-test outlet ${Date.now()}`,
      kind: 'OTHER',
      active: false,
    },
  });
  inactiveOutletId = inactive.id;
});

afterEach(() => {
  resetRateLimits();
});

afterAll(async () => {
  const ids = [...deviceIds];
  if (ids.length > 0) {
    await ownerPrisma.refreshToken.deleteMany({
      where: { subjectType: 'STAFF', subjectId: { in: ids } },
    });
    await ownerPrisma.staffUser.deleteMany({ where: { id: { in: ids } } });
  }
  const googleIds = [...historicalGoogleIds];
  if (googleIds.length > 0) {
    await ownerPrisma.refreshToken.deleteMany({
      where: { subjectType: 'STAFF', subjectId: { in: googleIds } },
    });
    await ownerPrisma.staffUser.deleteMany({ where: { id: { in: googleIds } } });
  }
  if (inactiveOutletId) {
    await ownerPrisma.outlet.deleteMany({ where: { id: inactiveOutletId } });
  }
  await app.close();
  await ownerPrisma.$disconnect();
});

describe('an administrator provisions one credential per counter device', () => {
  it('returns the plaintext once and stores only its hash', async () => {
    const issued = await createDevice(`Spa tablet hash test ${Date.now()}`);
    const expectedHash = sha256(issued.token);

    const stored = await ownerPrisma.staffUser.findUniqueOrThrow({
      where: { id: issued.device.id },
    });

    expect(stored).toMatchObject({
      id: issued.device.id,
      email: null,
      passwordHash: null,
      googleSubject: null,
      authMethod: 'TOKEN',
      role: 'OUTLET_STAFF',
      status: 'ACTIVE',
      outletId,
      outletTokenHash: expectedHash,
      outletTokenLastUsedAt: null,
    });
    expect(stored.outletTokenIssuedAt).toBeInstanceOf(Date);
    expect(stored.outletTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(issued.token);

    // The object beside the one-time token must itself be safe to retain or log.
    expect(JSON.stringify(issued.device)).not.toContain(issued.token);
    expect(JSON.stringify(issued.device)).not.toContain(expectedHash);

    const manage = await request(app.server)
      .get('/admin/outlets/manage')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(manage.status).toBe(200);
    const listed = JSON.stringify(manage.body);
    expect(listed).toContain(issued.device.id);
    expect(listed).not.toContain(issued.token);
    expect(listed).not.toContain(expectedHash);

    const audit = await ownerPrisma.auditLog.findFirstOrThrow({
      where: { action: 'outlet.device_created', subjectId: issued.device.id },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit.actorId).toBe(adminId);
    expect(audit.metadata).toMatchObject({ outletId });
    expect(JSON.stringify(audit)).not.toContain(issued.token);
    expect(JSON.stringify(audit)).not.toContain(expectedHash);
  });

  it('is administrator-only and refuses to provision against a closed outlet', async () => {
    const unauthenticated = await request(app.server)
      .post(`/admin/outlets/${outletId}/devices`)
      .send({ label: 'No principal' });
    expect(unauthenticated.status).toBe(401);

    const issued = await createDevice(`Unprivileged caller ${Date.now()}`);
    const { session } = await signIn(issued.token);
    const outletPrincipal = await request(app.server)
      .post(`/admin/outlets/${outletId}/devices`)
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ label: 'Wrong role' });
    expect(outletPrincipal.status).toBe(403);

    const inactive = await request(app.server)
      .post(`/admin/outlets/${inactiveOutletId}/devices`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ label: 'Closed-room tablet' });
    expect(inactive.status).toBe(422);
    expect(inactive.body).toMatchObject({ error: 'outlet_inactive' });
    expect(
      await ownerPrisma.staffUser.count({
        where: { outletId: inactiveOutletId, authMethod: 'TOKEN' },
      }),
    ).toBe(0);
  });
});

describe('Google outlet authentication is historical only', () => {
  it('has no public Google flow or administrator account lifecycle routes', async () => {
    const start = await request(app.server).post('/outlet/auth/start').send({});
    const callback = await request(app.server)
      .post('/outlet/auth/callback')
      .send({ code: 'unused', state: 'unused' });
    const create = await request(app.server)
      .post(`/admin/outlets/${outletId}/accounts`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ label: 'Legacy counter', email: 'legacy@example.test' });
    const reinstate = await request(app.server)
      .post(`/admin/outlets/accounts/${randomUUID()}/reinstate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(start.status).toBe(404);
    expect(callback.status).toBe(404);
    expect(create.status).toBe(404);
    expect(reinstate.status).toBe(404);
  });

  it('retains a suspended historical actor but cannot expose or reactivate it', async () => {
    const email = `historical-google-${Date.now()}@pgp.test`;
    const historical = await ownerPrisma.staffUser.create({
      data: {
        fullName: 'Historical Google outlet actor',
        email,
        passwordHash: null,
        authMethod: 'GOOGLE',
        role: 'OUTLET_STAFF',
        status: 'SUSPENDED',
        outletId,
        googleSubject: `historical-subject-${Date.now()}`,
      },
    });
    historicalGoogleIds.add(historical.id);

    const accessToken = await issueAccessToken({
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE_STAFF,
      subject: historical.id,
      subjectType: 'STAFF',
      role: 'OUTLET_STAFF',
      tokenVersion: historical.tokenVersion,
      ttlSeconds: 300,
    });
    expect((await outletMe(accessToken)).status).toBe(401);

    await expect(
      ownerPrisma.staffUser.update({
        where: { id: historical.id },
        data: { status: 'ACTIVE' },
      }),
    ).rejects.toThrow(/StaffUser_active_outlet_staff_uses_token|constraint/i);

    const manage = await request(app.server)
      .get('/admin/outlets/manage')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(manage.status).toBe(200);
    const listedOutlet = manage.body.outlets.find(
      (outlet: { id: string }) => outlet.id === outletId,
    );
    expect(listedOutlet).toHaveProperty('devices');
    expect(listedOutlet).not.toHaveProperty('accounts');
    expect(JSON.stringify(listedOutlet.devices)).not.toContain(email);
  });
});

describe('a device token is exchanged for an ordinary outlet session', () => {
  it('issues scoped access and refresh tokens, a safe cookie, and an audit entry', async () => {
    const issued = await createDevice(`Spa tablet login test ${Date.now()}`);
    const before = new Date();
    const { response, session } = await signIn(issued.token);

    expect(session.outlet.id).toBe(outletId);
    expect(await outletMe(session.accessToken)).toMatchObject({ status: 200 });

    const cookie = refreshCookie(response);
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    // Client requests are externally rooted at /api even though Caddy strips
    // that prefix before Fastify sees them.
    expect(cookie).toMatch(/Path=\/api\/auth/i);

    const stored = await ownerPrisma.staffUser.findUniqueOrThrow({
      where: { id: issued.device.id },
      select: { outletTokenLastUsedAt: true },
    });
    expect(stored.outletTokenLastUsedAt?.getTime()).toBeGreaterThanOrEqual(before.getTime());

    const audit = await ownerPrisma.auditLog.findFirstOrThrow({
      where: { action: 'auth.outlet.login.success', subjectId: issued.device.id },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit.actorId).toBe(issued.device.id);
    expect(audit.metadata).toMatchObject({ authMethod: 'TOKEN', outletId });
    expect(JSON.stringify(audit)).not.toContain(issued.token);
    expect(JSON.stringify(audit)).not.toContain(sha256(issued.token));
  });

  it('refuses a valid device credential while its outlet is closed', async () => {
    const issued = await createDevice(`Spa tablet closed-outlet test ${Date.now()}`);

    await ownerPrisma.outlet.update({ where: { id: outletId }, data: { active: false } });
    try {
      const response = await request(app.server)
        .post('/outlet/auth/token')
        .send({ token: issued.token });
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ error: 'sign_in_rejected' });
    } finally {
      await ownerPrisma.outlet.update({ where: { id: outletId }, data: { active: true } });
    }
  });

  it('closing and reopening an outlet permanently invalidates its existing sessions', async () => {
    const issued = await createDevice(`Spa tablet outlet-close test ${Date.now()}`);
    const existing = (await signIn(issued.token)).session;
    const before = await ownerPrisma.staffUser.findUniqueOrThrow({
      where: { id: issued.device.id },
      select: { outletTokenHash: true, tokenVersion: true },
    });

    const closed = await request(app.server)
      .patch(`/admin/outlets/${outletId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ active: false });
    expect(closed.status).toBe(200);
    expect(closed.body.active).toBe(false);

    expect((await outletMe(existing.accessToken)).status).toBe(401);
    expect((await refresh(existing.refreshToken)).status).toBe(401);

    const whileClosed = await ownerPrisma.staffUser.findUniqueOrThrow({
      where: { id: issued.device.id },
      select: { outletTokenHash: true, tokenVersion: true },
    });
    expect(whileClosed.outletTokenHash).toBe(before.outletTokenHash);
    expect(whileClosed.tokenVersion).toBe(before.tokenVersion + 1);

    const reopened = await request(app.server)
      .patch(`/admin/outlets/${outletId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ active: true });
    expect(reopened.status).toBe(200);
    expect(reopened.body.active).toBe(true);

    expect((await outletMe(existing.accessToken)).status).toBe(401);
    expect((await refresh(existing.refreshToken)).status).toBe(401);
    expect((await signIn(issued.token)).session.outlet.id).toBe(outletId);
  });

  it('rate limits repeated exchanges by client IP', async () => {
    resetRateLimits();
    const limited = await buildApp({
      env: { ...env, RATE_LIMIT_LOGIN_PER_IP_MAX: 2 },
    });
    await limited.ready();

    try {
      const first = await request(limited.server)
        .post('/outlet/auth/token')
        .send({ token: 'first-invalid-token' });
      const second = await request(limited.server)
        .post('/outlet/auth/token')
        .send({ token: 'second-invalid-token' });
      const limitedResponse = await request(limited.server)
        .post('/outlet/auth/token')
        .send({ token: 'third-invalid-token' });

      expect(first.status).toBe(401);
      expect(second.status).toBe(401);
      expect(limitedResponse.status).toBe(429);
      expect(limitedResponse.body).toMatchObject({ error: 'rate_limited' });
      expect(Number(limitedResponse.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await limited.close();
    }
  });
});

describe('rotating one device does not disturb another device at the outlet', () => {
  it('replaces the standing token and immediately kills only that device sessions', async () => {
    const first = await createDevice(`Rotation target ${Date.now()}`);
    const sibling = await createDevice(`Rotation sibling ${Date.now()}`);
    const firstLogin = (await signIn(first.token)).session;
    const siblingLogin = (await signIn(sibling.token)).session;
    const before = await ownerPrisma.staffUser.findUniqueOrThrow({
      where: { id: first.device.id },
      select: { tokenVersion: true },
    });

    const rotated = await request(app.server)
      .post(`/admin/outlets/devices/${first.device.id}/rotate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(rotated.status).toBe(200);
    expect(rotated.body).toEqual({
      device: expect.objectContaining({ id: first.device.id }),
      token: expect.stringMatching(/^pgo_[A-Za-z0-9_-]{43}$/),
    });
    expect(rotated.body.token).not.toBe(first.token);
    expect(JSON.stringify(rotated.body.device)).not.toContain(rotated.body.token);

    const stored = await ownerPrisma.staffUser.findUniqueOrThrow({
      where: { id: first.device.id },
    });
    expect(stored.outletTokenHash).toBe(sha256(rotated.body.token));
    expect(stored.outletTokenHash).not.toBe(sha256(first.token));
    expect(stored.tokenVersion).toBe(before.tokenVersion + 1);

    expect((await outletMe(firstLogin.accessToken)).status).toBe(401);
    expect((await refresh(firstLogin.refreshToken)).status).toBe(401);
    expect(
      (await request(app.server).post('/outlet/auth/token').send({ token: first.token })).status,
    ).toBe(401);

    // The sibling is a different StaffUser and therefore a different refresh
    // subject. Per-device revocation is real only if both of these stay live.
    expect((await outletMe(siblingLogin.accessToken)).status).toBe(200);
    expect((await refresh(siblingLogin.refreshToken)).status).toBe(200);
    expect((await signIn(rotated.body.token)).session.outlet.id).toBe(outletId);

    const audit = await ownerPrisma.auditLog.findFirstOrThrow({
      where: { action: 'outlet.device_rotated', subjectId: first.device.id },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit.actorId).toBe(adminId);
    expect(audit.metadata).toMatchObject({ outletId });
    expect(JSON.stringify(audit)).not.toContain(first.token);
    expect(JSON.stringify(audit)).not.toContain(rotated.body.token);
  });
});

describe('revoking one device is permanent and narrowly scoped', () => {
  it('wins over a concurrent rotation and leaves no usable standing credential', async () => {
    const target = await createDevice(`Rotate-revoke race ${Date.now()}`);
    const existingSession = (await signIn(target.token)).session;

    const [rotation, revocation] = await Promise.all([
      request(app.server)
        .post(`/admin/outlets/devices/${target.device.id}/rotate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({}),
      request(app.server)
        .post(`/admin/outlets/devices/${target.device.id}/revoke`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({}),
    ]);

    // Rotation may commit before revocation, lose its optimistic update to the
    // revoke, or observe the already-suspended row. Every interleaving is valid
    // only if revocation is the final state.
    expect([200, 409, 422]).toContain(rotation.status);
    expect(revocation.status).toBe(200);

    const rotatedToken =
      rotation.status === 200 && typeof rotation.body.token === 'string'
        ? rotation.body.token
        : null;
    if (rotation.status === 200) {
      expect(rotatedToken).toMatch(/^pgo_[A-Za-z0-9_-]{43}$/);
    } else if (rotation.status === 409) {
      expect(rotation.body).toMatchObject({ error: 'device_changed' });
    } else {
      expect(rotation.body).toMatchObject({ error: 'device_revoked' });
    }

    const stored = await ownerPrisma.staffUser.findUniqueOrThrow({
      where: { id: target.device.id },
    });
    expect(stored.status).toBe('SUSPENDED');
    expect(stored.outletTokenHash).toBeNull();

    expect((await outletMe(existingSession.accessToken)).status).toBe(401);
    expect((await refresh(existingSession.refreshToken)).status).toBe(401);
    expect(
      (await request(app.server).post('/outlet/auth/token').send({ token: target.token })).status,
    ).toBe(401);
    if (rotatedToken !== null) {
      expect(
        (await request(app.server).post('/outlet/auth/token').send({ token: rotatedToken })).status,
      ).toBe(401);
    }
  });

  it('destroys its credential and sessions while its sibling stays signed in', async () => {
    const revoked = await createDevice(`Revocation target ${Date.now()}`);
    const sibling = await createDevice(`Revocation sibling ${Date.now()}`);
    const revokedLogin = (await signIn(revoked.token)).session;
    const siblingLogin = (await signIn(sibling.token)).session;

    const response = await request(app.server)
      .post(`/admin/outlets/devices/${revoked.device.id}/revoke`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain(revoked.token);
    expect(JSON.stringify(response.body)).not.toContain(sha256(revoked.token));

    const stored = await ownerPrisma.staffUser.findUniqueOrThrow({
      where: { id: revoked.device.id },
    });
    expect(stored.status).toBe('SUSPENDED');
    expect(stored.outletTokenHash).toBeNull();

    expect((await outletMe(revokedLogin.accessToken)).status).toBe(401);
    expect((await refresh(revokedLogin.refreshToken)).status).toBe(401);
    expect((await outletMe(siblingLogin.accessToken)).status).toBe(200);
    expect((await refresh(siblingLogin.refreshToken)).status).toBe(200);

    const failuresStartedAt = new Date();
    const malformed = await request(app.server)
      .post('/outlet/auth/token')
      .send({ token: 'not-a-device-token' });
    const unknown = await request(app.server)
      .post('/outlet/auth/token')
      .send({ token: `pgo_${'A'.repeat(43)}` });
    const revokedCredential = await request(app.server)
      .post('/outlet/auth/token')
      .send({ token: revoked.token });

    expect(malformed.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(revokedCredential.status).toBe(401);
    expect(unknown.body).toEqual(malformed.body);
    expect(revokedCredential.body).toEqual(malformed.body);

    const audit = await ownerPrisma.auditLog.findFirstOrThrow({
      where: { action: 'outlet.device_revoked', subjectId: revoked.device.id },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit.actorId).toBe(adminId);
    expect(audit.metadata).toMatchObject({ outletId });
    expect(JSON.stringify(audit)).not.toContain(revoked.token);

    const failures = await ownerPrisma.auditLog.findMany({
      where: { action: 'auth.outlet.login.failure', occurredAt: { gte: failuresStartedAt } },
      orderBy: { occurredAt: 'desc' },
      take: 3,
    });
    expect(failures).toHaveLength(3);
    for (const failure of failures) {
      expect(failure.metadata).toMatchObject({
        authMethod: 'TOKEN',
        reason: 'invalid_credentials',
      });
    }
    const failureText = JSON.stringify(failures);
    expect(failureText).not.toContain(revoked.token);
    expect(failureText).not.toContain(sha256(revoked.token));
    expect(failureText).not.toContain('not-a-device-token');
    expect(failureText).not.toContain(`pgo_${'A'.repeat(43)}`);
  });
});
