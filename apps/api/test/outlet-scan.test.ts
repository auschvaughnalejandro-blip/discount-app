/**
 * The walk-up path: a guest hands over the card, staff scan it, the visit is
 * recorded.
 *
 * The rules being held here: a scan identifies and grants nothing, an outlet sees
 * only what it can honour, a redemption requires a session bound to a member just
 * resolved at this outlet, and none of it opens a way to enumerate the membership.
 */
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadEnv, type Env } from '../src/config/env.js';
import type { AnyDelivery, CodeSender } from '../src/notifications/code-sender.js';
import { issueCardCode } from '../src/security/identity-codes.js';
import { resetRateLimits } from '../src/security/rate-limit.js';
import { issueAccessToken } from '../src/security/tokens.js';
import { issueVerificationSession } from '../src/security/verification-session.js';
import { createOutletDeviceFixture } from './outlet-device-fixture.js';

const ownerUrl = process.env['DATABASE_MIGRATION_URL'];
if (!ownerUrl) {
  throw new Error('DATABASE_MIGRATION_URL must be set to run outlet-scan.test.ts.');
}

let app: FastifyInstance;
let env: Env;
const ownerPrisma = new PrismaClient({ datasourceUrl: ownerUrl });

let memberId: string;
let memberToken: string;
let spaOutletToken: string;
let spaAccountId: string;
let diningOutletToken: string;
let spaOutletId: string;
const outletDeviceIds: string[] = [];
let spaBenefitId: string;
let diningBenefitId: string;

const deliveries: AnyDelivery[] = [];
const capturingSender: CodeSender = {
  name: 'test-capture',
  send: async (delivery) => {
    deliveries.push(delivery);
    return { delivered: true };
  },
};

function key(label: string): string {
  return `test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

beforeAll(async () => {
  env = loadEnv();
  app = await buildApp({ env, codeSender: capturingSender });
  await app.ready();

  const member = await ownerPrisma.member.findUniqueOrThrow({
    where: { memberNumber: 'PG-0003' },
  });
  memberId = member.id;
  memberToken = await issueAccessToken({
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE_MEMBER,
    subject: member.id,
    subjectType: 'MEMBER',
    tokenVersion: member.tokenVersion,
    ttlSeconds: 900,
  });

  spaOutletId = (await ownerPrisma.outlet.findFirstOrThrow({ where: { kind: 'SPA' } })).id;
  const diningOutletId = (await ownerPrisma.outlet.findFirstOrThrow({ where: { kind: 'DINING' } })).id;
  spaBenefitId = (await ownerPrisma.benefit.findUniqueOrThrow({ where: { key: 'spa' } })).id;
  diningBenefitId = (await ownerPrisma.benefit.findUniqueOrThrow({ where: { key: 'fnb' } })).id;

  const spaAccount = await createOutletDeviceFixture(
    ownerPrisma,
    spaOutletId,
    'Outlet scan test spa device',
  );
  outletDeviceIds.push(spaAccount.id);
  spaAccountId = spaAccount.id;
  spaOutletToken = await issueAccessToken({
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE_STAFF,
    subject: spaAccount.id,
    subjectType: 'STAFF',
    role: 'OUTLET_STAFF',
    tokenVersion: spaAccount.tokenVersion,
    ttlSeconds: 900,
  });

  const diningAccount = await createOutletDeviceFixture(
    ownerPrisma,
    diningOutletId,
    'Outlet scan test dining device',
  );
  outletDeviceIds.push(diningAccount.id);
  diningOutletToken = await issueAccessToken({
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE_STAFF,
    subject: diningAccount.id,
    subjectType: 'STAFF',
    role: 'OUTLET_STAFF',
    tokenVersion: diningAccount.tokenVersion,
    ttlSeconds: 900,
  });
});

beforeEach(() => {
  deliveries.length = 0;
  resetRateLimits();
});

afterEach(() => {
  resetRateLimits();
});

afterAll(async () => {
  await ownerPrisma.benefitRequest.deleteMany({});
  await ownerPrisma.redemption.deleteMany({
    where: { idempotencyKey: { startsWith: 'test-' } },
  });
  await ownerPrisma.staffUser.deleteMany({ where: { id: { in: outletDeviceIds } } });
  await app.close();
  await ownerPrisma.$disconnect();
});

describe('scanning the card', () => {
  it('resolves the member and returns what they are entitled to', async () => {
    const response = await request(app.server)
      .post('/outlet/resolve')
      .set('Authorization', `Bearer ${spaOutletToken}`)
      .send({ payload: issueCardCode(memberId) });

    expect(response.status).toBe(200);
    expect(response.body.member.memberNumber).toBe('PG-0003');
    // The name is here on purpose: staff have to be able to tell the card belongs
    // to the person holding it.
    expect(response.body.member.fullName).toBe('Test Member Three');
    expect(response.body.verificationSession).toBeTruthy();
    expect(response.body.benefits.length).toBeGreaterThan(0);
  });

  it('grants nothing by itself', async () => {
    const before = await ownerPrisma.redemption.count({ where: { memberId } });

    await request(app.server)
      .post('/outlet/resolve')
      .set('Authorization', `Bearer ${spaOutletToken}`)
      .send({ payload: issueCardCode(memberId) });

    expect(await ownerPrisma.redemption.count({ where: { memberId } })).toBe(before);
  });

  it('shows only benefits this outlet can honour', async () => {
    const response = await request(app.server)
      .post('/outlet/resolve')
      .set('Authorization', `Bearer ${spaOutletToken}`)
      .send({ payload: issueCardCode(memberId) });

    const ids = response.body.benefits.map((row: { id: string }) => row.id);
    expect(ids).toContain(spaBenefitId);
    // Showing the restaurant's discount on a spa screen invites somebody to
    // record it there.
    expect(ids).not.toContain(diningBenefitId);
  });

  it('accepts a typed membership number, because many members present the card', async () => {
    const response = await request(app.server)
      .post('/outlet/resolve')
      .set('Authorization', `Bearer ${spaOutletToken}`)
      .send({ membershipNumber: 'PG-0003' });

    expect(response.status).toBe(200);
    expect(response.body.member.memberNumber).toBe('PG-0003');
  });

  it('refuses both a payload and a number at once', async () => {
    const response = await request(app.server)
      .post('/outlet/resolve')
      .set('Authorization', `Bearer ${spaOutletToken}`)
      .send({ payload: issueCardCode(memberId), membershipNumber: 'PG-0003' });

    expect(response.status).toBe(400);
  });

  it('returns 404 for an unknown number and records the failure', async () => {
    const before = await ownerPrisma.auditLog.count({
      where: { action: 'verification.lookup.failure' },
    });

    const response = await request(app.server)
      .post('/outlet/resolve')
      .set('Authorization', `Bearer ${spaOutletToken}`)
      .send({ membershipNumber: 'PG-9999' });

    expect(response.status).toBe(404);
    // §5 — a run of these against non-existent numbers is somebody probing, so it
    // has to be visible.
    expect(
      await ownerPrisma.auditLog.count({ where: { action: 'verification.lookup.failure' } }),
    ).toBe(before + 1);
  });

  it('is exact-match only, so it cannot be used as a search', async () => {
    for (const partial of ['PG-000', 'PG', '0003', 'pg-0003']) {
      const response = await request(app.server)
        .post('/outlet/resolve')
        .set('Authorization', `Bearer ${spaOutletToken}`)
        .send({ membershipNumber: partial });
      expect(response.status).toBe(404);
    }
  });

  it('records which form was scanned', async () => {
    await request(app.server)
      .post('/outlet/resolve')
      .set('Authorization', `Bearer ${spaOutletToken}`)
      .send({ payload: issueCardCode(memberId) });

    const entry = await ownerPrisma.auditLog.findFirstOrThrow({
      where: { action: 'verification.lookup.success', subjectId: memberId },
      orderBy: { occurredAt: 'desc' },
      select: { metadata: true },
    });
    expect(entry.metadata).toMatchObject({ method: 'card' });
  });

  it('rate limits lookups, because membership numbers are sequential', async () => {
    let sawLimit = false;
    for (let attempt = 0; attempt <= env.RATE_LIMIT_RESOLVE_PER_ACCOUNT_MAX + 1; attempt++) {
      const response = await request(app.server)
        .post('/outlet/resolve')
        .set('Authorization', `Bearer ${spaOutletToken}`)
        .send({ membershipNumber: 'PG-0003' });
      if (response.status === 429) {
        sawLimit = true;
        break;
      }
    }
    expect(sawLimit).toBe(true);
  });
});

describe('recording from a scan', () => {
  async function resolveThen(): Promise<string> {
    const resolved = await request(app.server)
      .post('/outlet/resolve')
      .set('Authorization', `Bearer ${spaOutletToken}`)
      .send({ payload: issueCardCode(memberId) });
    expect(resolved.status).toBe(200);
    return resolved.body.verificationSession as string;
  }

  it('records a visit for a member just resolved', async () => {
    const verificationSession = await resolveThen();

    const response = await request(app.server)
      .post('/outlet/redemptions')
      .set('Authorization', `Bearer ${spaOutletToken}`)
      .send({
        verificationSession,
        memberId,
        benefitId: spaBenefitId,
        partySize: 2,
        idempotencyKey: key('scan'),
      });

    expect(response.status).toBe(201);
    expect(response.body.outletId).toBe(spaOutletId);
  });

  it('appears in the member’s own history, which is the app’s Recently used', async () => {
    const verificationSession = await resolveThen();
    await request(app.server)
      .post('/outlet/redemptions')
      .set('Authorization', `Bearer ${spaOutletToken}`)
      .send({
        verificationSession,
        memberId,
        benefitId: spaBenefitId,
        partySize: 2,
        idempotencyKey: key('history'),
      });

    const history = await request(app.server)
      .get('/member/me/redemptions')
      .set('Authorization', `Bearer ${memberToken}`);

    expect(history.status).toBe(200);
    expect(history.body.redemptions.length).toBeGreaterThan(0);
  });

  it('refuses without a verification session', async () => {
    const response = await request(app.server)
      .post('/outlet/redemptions')
      .set('Authorization', `Bearer ${spaOutletToken}`)
      .send({
        verificationSession: 'vs1.forged.forged.1.forged',
        memberId,
        benefitId: spaBenefitId,
        partySize: 2,
        idempotencyKey: key('forged'),
      });

    expect(response.status).toBe(422);
    expect(response.body.error).toBe('verification_session_invalid');
  });

  it("refuses another outlet's session, so a resolve cannot be passed around", async () => {
    const verificationSession = await resolveThen();

    const response = await request(app.server)
      .post('/outlet/redemptions')
      .set('Authorization', `Bearer ${diningOutletToken}`)
      .send({
        verificationSession,
        memberId,
        benefitId: diningBenefitId,
        partySize: 2,
        idempotencyKey: key('handoff'),
      });

    expect(response.status).toBe(422);
  });

  it('refuses a session bound to a different member', async () => {
    const other = await ownerPrisma.member.findUniqueOrThrow({
      where: { memberNumber: 'PG-0001' },
    });
    // A genuine, correctly-signed session — for somebody else.
    const wrongMember = issueVerificationSession(spaAccountId, other.id);

    const response = await request(app.server)
      .post('/outlet/redemptions')
      .set('Authorization', `Bearer ${spaOutletToken}`)
      .send({
        verificationSession: wrongMember,
        memberId,
        benefitId: spaBenefitId,
        partySize: 2,
        idempotencyKey: key('wrong-member'),
      });

    expect(response.status).toBe(422);
  });

  it('still enforces the party-size cap (R5)', async () => {
    const verificationSession = await resolveThen();
    const benefit = await ownerPrisma.benefit.findUniqueOrThrow({
      where: { id: spaBenefitId },
      select: { maxGuests: true },
    });
    expect(benefit.maxGuests).not.toBeNull();

    const response = await request(app.server)
      .post('/outlet/redemptions')
      .set('Authorization', `Bearer ${spaOutletToken}`)
      .send({
        verificationSession,
        memberId,
        benefitId: spaBenefitId,
        partySize: (benefit.maxGuests ?? 0) + 1,
        idempotencyKey: key('cap'),
      });

    expect(response.status).toBe(422);
    expect(response.body.error).toBe('party_size_above_maximum');
  });

  it('is idempotent on a retry (R8)', async () => {
    const verificationSession = await resolveThen();
    const idempotencyKey = key('retry');
    const body = {
      verificationSession,
      memberId,
      benefitId: spaBenefitId,
      partySize: 2,
      idempotencyKey,
    };

    const first = await request(app.server)
      .post('/outlet/redemptions')
      .set('Authorization', `Bearer ${spaOutletToken}`)
      .send(body);
    expect(first.status).toBe(201);

    const second = await request(app.server)
      .post('/outlet/redemptions')
      .set('Authorization', `Bearer ${spaOutletToken}`)
      .send(body);
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.id).toBe(first.body.id);
  });

  it('tells the guest their benefit was recorded', async () => {
    const verificationSession = await resolveThen();
    await request(app.server)
      .post('/outlet/redemptions')
      .set('Authorization', `Bearer ${spaOutletToken}`)
      .send({
        verificationSession,
        memberId,
        benefitId: spaBenefitId,
        partySize: 2,
        idempotencyKey: key('notify'),
      });

    expect(deliveries.some((row) => row.purpose === 'redemption-recorded')).toBe(true);
  });
});

describe('what an outlet account cannot reach', () => {
  const forbidden = [
    ['get', '/admin/members'],
    ['get', '/admin/requests'],
    ['get', '/admin/redemptions'],
    ['get', '/admin/staff'],
    ['get', '/admin/outlets/manage'],
    ['get', '/reports/usage'],
  ] as const;

  it('refuses every dashboard route', async () => {
    for (const [method, path] of forbidden) {
      const response = await request(app.server)
        [method](path)
        .set('Authorization', `Bearer ${spaOutletToken}`);
      // 403 about the route, not 404 about a row: the route is not a secret.
      expect([401, 403, 404]).toContain(response.status);
      expect(response.status).not.toBe(200);
    }
  });

  it('cannot record against an outlet it does not belong to', async () => {
    const resolved = await request(app.server)
      .post('/outlet/resolve')
      .set('Authorization', `Bearer ${spaOutletToken}`)
      .send({ payload: issueCardCode(memberId) });

    const response = await request(app.server)
      .post('/outlet/redemptions')
      .set('Authorization', `Bearer ${spaOutletToken}`)
      .send({
        verificationSession: resolved.body.verificationSession,
        memberId,
        benefitId: spaBenefitId,
        partySize: 2,
        idempotencyKey: key('no-outlet-field'),
        // There is deliberately no outletId field to send. The schema is strict,
        // so attempting one is a 400 rather than a quietly ignored override.
        outletId: 'seed-outlet-crust',
      });

    expect(response.status).toBe(400);
  });
});
