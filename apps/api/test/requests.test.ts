/**
 * Benefit requests — a member asks, an administrator decides, and the same
 * administrator marks it used when the guest turns up.
 *
 * The rule underneath all of it: a member cannot grant themselves anything, and
 * an approval cannot be spent twice.
 */
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadEnv, type Env } from '../src/config/env.js';
import type { CodeSender, MemberDelivery } from '../src/notifications/code-sender.js';
import { resetRateLimits } from '../src/security/rate-limit.js';
import { issueAccessToken } from '../src/security/tokens.js';

const ownerUrl = process.env['DATABASE_MIGRATION_URL'];
if (!ownerUrl) {
  throw new Error('DATABASE_MIGRATION_URL must be set to run requests.test.ts.');
}

let app: FastifyInstance;
let env: Env;
const ownerPrisma = new PrismaClient({ datasourceUrl: ownerUrl });

let memberToken: string;
let otherMemberToken: string;
let adminToken: string;
/** A retired historical account type, used here only to prove it cannot authenticate. */
let outletStaffToken: string;

let memberId: string;
let memberNumber: string;
let otherMemberId: string;
let spaBenefitId: string;
let fnbBenefitId: string;
let spaOutletId: string;
const deliveries: MemberDelivery[] = [];
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

/** Puts a request straight into a given state, bypassing the endpoints. */
async function seedRequest(
  status: 'PENDING' | 'APPROVED',
  overrides: { memberId?: string; benefitId?: string } = {},
): Promise<string> {
  const decided =
    status === 'PENDING'
      ? {}
      : {
          decidedAt: new Date(),
          decidedByUserId: (
            await ownerPrisma.staffUser.findUniqueOrThrow({ where: { email: 'admin@pgp.test' } })
          ).id,
        };

  const row = await ownerPrisma.benefitRequest.create({
    data: {
      memberId: overrides.memberId ?? memberId,
      benefitId: overrides.benefitId ?? spaBenefitId,
      status,
      ...decided,
    },
    select: { id: true },
  });
  return row.id;
}

beforeAll(async () => {
  env = loadEnv();
  app = await buildApp({ env, codeSender: capturingSender });
  await app.ready();

  const member = await ownerPrisma.member.findUniqueOrThrow({
    where: { memberNumber: 'PG-0003' },
  });
  memberId = member.id;
  memberNumber = member.memberNumber;
  memberToken = await issueAccessToken({
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE_MEMBER,
    subject: member.id,
    subjectType: 'MEMBER',
    tokenVersion: member.tokenVersion,
    ttlSeconds: 900,
  });

  const other = await ownerPrisma.member.findUniqueOrThrow({
    where: { memberNumber: 'PG-0001' },
  });
  otherMemberId = other.id;
  otherMemberToken = await issueAccessToken({
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE_MEMBER,
    subject: other.id,
    subjectType: 'MEMBER',
    tokenVersion: other.tokenVersion,
    ttlSeconds: 900,
  });

  const admin = await ownerPrisma.staffUser.findUniqueOrThrow({
    where: { email: 'admin@pgp.test' },
  });
  adminToken = await issueAccessToken({
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE_STAFF,
    subject: admin.id,
    subjectType: 'STAFF',
    role: 'ADMINISTRATOR',
    tokenVersion: admin.tokenVersion,
    ttlSeconds: 900,
  });

  const spaOutlet = await ownerPrisma.outlet.findFirstOrThrow({ where: { kind: 'SPA' } });
  const outletStaff = await ownerPrisma.staffUser.findFirstOrThrow({
    where: { role: 'OUTLET_STAFF' },
  });
  outletStaffToken = await issueAccessToken({
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE_STAFF,
    subject: outletStaff.id,
    subjectType: 'STAFF',
    role: 'OUTLET_STAFF',
    ...(outletStaff.outletId ? { outletId: outletStaff.outletId } : {}),
    tokenVersion: outletStaff.tokenVersion,
    ttlSeconds: 900,
  });
  spaOutletId = spaOutlet.id;
  spaBenefitId = (await ownerPrisma.benefit.findUniqueOrThrow({ where: { key: 'spa' } })).id;
  fnbBenefitId = (await ownerPrisma.benefit.findUniqueOrThrow({ where: { key: 'fnb' } })).id;
});

beforeEach(async () => {
  deliveries.length = 0;
  // Every test starts from an empty queue: "one open request per benefit" makes
  // these tests interfere with each other otherwise.
  await ownerPrisma.benefitRequest.deleteMany({});
});

afterEach(() => {
  resetRateLimits();
});

afterAll(async () => {
  await ownerPrisma.benefitRequest.deleteMany({});
  await ownerPrisma.redemption.deleteMany({
    where: { idempotencyKey: { startsWith: 'test-' } },
  });
  await ownerPrisma.staffUser.deleteMany({
    where: { email: { startsWith: 'request-test-dining-' } },
  });
  await app.close();
  await ownerPrisma.$disconnect();
});

// ── The member asks ────────────────────────────────────────────────────────

describe('a member asks for a benefit', () => {
  it('creates a request that grants nothing', async () => {
    // A delta, not an absolute: other suites leave redemptions behind for this
    // member, and what matters here is that *asking* creates none.
    const before = await ownerPrisma.redemption.count({ where: { memberId } });

    const response = await request(app.server)
      .post('/member/me/requests')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ benefitKey: 'spa', note: 'Friday evening, two of us' });

    expect(response.status).toBe(201);
    expect(response.body.status).toBe('PENDING');
    expect(response.body.decidedAt).toBeNull();
    expect(deliveries).toContainEqual(
      expect.objectContaining({
        purpose: 'request-submitted',
        benefitTitle: expect.any(String),
      }),
    );

    // Asking is not receiving.
    const after = await ownerPrisma.redemption.count({ where: { memberId } });
    expect(after).toBe(before);
  });

  it('refuses a second open request for the same benefit', async () => {
    await seedRequest('PENDING');

    const second = await request(app.server)
      .post('/member/me/requests')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ benefitKey: 'spa' });

    expect(second.status).toBe(409);
    expect(second.body.error).toBe('request_already_open');

    const count = await ownerPrisma.benefitRequest.count({ where: { memberId } });
    expect(count).toBe(1);
  });

  it('refuses a request for an unpublished benefit', async () => {
    await ownerPrisma.benefit.update({ where: { key: 'spa' }, data: { published: false } });
    try {
      const response = await request(app.server)
        .post('/member/me/requests')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ benefitKey: 'spa' });

      expect(response.status).toBe(404);
    } finally {
      await ownerPrisma.benefit.update({ where: { key: 'spa' }, data: { published: true } });
    }
  });

  it('shows a member their own requests and nobody else’s', async () => {
    await seedRequest('PENDING');
    await seedRequest('PENDING', { memberId: otherMemberId, benefitId: fnbBenefitId });

    const mine = await request(app.server)
      .get('/member/me/requests')
      .set('Authorization', `Bearer ${memberToken}`);

    expect(mine.status).toBe(200);
    expect(mine.body.requests).toHaveLength(1);

    const theirs = await request(app.server)
      .get('/member/me/requests')
      .set('Authorization', `Bearer ${otherMemberToken}`);

    expect(theirs.body.requests).toHaveLength(1);
    expect(theirs.body.requests[0].id).not.toBe(mine.body.requests[0].id);
  });

  it('cannot approve its own request', async () => {
    const id = await seedRequest('PENDING');

    const response = await request(app.server)
      .post(`/admin/requests/${id}/approve`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({});

    // 401, not 403: `requests:decide` belongs to a STAFF actor, so a member
    // token is not a principal that this route can even evaluate — it is
    // rejected as the wrong kind of caller before any permission is compared.
    //
    // The point either way is that self-approval is not a check inside the
    // handler that someone could delete. It is unreachable.
    expect(response.status).toBe(401);

    const row = await ownerPrisma.benefitRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('PENDING');
  });
});

// ── The administrator decides ──────────────────────────────────────────────

describe('an administrator works the queue', () => {
  it('lists what is waiting, oldest first', async () => {
    const first = await seedRequest('PENDING');
    const second = await seedRequest('PENDING', { benefitId: fnbBenefitId });

    const response = await request(app.server)
      .get('/admin/requests')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body.requests.map((r: { id: string }) => r.id)).toEqual([first, second]);
    expect(response.body.requests[0].member.memberNumber).toBe(memberNumber);
  });

  it('approves, recording who decided and when', async () => {
    const id = await seedRequest('PENDING');

    const response = await request(app.server)
      .post(`/admin/requests/${id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('APPROVED');

    const row = await ownerPrisma.benefitRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('APPROVED');
    expect(row.decidedAt).not.toBeNull();
    expect(row.decidedByUserId).not.toBeNull();
    expect(deliveries).toContainEqual(
      expect.objectContaining({ purpose: 'request-approved', benefitTitle: expect.any(String) }),
    );
  });

  it('declines with a reason the member can read', async () => {
    const id = await seedRequest('PENDING');

    const response = await request(app.server)
      .post(`/admin/requests/${id}/decline`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'The spa is closed for maintenance that week.' });

    expect(response.status).toBe(200);

    const asMember = await request(app.server)
      .get('/member/me/requests')
      .set('Authorization', `Bearer ${memberToken}`);

    expect(asMember.body.requests[0].status).toBe('DECLINED');
    expect(asMember.body.requests[0].decisionReason).toContain('maintenance');
    expect(deliveries).toContainEqual(
      expect.objectContaining({
        purpose: 'request-declined',
        reason: 'The spa is closed for maintenance that week.',
      }),
    );
  });

  it('refuses to decide the same request twice', async () => {
    const id = await seedRequest('PENDING');

    const first = await request(app.server)
      .post(`/admin/requests/${id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(first.status).toBe(200);

    const second = await request(app.server)
      .post(`/admin/requests/${id}/decline`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'changed my mind' });

    expect(second.status).toBe(409);
    expect(second.body.error).toBe('already_decided');

    const row = await ownerPrisma.benefitRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('APPROVED');
  });

  it('does not let two administrator decisions both settle one request', async () => {
    const id = await seedRequest('PENDING');

    const [a, b] = await Promise.all([
      request(app.server)
        .post(`/admin/requests/${id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({}),
      request(app.server)
        .post(`/admin/requests/${id}/decline`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'no' }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it('refuses to approve for a suspended member (R4)', async () => {
    const id = await seedRequest('PENDING');
    await ownerPrisma.member.update({ where: { id: memberId }, data: { status: 'SUSPENDED' } });

    try {
      const response = await request(app.server)
        .post(`/admin/requests/${id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(response.status).toBe(422);
      expect(response.body.error).toBe('member_not_active');
    } finally {
      await ownerPrisma.member.update({ where: { id: memberId }, data: { status: 'ACTIVE' } });
    }
  });

  it('is unreachable by a retired outlet-staff account', async () => {
    const response = await request(app.server)
      .get('/admin/requests')
      .set('Authorization', `Bearer ${outletStaffToken}`);

    expect(response.status).toBe(401);
  });
});

// ── The administrator marks it used ────────────────────────────────────────

describe('an approval is spent by recording a redemption', () => {
  it('lists approved requests separately from pending ones', async () => {
    const approved = await seedRequest('APPROVED');
    await seedRequest('PENDING', { benefitId: fnbBenefitId });

    const waiting = await request(app.server)
      .get('/admin/requests?status=APPROVED')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(waiting.status).toBe(200);
    expect(waiting.body.requests).toHaveLength(1);
    expect(waiting.body.requests[0].id).toBe(approved);
    // The guest gives their name when they arrive, so the name is what an
    // administrator matches on.
    expect(waiting.body.requests[0].member.fullName).toBeTruthy();
  });

  it('marks the approval spent when the redemption is recorded', async () => {
    const id = await seedRequest('APPROVED');

    const recorded = await request(app.server)
      .post('/admin/redemptions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        outletId: spaOutletId,
        memberId,
        benefitId: spaBenefitId,
        partySize: 2,
        billAmountMinor: 80_000,
        requestId: id,
        idempotencyKey: key('fulfil'),
      });

    expect(recorded.status).toBe(201);

    const row = await ownerPrisma.benefitRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('FULFILLED');
    expect(row.redemptionId).toBe(recorded.body.id);
    expect(row.fulfilledAt).not.toBeNull();
    expect(deliveries).toContainEqual(
      expect.objectContaining({
        purpose: 'redemption-recorded',
        outletName: expect.any(String),
        discountPct: expect.any(String),
        savedMinor: expect.any(Number),
      }),
    );

    // And it leaves the approved list, so nobody serves it twice.
    const list = await request(app.server)
      .get('/admin/requests?status=APPROVED')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.body.requests).toHaveLength(0);
  });

  it('refuses to spend one approval twice', async () => {
    const id = await seedRequest('APPROVED');

    const first = await request(app.server)
      .post('/admin/redemptions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        outletId: spaOutletId,
        memberId,
        benefitId: spaBenefitId,
        partySize: 1,
        requestId: id,
        idempotencyKey: key('spend-1'),
      });
    expect(first.status).toBe(201);

    const second = await request(app.server)
      .post('/admin/redemptions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        outletId: spaOutletId,
        memberId,
        benefitId: spaBenefitId,
        partySize: 1,
        requestId: id,
        idempotencyKey: key('spend-2'),
      });

    expect(second.status).toBe(422);
    expect(second.body.error).toBe('approval_not_valid');
  });

  it('refuses an approval belonging to a different member', async () => {
    const theirs = await seedRequest('APPROVED', { memberId: otherMemberId });

    const response = await request(app.server)
      .post('/admin/redemptions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        outletId: spaOutletId,
        memberId,
        benefitId: spaBenefitId,
        partySize: 1,
        requestId: theirs,
        idempotencyKey: key('wrong-member'),
      });

    expect(response.status).toBe(422);
    expect(response.body.error).toBe('approval_not_valid');
  });

  it('still records a walk-up with no approval behind it', async () => {
    const response = await request(app.server)
      .post('/admin/redemptions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        outletId: spaOutletId,
        memberId,
        benefitId: spaBenefitId,
        partySize: 1,
        idempotencyKey: key('walk-up'),
      });

    expect(response.status).toBe(201);
  });
});
