/**
 * Stage 7 acceptance — redemption.
 *
 *   - spa redemption with 3 guests is rejected (cap is 2)
 *   - events redemption with 15 guests is rejected (minimum is 20)
 *   - redemption against a suspended member is rejected
 *   - the same idempotency key twice creates one row, returns the original
 *   - reversal leaves the original row byte-identical
 *   - a member cannot read another member's redemptions
 *   - outlet_staff cannot list redemptions across members
 */
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { issueIdentityCode } from '../src/security/identity-codes.js';
import { resetRateLimits } from '../src/security/rate-limit.js';
import { issueAccessToken } from '../src/security/tokens.js';
import { issueVerificationSession } from '../src/security/verification-session.js';

const ownerUrl = process.env['DATABASE_MIGRATION_URL'];
if (!ownerUrl) {
  throw new Error('DATABASE_MIGRATION_URL must be set to run redemption.test.ts.');
}

let app: FastifyInstance;
let env: Env;
const ownerPrisma = new PrismaClient({ datasourceUrl: ownerUrl });

let staffToken: string;
let adminToken: string;
let memberToken: string;
let otherMemberToken: string;

let memberId: string;
let memberNumber: string;
let otherMemberId: string;
let spaBenefitId: string;
let eventsBenefitId: string;
let fnbBenefitId: string;
let spaOutletId: string;

const createdRedemptionIds: string[] = [];

function key(label: string): string {
  return `test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

let outletStaffId: string;

/**
 * A verification session bound to the outlet-staff account and the member,
 * as POST /verify/resolve would have issued moments earlier (§5).
 */
function session(forMemberId: string): string {
  return issueVerificationSession(outletStaffId, forMemberId);
}

beforeAll(async () => {
  env = loadEnv();
  app = await buildApp({ env });
  await app.ready();

  const outletStaff = await ownerPrisma.staffUser.findFirstOrThrow({
    where: { role: 'OUTLET_STAFF' },
  });
  spaOutletId = outletStaff.outletId ?? '';
  outletStaffId = outletStaff.id;
  staffToken = await issueAccessToken({
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE_STAFF,
    subject: outletStaff.id,
    subjectType: 'STAFF',
    role: 'OUTLET_STAFF',
    outletId: spaOutletId,
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
      .post('/verify/redemptions')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        verificationSession: session(memberId),
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
      .post('/verify/redemptions')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        verificationSession: session(memberId),
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
      .post('/verify/redemptions')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        verificationSession: session(memberId),
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
        .post('/verify/redemptions')
        .set('Authorization', `Bearer ${staffToken}`)
        .send({
          verificationSession: session(memberId),
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
      .post('/verify/redemptions')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        verificationSession: session(memberId),
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
      .post('/verify/redemptions')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        verificationSession: session(memberId),
        memberId,
        benefitId: eventsBenefitId,
        partySize: 20,
        idempotencyKey: key('events-ok'),
      });

    expect(response.status).toBe(201);
  });

  it('requires a party size at all when the benefit constrains it', async () => {
    const response = await request(app.server)
      .post('/verify/redemptions')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ verificationSession: session(memberId), memberId, benefitId: spaBenefitId, idempotencyKey: key('spa-missing') });

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
        .post('/verify/redemptions')
        .set('Authorization', `Bearer ${staffToken}`)
        .send({
          verificationSession: session(suspendable.id),
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
        .post('/verify/redemptions')
        .set('Authorization', `Bearer ${staffToken}`)
        .send({
          verificationSession: session(suspendable.id),
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
      verificationSession: session(memberId),
      memberId,
      benefitId: spaBenefitId,
      partySize: 2,
      billAmountMinor: 45_000,
      idempotencyKey,
    };

    const first = await request(app.server)
      .post('/verify/redemptions')
      .set('Authorization', `Bearer ${staffToken}`)
      .send(payload);
    expect(first.status).toBe(201);
    expect(first.body.idempotent).toBe(false);

    const second = await request(app.server)
      .post('/verify/redemptions')
      .set('Authorization', `Bearer ${staffToken}`)
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
      verificationSession: session(memberId),
      memberId,
      benefitId: spaBenefitId,
      partySize: 1,
      idempotencyKey,
    };

    const [a, b] = await Promise.all([
      request(app.server)
        .post('/verify/redemptions')
        .set('Authorization', `Bearer ${staffToken}`)
        .send(payload),
      request(app.server)
        .post('/verify/redemptions')
        .set('Authorization', `Bearer ${staffToken}`)
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
      .post('/verify/redemptions')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ verificationSession: session(memberId), memberId, benefitId: spaBenefitId, partySize: 1, idempotencyKey });

    const conflicting = await request(app.server)
      .post('/verify/redemptions')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ verificationSession: session(memberId), memberId, benefitId: fnbBenefitId, partySize: 1, idempotencyKey });

    // A retry returns the original; a different payload under the same key is
    // a client bug, and silently returning the original would hide it.
    expect(conflicting.status).toBe(409);
  });
});

// ── Reversal ───────────────────────────────────────────────────────────────

describe('R7 — reversal leaves the original untouched', () => {
  it('creates a new reversing row and does not modify the original', async () => {
    const created = await request(app.server)
      .post('/verify/redemptions')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        verificationSession: session(memberId),
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
      .post('/verify/redemptions')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        verificationSession: session(memberId),
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
      .post('/verify/redemptions')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        verificationSession: session(memberId),
        memberId,
        benefitId: spaBenefitId,
        partySize: 1,
        idempotencyKey: key('rev-authz'),
      });

    const attempt = await request(app.server)
      .post(`/admin/redemptions/${created.body.id}/reverse`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ reason: 'nope', idempotencyKey: key('rev-authz-2') });

    expect(attempt.status).toBe(403);
  });
});

// ── Resolution ─────────────────────────────────────────────────────────────

describe('R12 — lookup requires an exact number or a scanned payload', () => {
  it('resolves by exact membership number', async () => {
    const response = await request(app.server)
      .post('/verify/resolve')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ membershipNumber: memberNumber });

    expect(response.status).toBe(200);
    expect(response.body.member.memberNumber).toBe(memberNumber);
    expect(response.body.member.valid).toBe(true);
    expect(response.body.entitlements.length).toBeGreaterThan(0);
  });

  it('resolves by scanned identity payload', async () => {
    const response = await request(app.server)
      .post('/verify/resolve')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ payload: issueIdentityCode(memberId) });

    expect(response.status).toBe(200);
    expect(response.body.member.id).toBe(memberId);
  });

  it('rejects a stale payload', async () => {
    const stale = issueIdentityCode(memberId, new Date(Date.now() - 48 * 60 * 60 * 1000));

    const response = await request(app.server)
      .post('/verify/resolve')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ payload: stale });

    expect(response.status).toBe(404);
  });

  it('does not accept a partial membership number', async () => {
    const partial = memberNumber.slice(0, 4);

    const response = await request(app.server)
      .post('/verify/resolve')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ membershipNumber: partial });

    // No prefix matching, no wildcard — that would be a search endpoint.
    expect(response.status).toBe(404);
  });

  it('requires exactly one of payload or membershipNumber', async () => {
    const both = await request(app.server)
      .post('/verify/resolve')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ membershipNumber: memberNumber, payload: issueIdentityCode(memberId) });
    expect(both.status).toBe(400);

    const neither = await request(app.server)
      .post('/verify/resolve')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({});
    expect(neither.status).toBe(400);
  });

  it('shows a suspended member as invalid before any benefit can be chosen', async () => {
    const suspended = await ownerPrisma.member.create({
      data: {
        memberNumber: `PG-INV-${Date.now()}`,
        fullName: 'Invalid Display Test',
        status: 'SUSPENDED',
        joinedAt: new Date(),
        claimedAt: new Date(),
        createdByUserId: 'seed-staff-administrator',
      },
    });

    try {
      const response = await request(app.server)
        .post('/verify/resolve')
        .set('Authorization', `Bearer ${staffToken}`)
        .send({ membershipNumber: suspended.memberNumber });

      expect(response.status).toBe(200);
      expect(response.body.member.valid).toBe(false);
      expect(response.body.member.status).toBe('SUSPENDED');
    } finally {
      await ownerPrisma.member.delete({ where: { id: suspended.id } });
    }
  });

  it('logs a failed lookup', async () => {
    const before = await ownerPrisma.auditLog.count({
      where: { action: 'verification.lookup.failure' },
    });

    await request(app.server)
      .post('/verify/resolve')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ membershipNumber: 'PG-9999' });

    const after = await ownerPrisma.auditLog.count({
      where: { action: 'verification.lookup.failure' },
    });

    // A run of these against non-existent numbers is someone probing (§5).
    expect(after).toBe(before + 1);
  });
});

// ── Isolation ──────────────────────────────────────────────────────────────

describe('a member cannot read another member’s redemptions', () => {
  it('returns only the caller’s own history', async () => {
    await request(app.server)
      .post('/verify/redemptions')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        verificationSession: session(memberId),
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

describe('R11 — outlet_staff cannot list redemptions across members', () => {
  it('refuses the admin redemption log', async () => {
    const response = await request(app.server)
      .get('/admin/redemptions')
      .set('Authorization', `Bearer ${staffToken}`);

    expect(response.status).toBe(403);
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

describe('§5 — a redemption must be bound to a verification session', () => {
  it('refuses to record without one', async () => {
    const response = await request(app.server)
      .post('/verify/redemptions')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        memberId,
        benefitId: spaBenefitId,
        partySize: 1,
        idempotencyKey: key('no-session'),
      });

    expect(response.status).toBe(400);
  });

  it('refuses a session issued for a different member', async () => {
    // The attack this closes: resolve one member you are entitled to see,
    // then record against another whose id you happen to know.
    const response = await request(app.server)
      .post('/verify/redemptions')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        verificationSession: session(otherMemberId),
        memberId,
        benefitId: spaBenefitId,
        partySize: 1,
        idempotencyKey: key('wrong-member'),
      });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('verification_session_invalid');
  });

  it('refuses a session issued to a different staff account', async () => {
    const otherStaff = await ownerPrisma.staffUser.findUniqueOrThrow({
      where: { email: 'admin@pgp.test' },
    });

    const response = await request(app.server)
      .post('/verify/redemptions')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        verificationSession: issueVerificationSession(otherStaff.id, memberId),
        memberId,
        benefitId: spaBenefitId,
        partySize: 1,
        idempotencyKey: key('wrong-staff'),
      });

    expect(response.status).toBe(403);
  });

  it('refuses an expired session', async () => {
    const stale = issueVerificationSession(
      outletStaffId,
      memberId,
      new Date(Date.now() - (env.VERIFICATION_SESSION_TTL_SECONDS + 60) * 1000),
    );

    const response = await request(app.server)
      .post('/verify/redemptions')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        verificationSession: stale,
        memberId,
        benefitId: spaBenefitId,
        partySize: 1,
        idempotencyKey: key('stale-session'),
      });

    expect(response.status).toBe(403);
  });

  it('refuses a forged session', async () => {
    const response = await request(app.server)
      .post('/verify/redemptions')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        verificationSession: `vs1.${outletStaffId}.${memberId}.${Math.floor(Date.now() / 1000)}.forged`,
        memberId,
        benefitId: spaBenefitId,
        partySize: 1,
        idempotencyKey: key('forged-session'),
      });

    expect(response.status).toBe(403);
  });

  it('accepts the session that resolve actually issued', async () => {
    // End to end through both endpoints, as the verification page does it.
    const resolved = await request(app.server)
      .post('/verify/resolve')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ membershipNumber: memberNumber });

    expect(resolved.status).toBe(200);
    expect(resolved.body.verificationSession).toBeTruthy();

    const recorded = await request(app.server)
      .post('/verify/redemptions')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        verificationSession: resolved.body.verificationSession,
        memberId: resolved.body.member.id,
        benefitId: spaBenefitId,
        partySize: 2,
        idempotencyKey: key('end-to-end'),
      });

    expect(recorded.status).toBe(201);
  });
});

describe('money never becomes a float', () => {
  it('stores and returns bill amounts as integer minor units', async () => {
    const created = await request(app.server)
      .post('/verify/redemptions')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        verificationSession: session(memberId),
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
      .post('/verify/redemptions')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        verificationSession: session(memberId),
        memberId,
        benefitId: spaBenefitId,
        partySize: 1,
        billAmountMinor: 100.5,
        idempotencyKey: key('money-float'),
      });

    expect(response.status).toBe(400);
  });
});
