/**
 * Benefit notices — the guest announces, the outlet confirms, nobody approves.
 *
 * The rules underneath: a guest cannot spam the outlets, a notice is created
 * already usable, one notice cannot be spent twice, and no outlet can see or act
 * on another outlet's work.
 */
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadEnv, type Env } from '../src/config/env.js';
import type { AnyDelivery, CodeSender } from '../src/notifications/code-sender.js';
import { expireStaleRequests } from '../src/routes/requests.js';
import { resetRateLimits } from '../src/security/rate-limit.js';
import { issueAccessToken } from '../src/security/tokens.js';
import { createOutletDeviceFixture } from './outlet-device-fixture.js';

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
/** The spa's own account, and a different outlet's, to prove the scope holds. */
let spaOutletToken: string;
let diningOutletToken: string;

let memberId: string;
let otherMemberId: string;
let spaBenefitId: string;
let spaOutletId: string;
let diningOutletId: string;
const outletDeviceIds: string[] = [];

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

/**
 * Moves a member's last notice back in time.
 *
 * The throttle is a count over `requestedAt`, so two announcements inside one
 * test would otherwise collide on it rather than on whatever the test is about.
 */
async function clearThrottle(subject: string = memberId): Promise<void> {
  await ownerPrisma.benefitRequest.updateMany({
    where: { memberId: subject },
    data: { requestedAt: new Date(Date.now() - 60 * 60 * 1000) },
  });
}

/** Puts a notice straight into a state, bypassing the endpoints. */
async function seedNotice(
  overrides: {
    memberId?: string;
    benefitId?: string;
    outletId?: string;
    status?: 'SENT' | 'FULFILLED' | 'NOT_USED';
    requestedAt?: Date;
  } = {},
): Promise<string> {
  const row = await ownerPrisma.benefitRequest.create({
    data: {
      memberId: overrides.memberId ?? memberId,
      benefitId: overrides.benefitId ?? spaBenefitId,
      outletId: overrides.outletId ?? spaOutletId,
      status: overrides.status ?? 'SENT',
      ...(overrides.requestedAt ? { requestedAt: overrides.requestedAt } : {}),
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

  spaOutletId = (await ownerPrisma.outlet.findFirstOrThrow({ where: { kind: 'SPA' } })).id;
  diningOutletId = (await ownerPrisma.outlet.findFirstOrThrow({ where: { kind: 'DINING' } })).id;
  spaBenefitId = (await ownerPrisma.benefit.findUniqueOrThrow({ where: { key: 'spa' } })).id;

  const spaAccount = await createOutletDeviceFixture(
    ownerPrisma,
    spaOutletId,
    'Requests test spa device',
  );
  outletDeviceIds.push(spaAccount.id);
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
    'Requests test dining device',
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

beforeEach(async () => {
  deliveries.length = 0;
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
  await ownerPrisma.staffUser.deleteMany({ where: { id: { in: outletDeviceIds } } });
  await app.close();
  await ownerPrisma.$disconnect();
});

// ── The guest announces ────────────────────────────────────────────────────

describe('a member announces they are coming', () => {
  it('creates a usable notice with no approval step, and records no redemption', async () => {
    const before = await ownerPrisma.redemption.count({ where: { memberId } });

    const response = await request(app.server)
      .post('/member/me/requests')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ benefitKey: 'spa', note: 'Friday evening, two of us' });

    expect(response.status).toBe(201);
    // The whole point of the change: created already usable, not PENDING.
    expect(response.body.status).toBe('SENT');
    expect(response.body.note).toBe('Friday evening, two of us');
    // Announcing is not receiving. Nothing about money has happened.
    expect(await ownerPrisma.redemption.count({ where: { memberId } })).toBe(before);
  });

  it('names the outlet without asking when only one honours the benefit', async () => {
    const response = await request(app.server)
      .post('/member/me/requests')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ benefitKey: 'spa' });

    expect(response.status).toBe(201);
    expect(response.body.outlet.id).toBe(spaOutletId);
  });

  it('tells the outlet, and records whether the message landed', async () => {
    await ownerPrisma.outlet.update({
      where: { id: spaOutletId },
      data: { notifyEmail: 'spa-notices@pgp.test' },
    });

    const response = await request(app.server)
      .post('/member/me/requests')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ benefitKey: 'spa' });
    expect(response.status).toBe(201);

    const outletNotice = deliveries.find((row) => row.purpose === 'outlet-request');
    expect(outletNotice).toBeDefined();
    expect(outletNotice).toMatchObject({
      email: 'spa-notices@pgp.test',
      memberNumber: 'PG-0003',
    });

    const stored = await ownerPrisma.benefitRequest.findUniqueOrThrow({
      where: { id: response.body.id },
      select: { notifiedAt: true, notifyStatus: true },
    });
    expect(stored.notifiedAt).not.toBeNull();
    expect(stored.notifyStatus).toBe('delivered');

    await ownerPrisma.outlet.update({
      where: { id: spaOutletId },
      data: { notifyEmail: null },
    });
  });

  it("never puts the member's name in the outlet's message", async () => {
    await request(app.server)
      .post('/member/me/requests')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ benefitKey: 'spa', note: 'two of us' });

    const outletNotice = deliveries.find((row) => row.purpose === 'outlet-request');
    expect(JSON.stringify(outletNotice)).not.toContain('Test Member Three');
  });

  it("withholds the guest's note from the outlet's message by default", async () => {
    await request(app.server)
      .post('/member/me/requests')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ benefitKey: 'spa', note: 'a private note' });

    const outletNotice = deliveries.find((row) => row.purpose === 'outlet-request');
    // The note travels to the screen, never automatically off the premises. The
    // flag is the hotel's decision to make, and its default is off.
    expect(outletNotice).toMatchObject({ includeNote: false });
  });

  it('tells the guest there is nothing to wait for', async () => {
    await request(app.server)
      .post('/member/me/requests')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ benefitKey: 'spa' });

    const toMember = deliveries.find((row) => row.purpose === 'request-submitted');
    expect(toMember).toBeDefined();
    // The old flow's 'request-approved' message does not exist any more, because
    // there is nothing to approve.
    expect(deliveries.some((row) => row.purpose === ('request-approved' as never))).toBe(false);
  });

  it('refuses a second announcement inside the throttle window', async () => {
    const first = await request(app.server)
      .post('/member/me/requests')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ benefitKey: 'spa' });
    expect(first.status).toBe(201);

    const second = await request(app.server)
      .post('/member/me/requests')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ benefitKey: 'rooms' });

    expect(second.status).toBe(429);
    expect(second.headers['retry-after']).toBeTruthy();
  });

  it('survives a restart, because the throttle is a row count and not a memory bucket', async () => {
    const first = await request(app.server)
      .post('/member/me/requests')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ benefitKey: 'spa' });
    expect(first.status).toBe(201);

    // What a redeploy does to the in-memory limiter. The database is untouched.
    resetRateLimits();

    const second = await request(app.server)
      .post('/member/me/requests')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ benefitKey: 'rooms' });
    expect(second.status).toBe(429);
  });

  it('throttles per member, not globally', async () => {
    const mine = await request(app.server)
      .post('/member/me/requests')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ benefitKey: 'spa' });
    expect(mine.status).toBe(201);

    const theirs = await request(app.server)
      .post('/member/me/requests')
      .set('Authorization', `Bearer ${otherMemberToken}`)
      .send({ benefitKey: 'spa' });
    expect(theirs.status).toBe(201);
  });

  it('refuses a duplicate open notice at the same outlet', async () => {
    await seedNotice();
    await clearThrottle();

    const response = await request(app.server)
      .post('/member/me/requests')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ benefitKey: 'spa' });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('request_already_open');
  });

  it('refuses a benefit that is not published', async () => {
    const response = await request(app.server)
      .post('/member/me/requests')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ benefitKey: 'no-such-benefit' });

    expect(response.status).toBe(404);
  });

  it('lists the outlets a benefit can be used at', async () => {
    const response = await request(app.server)
      .get('/member/me/benefits/spa/outlets')
      .set('Authorization', `Bearer ${memberToken}`);

    expect(response.status).toBe(200);
    expect(response.body.outlets.length).toBeGreaterThan(0);
    // An operational address is none of a member's business.
    expect(JSON.stringify(response.body)).not.toContain('notifyEmail');
  });
});

// ── The outlet confirms ────────────────────────────────────────────────────

describe('the outlet closes its own notices', () => {
  it('confirms a notice, writing exactly one redemption', async () => {
    const noticeId = await seedNotice();

    const response = await request(app.server)
      .post(`/outlet/requests/${noticeId}/confirm`)
      .set('Authorization', `Bearer ${spaOutletToken}`)
      .send({ partySize: 2, idempotencyKey: key('confirm') });

    expect(response.status).toBe(201);

    const stored = await ownerPrisma.benefitRequest.findUniqueOrThrow({
      where: { id: noticeId },
      select: { status: true, redemptionId: true, fulfilledAt: true, closedByUserId: true },
    });
    expect(stored.status).toBe('FULFILLED');
    expect(stored.redemptionId).toBe(response.body.id);
    expect(stored.fulfilledAt).not.toBeNull();
    // Attributed to the outlet account that did it, not to an administrator.
    expect(stored.closedByUserId).not.toBeNull();
  });

  it('records the redemption against its own outlet, whatever the caller says', async () => {
    const noticeId = await seedNotice();

    const response = await request(app.server)
      .post(`/outlet/requests/${noticeId}/confirm`)
      .set('Authorization', `Bearer ${spaOutletToken}`)
      .send({ partySize: 2, idempotencyKey: key('bound') });

    expect(response.status).toBe(201);
    expect(response.body.outletId).toBe(spaOutletId);
  });

  it('cannot confirm the same notice twice', async () => {
    const noticeId = await seedNotice();

    const first = await request(app.server)
      .post(`/outlet/requests/${noticeId}/confirm`)
      .set('Authorization', `Bearer ${spaOutletToken}`)
      .send({ partySize: 2, idempotencyKey: key('once') });
    expect(first.status).toBe(201);

    const second = await request(app.server)
      .post(`/outlet/requests/${noticeId}/confirm`)
      .set('Authorization', `Bearer ${spaOutletToken}`)
      .send({ partySize: 2, idempotencyKey: key('twice') });

    expect(second.status).toBe(409);
    expect(second.body.error).toBe('already_closed');
  });

  it('marks a no-show without recording anything', async () => {
    const noticeId = await seedNotice();
    const before = await ownerPrisma.redemption.count({ where: { memberId } });

    const response = await request(app.server)
      .post(`/outlet/requests/${noticeId}/not-used`)
      .set('Authorization', `Bearer ${spaOutletToken}`)
      .send({ reason: 'Guest did not arrive' });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('NOT_USED');
    expect(await ownerPrisma.redemption.count({ where: { memberId } })).toBe(before);

    // The guest is told, and told it is not a refusal.
    const toMember = deliveries.find((row) => row.purpose === 'request-not-used');
    expect(toMember).toBeDefined();
  });

  it('leaves the entitlement available after a no-show', async () => {
    const noticeId = await seedNotice();
    await request(app.server)
      .post(`/outlet/requests/${noticeId}/not-used`)
      .set('Authorization', `Bearer ${spaOutletToken}`)
      .send({ reason: 'no show' });
    await clearThrottle();

    // NOT_USED is terminal for the notice, not for the benefit.
    const again = await request(app.server)
      .post('/member/me/requests')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ benefitKey: 'spa' });
    expect(again.status).toBe(201);
  });

  it('shows an outlet only its own notices', async () => {
    await seedNotice({ outletId: spaOutletId });

    const spa = await request(app.server)
      .get('/outlet/requests')
      .set('Authorization', `Bearer ${spaOutletToken}`);
    expect(spa.status).toBe(200);
    expect(spa.body.requests).toHaveLength(1);

    const dining = await request(app.server)
      .get('/outlet/requests')
      .set('Authorization', `Bearer ${diningOutletToken}`);
    expect(dining.status).toBe(200);
    expect(dining.body.requests).toHaveLength(0);
  });

  it("refuses to let one outlet confirm another's notice, even holding the id", async () => {
    const noticeId = await seedNotice({ outletId: spaOutletId });

    const response = await request(app.server)
      .post(`/outlet/requests/${noticeId}/confirm`)
      .set('Authorization', `Bearer ${diningOutletToken}`)
      .send({ partySize: 2, idempotencyKey: key('cross') });

    // 404, not 403: the notice's existence is not this outlet's business.
    expect(response.status).toBe(404);
  });

  it('never sends a member name to the outlet screen', async () => {
    await seedNotice();

    const response = await request(app.server)
      .get('/outlet/requests')
      .set('Authorization', `Bearer ${spaOutletToken}`);

    expect(response.status).toBe(200);
    expect(response.body.requests[0].member.memberNumber).toBe('PG-0003');
    expect(JSON.stringify(response.body)).not.toContain('Test Member Three');
  });

  it('marks notices seen once the screen has loaded them', async () => {
    const noticeId = await seedNotice();

    const first = await request(app.server)
      .get('/outlet/requests')
      .set('Authorization', `Bearer ${spaOutletToken}`);
    // Reported as new on the call that discovers it, so the screen can highlight
    // what just arrived.
    expect(first.body.requests[0].isNew).toBe(true);

    const second = await request(app.server)
      .get('/outlet/requests')
      .set('Authorization', `Bearer ${spaOutletToken}`);
    expect(second.body.requests[0].isNew).toBe(false);

    const stored = await ownerPrisma.benefitRequest.findUniqueOrThrow({
      where: { id: noticeId },
      select: { seenAt: true },
    });
    expect(stored.seenAt).not.toBeNull();
  });
});

// ── Nothing approves anything any more ─────────────────────────────────────

describe('the approval step is gone', () => {
  it('has no approve or decline route', async () => {
    const noticeId = await seedNotice();

    for (const path of ['approve', 'decline']) {
      const response = await request(app.server)
        .post(`/admin/requests/${noticeId}/${path}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});
      expect(response.status).toBe(404);
    }
  });

  it('still lets an administrator watch, read-only', async () => {
    await seedNotice();

    const response = await request(app.server)
      .get('/admin/requests')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body.requests).toHaveLength(1);
    expect(response.body.requests[0].status).toBe('SENT');
  });
});

// ── Housekeeping ───────────────────────────────────────────────────────────

describe('notices nobody confirmed', () => {
  it('closes them out as not used, attributed to nobody', async () => {
    const stale = await seedNotice({
      requestedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    });
    const fresh = await seedNotice({ benefitId: spaBenefitId, memberId: otherMemberId });

    const closed = await expireStaleRequests(ownerPrisma, 24);
    expect(closed).toBe(1);

    const staleRow = await ownerPrisma.benefitRequest.findUniqueOrThrow({
      where: { id: stale },
      select: { status: true, closedAt: true, closedByUserId: true, closedReason: true },
    });
    expect(staleRow.status).toBe('NOT_USED');
    expect(staleRow.closedAt).not.toBeNull();
    // A clock closed this, not a person. Naming an account would put somebody's
    // name against an action they never took.
    expect(staleRow.closedByUserId).toBeNull();
    expect(staleRow.closedReason).toBeTruthy();

    const freshRow = await ownerPrisma.benefitRequest.findUniqueOrThrow({
      where: { id: fresh },
      select: { status: true },
    });
    expect(freshRow.status).toBe('SENT');
  });
});

// ── A member sees their own and nobody else's ──────────────────────────────

describe('scope', () => {
  it("never shows a member another member's notices", async () => {
    await seedNotice({ memberId: otherMemberId });

    const response = await request(app.server)
      .get('/member/me/requests')
      .set('Authorization', `Bearer ${memberToken}`);

    expect(response.status).toBe(200);
    expect(response.body.requests).toHaveLength(0);
  });

  it('refuses an outlet token on a member route', async () => {
    const response = await request(app.server)
      .get('/member/me/requests')
      .set('Authorization', `Bearer ${spaOutletToken}`);

    // Wrong audience entirely — a staff token cannot be read as a member's.
    expect(response.status).toBe(401);
  });

  it('refuses an administrator token on an outlet route', async () => {
    const response = await request(app.server)
      .get('/outlet/requests')
      .set('Authorization', `Bearer ${adminToken}`);

    // The permission matrix is exhaustive: an administrator holds no outlet
    // permission, so this is a 403 about the route rather than a 404 about a row.
    expect(response.status).toBe(403);
  });
});
