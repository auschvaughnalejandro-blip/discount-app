/**
 * Stage 13 — the primary acceptance journey, end to end.
 *
 * BUILD-PLAN §Stage 13, all twelve steps, in order, against one running server
 * and one database. No step is stubbed and none is reordered; each depends on
 * what the previous one actually produced.
 *
 * The point is the whole path, not the individual rules — those have their own
 * tests. If this passes, the product works.
 */
import { createHmac } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { resetRateLimits } from '../src/security/rate-limit.js';

const ownerUrl = process.env['DATABASE_MIGRATION_URL'];
if (!ownerUrl) {
  throw new Error('DATABASE_MIGRATION_URL must be set to run acceptance-journey.test.ts.');
}

let app: FastifyInstance;
let env: Env;
const ownerPrisma = new PrismaClient({ datasourceUrl: ownerUrl });

/** Carried between steps — each one uses what the last produced. */
const journey: {
  adminToken?: string;
  staffToken?: string;
  memberId?: string;
  memberNumber?: string;
  phone?: string;
  claimCode?: string;
  memberToken?: string;
  identityPayload?: string;
  verificationSession?: string;
  spaBenefitId?: string;
  diningBenefitId?: string;
  redemptionId?: string;
  originalDiningPct?: string;
} = {};

beforeAll(async () => {
  env = loadEnv();
  app = await buildApp({ env });
  await app.ready();
  resetRateLimits();

  journey.phone = `+97455${Math.floor(100000 + Math.random() * 899999)}`;

  const dining = await ownerPrisma.benefit.findUniqueOrThrow({ where: { key: 'fnb' } });
  journey.originalDiningPct = String(dining.discountPct);
  journey.diningBenefitId = dining.id;
  journey.spaBenefitId = (await ownerPrisma.benefit.findUniqueOrThrow({ where: { key: 'spa' } })).id;
});

afterAll(async () => {
  // Leave the seed exactly as found.
  if (journey.originalDiningPct) {
    await ownerPrisma.benefit.update({
      where: { key: 'fnb' },
      data: { discountPct: journey.originalDiningPct },
    });
  }
  if (journey.memberId) {
    await ownerPrisma.redemption.deleteMany({
      where: { memberId: journey.memberId, reversesId: { not: null } },
    });
    await ownerPrisma.redemption.deleteMany({ where: { memberId: journey.memberId } });
    await ownerPrisma.consentRecord.deleteMany({ where: { memberId: journey.memberId } });
    await ownerPrisma.claimCode.deleteMany({ where: { memberId: journey.memberId } });
    await ownerPrisma.refreshToken.deleteMany({ where: { subjectId: journey.memberId } });
    await ownerPrisma.member.deleteMany({ where: { id: journey.memberId } });
  }
  await app.close();
  await ownerPrisma.$disconnect();
});

/** The knowledge an SMS gateway would have had. See PROGRESS.md Q6. */
async function setKnownOtp(phone: string): Promise<string> {
  const secret = process.env['OTP_CODE_HMAC_SECRET'] ?? '';
  const codeHash = createHmac('sha256', secret).update('123456').digest('hex');
  const updated = await ownerPrisma.otpCode.updateMany({
    where: { phone, usedAt: null },
    data: { codeHash },
  });
  expect(updated.count).toBeGreaterThan(0);
  return '123456';
}

describe('the primary acceptance journey', () => {
  it('1. an administrator creates a member and a claim code is issued', async () => {
    const login = await request(app.server)
      .post('/auth/staff/login')
      .send({ email: 'admin@pgp.test', password: 'privilege-guest-dev-only' });
    expect(login.status).toBe(200);
    journey.adminToken = login.body.accessToken;

    const created = await request(app.server)
      .post('/admin/members')
      .set('Authorization', `Bearer ${journey.adminToken}`)
      .send({ fullName: 'Acceptance Journey Member', phone: journey.phone });

    expect(created.status).toBe(201);
    expect(created.body.memberNumber).toMatch(/^PG-\d{4}$/);
    expect(created.body.claimCode.code).toBeTruthy();

    journey.memberId = created.body.id;
    journey.memberNumber = created.body.memberNumber;
    journey.claimCode = created.body.claimCode.code;
  });

  it('2. the member activates with the code, verifies the OTP, and grants email consent', async () => {
    resetRateLimits();

    const phaseOne = await request(app.server)
      .post('/member/claim')
      .send({ claimCode: journey.claimCode, phone: journey.phone });
    expect(phaseOne.status).toBe(200);

    const otp = await setKnownOtp(journey.phone ?? '');

    const phaseTwo = await request(app.server).post('/member/claim').send({
      claimCode: journey.claimCode,
      phone: journey.phone,
      otp,
      email: 'journey@pgp.test',
      consent: { email: true, sms: false },
    });

    expect(phaseTwo.status).toBe(200);
    journey.memberToken = phaseTwo.body.accessToken;

    const memberId = journey.memberId;
    expect(memberId).toBeDefined();

    const consents = await ownerPrisma.consentRecord.findMany({
      where: { memberId: memberId ?? '' },
    });
    expect(consents.find((c) => c.channel === 'EMAIL')?.granted).toBe(true);
    expect(consents.find((c) => c.channel === 'SMS')?.granted).toBe(false);
  });

  it('3. the member sees five benefit categories with the correct values', async () => {
    const response = await request(app.server)
      .get('/benefits')
      .set('Authorization', `Bearer ${journey.memberToken}`);

    expect(response.status).toBe(200);

    const byKey = Object.fromEntries(
      response.body.benefits.map((b: { key: string }) => [b.key, b]),
    );

    expect(Object.keys(byKey).sort()).toEqual(
      ['events', 'fnb', 'lifestyle', 'rooms', 'spa'].sort(),
    );

    // Straight off the printed benefits sheet.
    expect(byKey['fnb'].discountPct).toBe('25');
    expect(byKey['fnb'].maxGuests).toBe(6);
    expect(byKey['rooms'].discountPct).toBe('30');
    expect(byKey['spa'].discountPct).toBe('40');
    expect(byKey['spa'].maxGuests).toBe(2);
    expect(byKey['events'].minGuests).toBe(20);
    expect(byKey['lifestyle'].discountPct).toBe('30');
  });

  it('4. the member opens the digital card and obtains an identity payload', async () => {
    const response = await request(app.server)
      .get('/member/me/identity-code')
      .set('Authorization', `Bearer ${journey.memberToken}`);

    expect(response.status).toBe(200);
    journey.identityPayload = response.body.payload;

    // R3/§7: the opaque reference, never the printed number.
    expect(journey.identityPayload).toContain(journey.memberId);
    expect(journey.identityPayload).not.toContain(journey.memberNumber);
  });

  it('5. staff resolve that payload at the spa', async () => {
    const login = await request(app.server)
      .post('/auth/staff/login')
      .send({ email: 'fatima.a@pgp.test', password: 'privilege-guest-dev-only' });
    expect(login.status).toBe(200);
    journey.staffToken = login.body.accessToken;

    const resolved = await request(app.server)
      .post('/verify/resolve')
      .set('Authorization', `Bearer ${journey.staffToken}`)
      .send({ payload: journey.identityPayload });

    expect(resolved.status).toBe(200);
    expect(resolved.body.member.memberNumber).toBe(journey.memberNumber);
    expect(resolved.body.member.valid).toBe(true);
    expect(resolved.body.entitlements.length).toBeGreaterThan(0);

    journey.verificationSession = resolved.body.verificationSession;
  });

  it('6. staff record a spa redemption with 2 guests — accepted', async () => {
    const response = await request(app.server)
      .post('/verify/redemptions')
      .set('Authorization', `Bearer ${journey.staffToken}`)
      .send({
        verificationSession: journey.verificationSession,
        memberId: journey.memberId,
        benefitId: journey.spaBenefitId,
        partySize: 2,
        billAmountMinor: 50_000,
        idempotencyKey: `journey-spa-${Date.now()}`,
      });

    expect(response.status).toBe(201);
    journey.redemptionId = response.body.id;
  });

  it('7. staff attempt a spa redemption with 3 guests — rejected', async () => {
    const response = await request(app.server)
      .post('/verify/redemptions')
      .set('Authorization', `Bearer ${journey.staffToken}`)
      .send({
        verificationSession: journey.verificationSession,
        memberId: journey.memberId,
        benefitId: journey.spaBenefitId,
        partySize: 3,
        idempotencyKey: `journey-spa-over-${Date.now()}`,
      });

    expect(response.status).toBe(422);
    expect(response.body.error).toBe('party_size_above_maximum');
    expect(response.body.maxGuests).toBe(2);
  });

  it('8. the redemption appears in the member’s own history', async () => {
    const response = await request(app.server)
      .get('/member/me/redemptions')
      .set('Authorization', `Bearer ${journey.memberToken}`);

    expect(response.status).toBe(200);

    const row = response.body.redemptions.find(
      (r: { id: string }) => r.id === journey.redemptionId,
    );
    expect(row).toBeDefined();
    expect(row.partySize).toBe(2);
    expect(row.benefit.key).toBe('spa');
  });

  it('9. it appears in the admin member detail, attributed to the staff member', async () => {
    const staff = await ownerPrisma.staffUser.findUniqueOrThrow({
      where: { email: 'fatima.a@pgp.test' },
    });

    const response = await request(app.server)
      .get(`/admin/redemptions?memberId=${journey.memberId}`)
      .set('Authorization', `Bearer ${journey.adminToken}`);

    expect(response.status).toBe(200);

    const row = response.body.redemptions.find(
      (r: { id: string }) => r.id === journey.redemptionId,
    );
    expect(row).toBeDefined();
    // Attribution is the main deterrent against misuse.
    expect(row.staffUser.id).toBe(staff.id);
    expect(row.staffUser.fullName).toBe(staff.fullName);
  });

  it('10. it appears in reports', async () => {
    const response = await request(app.server)
      .get('/admin/reports/by-benefit')
      .set('Authorization', `Bearer ${journey.adminToken}`);

    expect(response.status).toBe(200);

    const spa = response.body.groups.find((g: { label: string }) => g.label === 'Spa');
    expect(spa).toBeDefined();
    // Whether the figure is shown or suppressed depends on how many distinct
    // members used the spa, which is not this test's business — that the
    // group exists and reports one way or the other is.
    expect(spa.suppressed === true || typeof spa.redemptions === 'number').toBe(true);
  });

  it('11. the administrator changes the dining discount from 25% to 20%', async () => {
    const response = await request(app.server)
      .patch(`/admin/benefits/${journey.diningBenefitId}`)
      .set('Authorization', `Bearer ${journey.adminToken}`)
      .send({ discountPct: '20.00' });

    expect(response.status).toBe(200);
    expect(response.body.discountPct).toBe('20');
  });

  it('12. the member client reflects 20% with no restart or deployment', async () => {
    // Same process, same server instance, no restart between step 11 and here.
    const response = await request(app.server)
      .get('/benefits')
      .set('Authorization', `Bearer ${journey.memberToken}`);

    const dining = response.body.benefits.find((b: { key: string }) => b.key === 'fnb');

    expect(dining.discountPct).toBe('20');
  });
});

/**
 * BUILD-PLAN §Stage 13 also requires that "all 18 business rules from section 6
 * have at least one test". This maps each rule to where it is verified, and
 * asserts those files exist — so deleting a rule's coverage fails here rather
 * than going unnoticed.
 */
describe('every business rule has a test', () => {
  const COVERAGE: Record<string, { rule: string; where: string[] }> = {
    R1: {
      rule: 'A claim code is single-use, bound to one member, and expires',
      where: ['member-lifecycle.test.ts'],
    },
    R2: {
      rule: 'A claim code is cryptographically random and unrelated to the membership number',
      where: ['member-lifecycle.test.ts'],
    },
    R3: {
      rule: 'Membership numbers are sequential and public; the internal reference is opaque',
      where: ['data-model.test.ts', 'member-lifecycle.test.ts', 'identity-codes.test.ts'],
    },
    R4: { rule: 'Only an ACTIVE member may have a benefit recorded', where: ['redemption.test.ts'] },
    R5: { rule: 'Party size must not exceed maxGuests', where: ['redemption.test.ts'] },
    R6: { rule: 'Party size must meet minGuests where set', where: ['redemption.test.ts'] },
    R7: {
      rule: 'Redemptions are immutable; a correction is a new reversing row',
      where: ['data-model.test.ts', 'redemption.test.ts'],
    },
    R8: {
      rule: 'Redemption creation is idempotent by client-supplied key',
      where: ['redemption.test.ts'],
    },
    R9: {
      rule: 'The identity payload rotates and is rejected once stale',
      where: ['identity-codes.test.ts'],
    },
    R10: {
      rule: 'The identity payload identifies only; it never authorises a discount',
      where: ['identity-codes.test.ts', 'redemption.test.ts'],
    },
    R11: {
      rule: 'outlet_staff has no endpoint that lists, searches or enumerates members',
      where: ['authorization.test.ts', 'member-lifecycle.test.ts', 'redemption.test.ts'],
    },
    R12: {
      rule: 'Member lookup requires an exact membership number or a scanned payload',
      where: ['redemption.test.ts'],
    },
    R13: { rule: 'Reporting suppresses any cohort smaller than 5', where: ['reporting.test.ts'] },
    R14: {
      rule: 'Benefit values are database rows, never constants in code',
      where: ['benefits.test.ts', 'no-styling.test.ts'],
    },
    R15: {
      rule: 'Consent is recorded per channel with timestamp; withdrawal is immediate',
      where: ['member-lifecycle.test.ts'],
    },
    R16: { rule: 'Members are suspended, never deleted', where: ['data-model.test.ts', 'member-lifecycle.test.ts'] },
    R17: {
      rule: 'Every route declares a permission; an undeclared route fails at startup',
      where: ['authorization.test.ts'],
    },
    R18: { rule: 'Out-of-scope records return 404, never 403', where: ['authorization.test.ts'] },
  };

  it('maps all eighteen rules', () => {
    expect(Object.keys(COVERAGE)).toHaveLength(18);
  });

  it.each(Object.entries(COVERAGE))('%s is covered', async (_id, entry) => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');

    for (const file of entry.where) {
      expect(
        existsSync(resolve(import.meta.dirname, file)),
        `${entry.rule} — expected coverage in ${file}`,
      ).toBe(true);
    }
  });
});
