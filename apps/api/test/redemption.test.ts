/**
 * Stage 7 acceptance — redemption.
 *
 *   - spa redemption with 3 guests is rejected (cap is 2)
 *   - events redemption with 15 guests is rejected (minimum is 20)
 *   - redemption against a suspended member is rejected
 *   - the same idempotency key twice creates one row, returns the original
 *   - reversal leaves the original row byte-identical
 *   - a member cannot read another member's redemptions
 *   - retired staff account types cannot enter redemption routes
 *
 * Recording moved to `POST /admin/redemptions` when the counter application was
 * removed: an administrator marks a benefit used, naming the outlet, because
 * they are at a desk rather than standing in one.
 */
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { resetRateLimits } from '../src/security/rate-limit.js';
import { issueAccessToken } from '../src/security/tokens.js';

const ownerUrl = process.env['DATABASE_MIGRATION_URL'];
if (!ownerUrl) {
  throw new Error('DATABASE_MIGRATION_URL must be set to run redemption.test.ts.');
}

let app: FastifyInstance;
let env: Env;
const ownerPrisma = new PrismaClient({ datasourceUrl: ownerUrl });

let adminToken: string;
/** A retired historical account type, used here only to prove it cannot authenticate. */
let outletStaffToken: string;
let memberToken: string;
let otherMemberToken: string;

let memberId: string;
let otherMemberId: string;
let spaBenefitId: string;
let eventsBenefitId: string;
let fnbBenefitId: string;
let spaOutletId: string;

const createdRedemptionIds: string[] = [];

function key(label: string): string {
  return `test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}



beforeAll(async () => {
  env = loadEnv();
  app = await buildApp({ env });
  await app.ready();

  const outletStaff = await ownerPrisma.staffUser.findFirstOrThrow({
    where: { role: 'OUTLET_STAFF' },
  });
  spaOutletId = (await ownerPrisma.outlet.findFirstOrThrow({ where: { kind: 'SPA' } })).id;
  outletStaffToken = await issueAccessToken({
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE_STAFF,
    subject: outletStaff.id,
    subjectType: 'STAFF',
    role: 'OUTLET_STAFF',
    tokenVersion: outletStaff.tokenVersion,
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

  spaBenefitId = (await ownerPrisma.benefit.findUniqueOrThrow({ where: { key: 'spa' } })).id;
  eventsBenefitId = (await ownerPrisma.benefit.findUniqueOrThrow({ where: { key: 'events' } })).id;
  fnbBenefitId = (await ownerPrisma.benefit.findUniqueOrThrow({ where: { key: 'fnb' } })).id;
});

afterEach(() => {
  resetRateLimits();
});

afterAll(async () => {
  // Reversals first: they carry a foreign key to the row they reverse.
  await ownerPrisma.redemption.deleteMany({
    where: { idempotencyKey: { startsWith: 'test-' }, reversesId: { not: null } },
  });
  await ownerPrisma.redemption.deleteMany({
    where: { idempotencyKey: { startsWith: 'test-' } },
  });
  void createdRedemptionIds;
  await app.close();
  await ownerPrisma.$disconnect();
});

// ── Guest caps ─────────────────────────────────────────────────────────────

describe('R5 — party size must not exceed maxGuests', () => {
  it('rejects a spa redemption with 3 guests, where the cap is 2', async () => {
    const response = await request(app.server)
      .post('/admin/redemptions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        outletId: spaOutletId,
        memberId,
        benefitId: spaBenefitId,
        partySize: 3,
        idempotencyKey: key('spa-over'),
      });

    expect(response.status).toBe(422);
    expect(response.body.error).toBe('party_size_above_maximum');
    expect(response.body.maxGuests).toBe(2);

    // Nothing was written.
    const written = await ownerPrisma.redemption.count({
      where: { idempotencyKey: { startsWith: 'test-spa-over' } },
    });
    expect(written).toBe(0);
  });

  it('accepts a spa redemption with 2 guests', async () => {
    const response = await request(app.server)
      .post('/admin/redemptions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        outletId: spaOutletId,
        memberId,
        benefitId: spaBenefitId,
        partySize: 2,
        idempotencyKey: key('spa-ok'),
      });

    expect(response.status).toBe(201);
    expect(response.body.partySize).toBe(2);
  });

  it('rejects a dining redemption with 7 guests, where the cap is 6', async () => {
    const response = await request(app.server)
      .post('/admin/redemptions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        outletId: spaOutletId,
        memberId,
        benefitId: fnbBenefitId,
        partySize: 7,
        idempotencyKey: key('fnb-over'),
      });

    expect(response.status).toBe(422);
    expect(response.body.maxGuests).toBe(6);
  });

  it('reads the cap from the database, not from code', async () => {
    // Temporarily widen the spa cap. If the limit were hardcoded, 3 guests
    // would still be refused.
    await ownerPrisma.benefit.update({ where: { key: 'spa' }, data: { maxGuests: 4 } });

    try {
      const response = await request(app.server)
        .post('/admin/redemptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          outletId: spaOutletId,
        memberId,
          benefitId: spaBenefitId,
          partySize: 3,
          idempotencyKey: key('spa-widened'),
        });

      expect(response.status).toBe(201);
    } finally {
      await ownerPrisma.benefit.update({ where: { key: 'spa' }, data: { maxGuests: 2 } });
    }
  });
});

describe('R6 — party size must meet minGuests where set', () => {
  it('rejects an events redemption with 15 guests, where the minimum is 20', async () => {
    const response = await request(app.server)
      .post('/admin/redemptions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        outletId: spaOutletId,
        memberId,
        benefitId: eventsBenefitId,
        partySize: 15,
        idempotencyKey: key('events-under'),
      });

    expect(response.status).toBe(422);
    expect(response.body.error).toBe('party_size_below_minimum');
    expect(response.body.minGuests).toBe(20);
  });

  it('accepts an events redemption with 20 guests', async () => {
    const response = await request(app.server)
      .post('/admin/redemptions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        outletId: spaOutletId,
        memberId,
        benefitId: eventsBenefitId,
        partySize: 20,
        idempotencyKey: key('events-ok'),
      });

    expect(response.status).toBe(201);
  });

  it('requires a party size at all when the benefit constrains it', async () => {
    const response = await request(app.server)
      .post('/admin/redemptions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ outletId: spaOutletId, memberId, benefitId: spaBenefitId, idempotencyKey: key('spa-missing') });

    expect(response.status).toBe(422);
    expect(response.body.error).toBe('party_size_required');
  });
});

// ── Member status ──────────────────────────────────────────────────────────

describe('R4 — only an ACTIVE member may have a benefit recorded', () => {
  it('rejects a redemption against a suspended member, and preserves their history', async () => {
    const suspendable = await ownerPrisma.member.create({
      data: {
        memberNumber: `PG-SUSP-${Date.now()}`,
        fullName: 'Suspension Redemption Test',
        status: 'ACTIVE',
        joinedAt: new Date(),
        claimedAt: new Date(),
        createdByUserId: 'seed-staff-administrator',
      },
    });

    try {
      // A redemption recorded while active.
      const before = await request(app.server)
        .post('/admin/redemptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          outletId: spaOutletId,
        memberId: suspendable.id,
          benefitId: spaBenefitId,
          partySize: 1,
          idempotencyKey: key('susp-before'),
        });
      expect(before.status).toBe(201);

      await request(app.server)
        .post(`/admin/members/${suspendable.id}/suspend`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      // The Stage 4 half of this criterion, now completable.
      const after = await request(app.server)
        .post('/admin/redemptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          outletId: spaOutletId,
        memberId: suspendable.id,
          benefitId: spaBenefitId,
          partySize: 1,
          idempotencyKey: key('susp-after'),
        });

      expect(after.status).toBe(422);
      expect(after.body.error).toBe('member_not_active');

      // History preserved (R16).
      const history = await ownerPrisma.redemption.count({
        where: { memberId: suspendable.id },
      });
      expect(history).toBe(1);
    } finally {
      await ownerPrisma.redemption.deleteMany({ where: { memberId: suspendable.id } });
      await ownerPrisma.member.delete({ where: { id: suspendable.id } });
    }
  });
});

// ── Idempotency ────────────────────────────────────────────────────────────

describe('R8 — redemption creation is idempotent by client-supplied key', () => {
  it('creates one row and returns the original on a repeat', async () => {
    const idempotencyKey = key('idem');
    const payload = {
      outletId: spaOutletId,
        memberId,
      benefitId: spaBenefitId,
      partySize: 2,
      billAmountMinor: 45_000,
      idempotencyKey,
    };

    const first = await request(app.server)
      .post('/admin/redemptions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(payload);
    expect(first.status).toBe(201);
    expect(first.body.idempotent).toBe(false);

    const second = await request(app.server)
      .post('/admin/redemptions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(payload);
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.id).toBe(first.body.id);

    const rows = await ownerPrisma.redemption.count({ where: { idempotencyKey } });
    expect(rows).toBe(1);
  });

  it('survives two identical submissions in flight at once', async () => {
    const idempotencyKey = key('idem-race');
    const payload = {
      outletId: spaOutletId,
        memberId,
      benefitId: spaBenefitId,
      partySize: 1,
      idempotencyKey,
    };

    const [a, b] = await Promise.all([
      request(app.server)
        .post('/admin/redemptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload),
      request(app.server)
        .post('/admin/redemptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.id).toBe(b.body.id);

    const rows = await ownerPrisma.redemption.count({ where: { idempotencyKey } });
    expect(rows).toBe(1);
  });

  it('rejects the same key reused for a different redemption', async () => {
    const idempotencyKey = key('idem-conflict');

    await request(app.server)
      .post('/admin/redemptions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ outletId: spaOutletId, memberId, benefitId: spaBenefitId, partySize: 1, idempotencyKey });

    const conflicting = await request(app.server)
      .post('/admin/redemptions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ outletId: spaOutletId, memberId, benefitId: fnbBenefitId, partySize: 1, idempotencyKey });

    // A retry returns the original; a different payload under the same key is
    // a client bug, and silently returning the original would hide it.
    expect(conflicting.status).toBe(409);
  });
});

// ── Reversal ───────────────────────────────────────────────────────────────

describe('R7 — reversal leaves the original untouched', () => {
  it('creates a new reversing row and does not modify the original', async () => {
    const created = await request(app.server)
      .post('/admin/redemptions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        outletId: spaOutletId,
        memberId,
        benefitId: spaBenefitId,
        partySize: 2,
        billAmountMinor: 30_000,
        idempotencyKey: key('rev-original'),
      });
    expect(created.status).toBe(201);

    const before = await ownerPrisma.redemption.findUniqueOrThrow({
      where: { id: created.body.id },
    });

    const reversal = await request(app.server)
      .post(`/admin/redemptions/${created.body.id}/reverse`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Applied in error', idempotencyKey: key('rev-entry') });

    expect(reversal.status).toBe(201);
    expect(reversal.body.reversesId).toBe(created.body.id);
    // Negated, so totals sum without special-casing reversals everywhere.
    expect(reversal.body.billAmountMinor).toBe(-30_000);

    const after = await ownerPrisma.redemption.findUniqueOrThrow({
      where: { id: created.body.id },
    });

    // Byte-identical: every column, not just the ones the endpoint touched.
    expect(after).toEqual(before);
  });

  it('refuses to reverse the same redemption twice', async () => {
    const created = await request(app.server)
      .post('/admin/redemptions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        outletId: spaOutletId,
        memberId,
        benefitId: spaBenefitId,
        partySize: 1,
        idempotencyKey: key('rev-twice-orig'),
      });

    await request(app.server)
      .post(`/admin/redemptions/${created.body.id}/reverse`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'first', idempotencyKey: key('rev-twice-a') });

    const second = await request(app.server)
      .post(`/admin/redemptions/${created.body.id}/reverse`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'second', idempotencyKey: key('rev-twice-b') });

    expect(second.status).toBe(409);
  });

  it('is administrator-only', async () => {
    const created = await request(app.server)
      .post('/admin/redemptions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        outletId: spaOutletId,
        memberId,
        benefitId: spaBenefitId,
        partySize: 1,
        idempotencyKey: key('rev-authz'),
      });

    // Historical non-administrator accounts cannot authenticate, including
    // for reversal of a permanent record.
    const attempt = await request(app.server)
      .post(`/admin/redemptions/${created.body.id}/reverse`)
      .set('Authorization', `Bearer ${outletStaffToken}`)
      .send({ reason: 'nope', idempotencyKey: key('rev-authz-2') });

    expect(attempt.status).toBe(401);
  });
});

// ── Resolution ─────────────────────────────────────────────────────────────

describe('a member cannot read another member’s redemptions', () => {
  it('returns only the caller’s own history', async () => {
    await request(app.server)
      .post('/admin/redemptions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        outletId: spaOutletId,
        memberId,
        benefitId: spaBenefitId,
        partySize: 1,
        idempotencyKey: key('isolation'),
      });

    const mine = await request(app.server)
      .get('/member/me/redemptions')
      .set('Authorization', `Bearer ${memberToken}`);
    expect(mine.status).toBe(200);

    const theirs = await request(app.server)
      .get('/member/me/redemptions')
      .set('Authorization', `Bearer ${otherMemberToken}`);
    expect(theirs.status).toBe(200);

    // Scoped in the WHERE clause: the other member's rows were never loaded,
    // not loaded and then filtered.
    const mineIds = new Set(mine.body.redemptions.map((r: { id: string }) => r.id));
    const theirIds = theirs.body.redemptions.map((r: { id: string }) => r.id);

    expect(theirIds.some((id: string) => mineIds.has(id))).toBe(false);

    const all = await ownerPrisma.redemption.findMany({
      where: { memberId: otherMemberId },
      select: { id: true },
    });
    for (const row of all) {
      expect(mineIds.has(row.id)).toBe(false);
    }
  });
});

describe('retired outlet-staff accounts cannot access redemptions', () => {
  it('refuses the administrator redemption log', async () => {
    const response = await request(app.server)
      .get('/admin/redemptions')
      .set('Authorization', `Bearer ${outletStaffToken}`);

    expect(response.status).toBe(401);
  });

  it('cannot record a redemption either, now that it holds nothing', async () => {
    const response = await request(app.server)
      .post('/admin/redemptions')
      .set('Authorization', `Bearer ${outletStaffToken}`)
      .send({
        outletId: spaOutletId,
        memberId,
        benefitId: spaBenefitId,
        partySize: 1,
        idempotencyKey: key('outlet-staff-record'),
      });

    expect(response.status).toBe(401);
  });

  it('shows an administrator every redemption, attributed to the staff member', async () => {
    const response = await request(app.server)
      .get('/admin/redemptions?limit=5')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body.redemptions.length).toBeGreaterThan(0);
    for (const row of response.body.redemptions) {
      expect(row.staffUser.id).toBeTruthy();
      expect(row.staffUser.fullName).toBeTruthy();
    }
  });
});

describe('money never becomes a float', () => {
  it('stores and returns bill amounts as integer minor units', async () => {
    const created = await request(app.server)
      .post('/admin/redemptions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        outletId: spaOutletId,
        memberId,
        benefitId: spaBenefitId,
        partySize: 1,
        billAmountMinor: 12_345,
        idempotencyKey: key('money'),
      });

    expect(created.status).toBe(201);
    expect(created.body.billAmountMinor).toBe(12_345);
    expect(Number.isInteger(created.body.billAmountMinor)).toBe(true);
  });

  it('rejects a fractional bill amount at the edge', async () => {
    const response = await request(app.server)
      .post('/admin/redemptions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        outletId: spaOutletId,
        memberId,
        benefitId: spaBenefitId,
        partySize: 1,
        billAmountMinor: 100.5,
        idempotencyKey: key('money-float'),
      });

    expect(response.status).toBe(400);
  });

  it('rounds a fractional percentage exactly in member history', async () => {
    const benefit = await ownerPrisma.benefit.create({
      data: {
        key: `test-fractional-${Date.now()}`,
        title: 'Fractional Rate Test',
        category: 'Test',
        discountPct: '19.99',
        terms: 'Test only.',
        sortOrder: 999,
        published: true,
      },
    });

    try {
      const created = await request(app.server)
        .post('/admin/redemptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          outletId: spaOutletId,
          memberId,
          benefitId: benefit.id,
          partySize: 1,
          // 50.00 at 19.99% is 9.995, which rounds to 10.00 (1,000 fils).
          billAmountMinor: 5_000,
          idempotencyKey: key('fractional-rate'),
        });
      expect(created.status).toBe(201);

      const history = await request(app.server)
        .get('/member/me/redemptions')
        .set('Authorization', `Bearer ${memberToken}`);
      const row = history.body.redemptions.find(
        (redemption: { id: string }) => redemption.id === created.body.id,
      );

      expect(row.discountPctApplied).toBe('19.99');
      expect(row.savedMinor).toBe(1_000);
    } finally {
      await ownerPrisma.redemption.deleteMany({
        where: { benefitId: benefit.id, reversesId: { not: null } },
      });
      await ownerPrisma.redemption.deleteMany({ where: { benefitId: benefit.id } });
      await ownerPrisma.benefit.delete({ where: { id: benefit.id } });
    }
  });
});
