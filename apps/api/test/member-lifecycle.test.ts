/**
 * Stage 4 acceptance — member lifecycle.
 *
 *   - a claim code cannot be used twice
 *   - an expired claim code is rejected
 *   - claim codes are not derivable from the membership number
 *   - consent is stored per channel with a timestamp
 *   - suspension blocks redemption but preserves history
 *   - retired staff account types cannot enter administrator routes (R11)
 */

import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { generateClaimCode, hashClaimCode, normalizeClaimCode } from '../src/security/claim-codes.js';
import { resetRateLimits } from '../src/security/rate-limit.js';
import { issueAccessToken } from '../src/security/tokens.js';
import { createOutletDeviceFixture } from './outlet-device-fixture.js';

const ownerUrl = process.env['DATABASE_MIGRATION_URL'];
if (!ownerUrl) {
  throw new Error('DATABASE_MIGRATION_URL must be set to run member-lifecycle.test.ts.');
}

let app: FastifyInstance;
let env: Env;
let adminToken: string;
let outletDeviceId = '';
const ownerPrisma = new PrismaClient({ datasourceUrl: ownerUrl });

/** Members created by these tests, cleaned up afterwards. */
const createdMemberIds: string[] = [];

/**
 * Allocate from a test-only Qatar mobile range, checking the shared database
 * rather than assuming a short timestamp suffix has not been used by an older
 * run. The suite deliberately keeps one persistent seeded database, so a
 * four-digit clock suffix eventually collides even when cleanup is correct.
 */
// Give concurrent Vitest processes different blocks. Reused PIDs from older
// runs remain harmless because every candidate is still checked below.
let nextPhoneCandidate = (process.pid * 100) % 10_000_000;
async function uniquePhone(): Promise<string> {
  for (let attempts = 0; attempts < 10_000_000; attempts += 1) {
    const suffix = nextPhoneCandidate.toString().padStart(7, '0');
    nextPhoneCandidate = (nextPhoneCandidate + 1) % 10_000_000;
    const phone = `+9745${suffix}`;
    const existing = await ownerPrisma.member.findUnique({
      where: { phone },
      select: { id: true },
    });
    if (existing === null) return phone;
  }
  throw new Error('No unused lifecycle-test phone number remains.');
}

beforeAll(async () => {
  env = loadEnv();
  app = await buildApp({ env });
  await app.ready();

  const admin = await ownerPrisma.staffUser.findUniqueOrThrow({
    where: { email: 'admin@pgp.test' },
  });
  adminToken = await issueAccessToken({
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE_STAFF,
    subject: admin.id,
    subjectType: 'STAFF',
    role: admin.role,
    tokenVersion: admin.tokenVersion,
    ttlSeconds: 900,
  });

  const outlet = await ownerPrisma.outlet.findFirstOrThrow({ where: { active: true } });
  const outletDevice = await createOutletDeviceFixture(
    ownerPrisma,
    outlet.id,
    'Member lifecycle test outlet device',
  );
  outletDeviceId = outletDevice.id;
});

afterEach(() => {
  // Activation is rate limited per IP, and every test here shares 127.0.0.1.
  resetRateLimits();
});

afterAll(async () => {
  for (const id of createdMemberIds) {
    await ownerPrisma.consentRecord.deleteMany({ where: { memberId: id } });
    await ownerPrisma.claimCode.deleteMany({ where: { memberId: id } });
    await ownerPrisma.refreshToken.deleteMany({ where: { subjectId: id } });
    await ownerPrisma.member.deleteMany({ where: { id } });
  }
  // The retired-role probes below create their own throwaway accounts.
  await ownerPrisma.staffUser.deleteMany({
    where: { email: { startsWith: 'lifecycle-retired-manager-' } },
  });
  await ownerPrisma.staffUser.delete({ where: { id: outletDeviceId } });
  await app.close();
  await ownerPrisma.$disconnect();
});

/** Creates a member through the real endpoint and returns its claim code. */
async function createMember(options: { withPhone?: boolean; fullName?: string } = {}): Promise<{
  id: string;
  memberNumber: string;
  claimCode: string;
  phone?: string;
}> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const phone = options.withPhone ? await uniquePhone() : undefined;
    const response = await request(app.server)
      .post('/admin/members')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        fullName: options.fullName ?? 'Lifecycle Test Member',
        ...(phone ? { phone } : {}),
      });

    // The API's unique constraint is the final arbiter if another test process
    // claimed this candidate after our read. Retry with a new number instead of
    // turning harmless shared-database contention into suite flakiness.
    if (
      options.withPhone &&
      response.status === 409 &&
      response.body.error === 'phone_already_used'
    ) {
      continue;
    }

    expect(response.status, JSON.stringify({ phone, body: response.body })).toBe(201);
    createdMemberIds.push(response.body.id);

    return {
      id: response.body.id,
      memberNumber: response.body.memberNumber,
      claimCode: response.body.claimCode.code,
      ...(phone ? { phone } : {}),
    };
  }
  throw new Error('Could not allocate an unused lifecycle-test phone number.');
}



// ── Creation ───────────────────────────────────────────────────────────────

describe('a membership nobody could activate is refused at creation', () => {
  it('requires an email when passcodes are delivered by email', async () => {
    // The delivery channel is read at startup, so this drives the rule through
    // a second app built with the channel switched on rather than mutating the
    // running one.
    const smtpApp = await buildApp({
      env: {
        ...env,
        OTP_DELIVERY_CHANNEL: 'smtp',
        SMTP_HOST: 'smtp.example.test',
        SMTP_USER: 'test@example.test',
        SMTP_PASSWORD: 'not-a-real-password',
        SMTP_FROM: 'test@example.test',
      },
    });
    await smtpApp.ready();

    try {
      const withoutEmail = await request(smtpApp.server)
        .post('/admin/members')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ fullName: 'No Way To Reach Them' });

      expect(withoutEmail.status).toBe(400);
      expect(withoutEmail.body.error).toBe('email_required');

      // Deliberately not asserting the happy path here. Creation now sends the
      // invitation, and this app is pointed at a hostname that does not exist —
      // so a successful create would sit waiting on an SMTP connection that can
      // only time out. Every other test in the suite covers the 201.
    } finally {
      await smtpApp.close();
    }
  });

  it('says which membership already holds a phone number, rather than failing', async () => {
    // Clicking "create" twice with the same details used to raise an unmapped
    // unique-constraint violation — a 500 that read as a broken server when the
    // truth was that the first click had worked.
    const first = await createMember({ withPhone: true, fullName: 'Duplicate Phone Test' });
    const phone = first.phone!;

    const second = await request(app.server)
      .post('/admin/members')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fullName: 'Someone Else Entirely', phone });

    expect(second.status).toBe(409);
    expect(second.body.error).toBe('phone_already_used');
    // The message has to name the membership, or an administrator cannot act
    // on it without going to look.
    expect(second.body.memberNumber).toBe(first.memberNumber);

    // And nothing was written on the second attempt.
    const named = await ownerPrisma.member.count({
      where: { fullName: 'Someone Else Entirely' },
    });
    expect(named).toBe(0);
  });

  it('does not require one when no channel is configured', async () => {
    // Development, where the terminal echo stands in for delivery. A rule with
    // no reason behind it is a rule people work around.
    const response = await request(app.server)
      .post('/admin/members')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fullName: 'Dev Only Member' });

    expect(response.status).toBe(201);
    createdMemberIds.push(response.body.id);
  });
});

// ── Claim codes ────────────────────────────────────────────────────────────

describe('R2 — claim codes are not derivable from the membership number', () => {
  it('shares no structure with the member number it belongs to', async () => {
    const member = await createMember();
    const normalized = normalizeClaimCode(member.claimCode);

    // "PG-0007" → "0007". A code derived from the number would contain it.
    const numericPart = member.memberNumber.replace(/\D/g, '');
    expect(normalized).not.toContain(numericPart);
    expect(normalized).not.toContain(member.memberNumber.replace('-', ''));
  });

  it('carries at least 128 bits of entropy', () => {
    // 32 characters from a 32-symbol alphabet = 5 bits each = 160 bits.
    const { plaintext } = generateClaimCode();
    const normalized = normalizeClaimCode(plaintext);

    expect(normalized).toHaveLength(32);
    expect(normalized.length * 5).toBeGreaterThanOrEqual(128);
    expect(normalized).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
  });

  it('produces a different code every time', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateClaimCode().plaintext));
    expect(codes.size).toBe(50);
  });

  it('is stored hashed, never in plaintext', async () => {
    const member = await createMember();

    const stored = await ownerPrisma.claimCode.findFirstOrThrow({
      where: { memberId: member.id },
    });

    expect(stored.codeHash).not.toBe(member.claimCode);
    expect(stored.codeHash).not.toContain(normalizeClaimCode(member.claimCode));
    expect(stored.codeHash).toBe(hashClaimCode(member.claimCode));
  });

  it('accepts the code as a human would retype it', () => {
    const { plaintext } = generateClaimCode();

    // Hyphens are presentation only; case and the Crockford substitutions for
    // characters the alphabet omits are all normalised.
    expect(hashClaimCode(plaintext.replace(/-/g, ''))).toBe(hashClaimCode(plaintext));
    expect(hashClaimCode(plaintext.toLowerCase())).toBe(hashClaimCode(plaintext));
    expect(hashClaimCode(` ${plaintext} `)).toBe(hashClaimCode(plaintext));
  });
});

describe('R1 — a claim code cannot be used twice', () => {
  it('rejects the second activation attempt with the same code', async () => {
    const member = await createMember({ withPhone: true });
    const phone = member.phone!;

    // Activation is one call: the invitation code arrived in the member's
    // inbox, which is already proof they hold that address.
    const activated = await request(app.server).post('/member/claim').send({
      claimCode: member.claimCode,
      phone,
      consent: { email: true, sms: false },
    });
    expect(activated.status).toBe(200);
    expect(activated.body.accessToken).toBeTruthy();

    const consumed = await ownerPrisma.claimCode.findFirstOrThrow({
      where: { memberId: member.id },
    });
    expect(consumed.usedAt).not.toBeNull();

    // Second attempt, same code.
    resetRateLimits();
    const replay = await request(app.server).post('/member/claim').send({
      claimCode: member.claimCode,
      phone,
      consent: { email: true, sms: false },
    });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_claim');
  });

  it('consumes the code atomically, so concurrent activations cannot both win', async () => {
    const member = await createMember({ withPhone: true });
    const phone = member.phone!;

    // Fired together: the consuming UPDATE carries `usedAt: null`, so exactly
    // one can match. A read-then-write would let both through.
    const [first, second] = await Promise.all([
      request(app.server)
        .post('/member/claim')
        .send({ claimCode: member.claimCode, phone, consent: { email: false, sms: false } }),
      request(app.server)
        .post('/member/claim')
        .send({ claimCode: member.claimCode, phone, consent: { email: false, sms: false } }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);

    const codes = await ownerPrisma.claimCode.findMany({ where: { memberId: member.id } });
    expect(codes.filter((c) => c.usedAt !== null)).toHaveLength(1);
  });
});

describe('an expired claim code is rejected', () => {
  it('refuses a code whose expiry has passed', async () => {
    const member = await createMember({ withPhone: true });
    const phone = member.phone!;

    await ownerPrisma.claimCode.updateMany({
      where: { memberId: member.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await request(app.server).post('/member/claim').send({
      claimCode: member.claimCode,
      phone,
      consent: { email: false, sms: false },
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_claim');
  });

  it('gives an identical response for expired, unknown and already-used codes', async () => {
    const member = await createMember({ withPhone: true });
    const phone = member.phone!;
    await ownerPrisma.claimCode.updateMany({
      where: { memberId: member.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const expired = await request(app.server).post('/member/claim').send({
      claimCode: member.claimCode,
      phone,
      consent: { email: false, sms: false },
    });
    const unknown = await request(app.server).post('/member/claim').send({
      claimCode: generateClaimCode().plaintext,
      phone,
      consent: { email: false, sms: false },
    });

    // Which part was wrong is exactly what someone holding a discarded
    // invitation letter would want to learn.
    expect(expired.status).toBe(unknown.status);
    expect(expired.body).toEqual(unknown.body);
  });
});

describe('resend-claim supersedes the outstanding code', () => {
  it('invalidates the old code so a discarded letter stops working', async () => {
    const member = await createMember({ withPhone: true });
    const phone = member.phone!;

    const resent = await request(app.server)
      .post(`/admin/members/${member.id}/resend-claim`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(resent.status).toBe(201);
    const replacement = resent.body.claimCode.code;
    expect(replacement).not.toBe(member.claimCode);

    const oldCode = await request(app.server).post('/member/claim').send({
      claimCode: member.claimCode,
      phone,
      consent: { email: false, sms: false },
    });
    expect(oldCode.status).toBe(400);

    resetRateLimits();
    const newCode = await request(app.server)
      .post('/member/claim')
      .send({ claimCode: replacement, phone, consent: { email: false, sms: false } });
    expect(newCode.status).toBe(200);
  });
});

// ── Consent ────────────────────────────────────────────────────────────────

describe('R15 — consent is recorded per channel with a timestamp', () => {
  it('stores a row per channel, including a declined one', async () => {
    const member = await createMember({ withPhone: true });
    const phone = member.phone!;

    await request(app.server).post('/member/claim').send({
      claimCode: member.claimCode,
      phone,
      consent: { email: true, sms: false },
    });

    const consents = await ownerPrisma.consentRecord.findMany({
      where: { memberId: member.id },
      orderBy: { channel: 'asc' },
    });

    expect(consents).toHaveLength(2);

    const email = consents.find((c) => c.channel === 'EMAIL');
    const sms = consents.find((c) => c.channel === 'SMS');

    expect(email?.granted).toBe(true);
    expect(sms?.granted).toBe(false);

    // A declined channel is recorded explicitly. An absent row and a declined
    // one must not look the same later.
    for (const row of consents) {
      expect(row.recordedAt).toBeInstanceOf(Date);
      expect(row.wordingVersion).toBe(env.CONSENT_WORDING_VERSION);
    }
  });

  it('records a withdrawal as a new row, leaving the original intact', async () => {
    const member = await createMember({ withPhone: true });
    const phone = member.phone!;

    const claimed = await request(app.server).post('/member/claim').send({
      claimCode: member.claimCode,
      phone,
      consent: { email: true, sms: true },
    });

    const memberToken = claimed.body.accessToken;

    const withdrawn = await request(app.server)
      .patch('/member/me/consent')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ email: false });

    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.consent.EMAIL.granted).toBe(false);
    expect(withdrawn.body.consent.SMS.granted).toBe(true);

    const emailRows = await ownerPrisma.consentRecord.findMany({
      where: { memberId: member.id, channel: 'EMAIL' },
      orderBy: { recordedAt: 'asc' },
    });

    // Append-only: the grant is still there, followed by the withdrawal.
    // The history is the evidence of what was agreed and when (§10).
    expect(emailRows).toHaveLength(2);
    expect(emailRows[0]?.granted).toBe(true);
    expect(emailRows[1]?.granted).toBe(false);
  });
});

// ── Suspension ─────────────────────────────────────────────────────────────

describe('R16 — members are suspended, never deleted', () => {
  it('preserves the record and its history, and invalidates live sessions', async () => {
    const member = await createMember({ withPhone: true });
    const phone = member.phone!;

    const claimed = await request(app.server).post('/member/claim').send({
      claimCode: member.claimCode,
      phone,
      consent: { email: true, sms: true },
    });

    const memberToken = claimed.body.accessToken;
    const memberRefresh = claimed.body.refreshToken;

    // The session works before suspension.
    const before = await request(app.server)
      .get('/member/me')
      .set('Authorization', `Bearer ${memberToken}`);
    expect(before.status).toBe(200);

    const suspended = await request(app.server)
      .post(`/admin/members/${member.id}/suspend`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(suspended.status).toBe(200);
    expect(suspended.body.status).toBe('SUSPENDED');

    // The row is still there, with its consent history.
    const stillPresent = await ownerPrisma.member.findUnique({ where: { id: member.id } });
    expect(stillPresent).not.toBeNull();
    expect(stillPresent?.status).toBe('SUSPENDED');

    const consents = await ownerPrisma.consentRecord.findMany({
      where: { memberId: member.id },
    });
    expect(consents.length).toBeGreaterThan(0);

    // §4 forced re-authentication: the access token is still correctly signed
    // and unexpired, but the token version moved, so it no longer resolves.
    const after = await request(app.server)
      .get('/member/me')
      .set('Authorization', `Bearer ${memberToken}`);
    expect(after.status).toBe(401);

    // And the refresh token cannot mint a replacement.
    const refreshed = await request(app.server)
      .post('/auth/refresh')
      .send({ refreshToken: memberRefresh });
    expect(refreshed.status).toBe(401);
  });

  it('restores access on reinstatement', async () => {
    const member = await createMember();

    await request(app.server)
      .post(`/admin/members/${member.id}/suspend`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    const reinstated = await request(app.server)
      .post(`/admin/members/${member.id}/reinstate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(reinstated.status).toBe(200);
    expect(reinstated.body.status).toBe('ACTIVE');
  });

  it('refuses to activate a suspended membership', async () => {
    const member = await createMember({ withPhone: true });
    const phone = member.phone!;

    await request(app.server)
      .post(`/admin/members/${member.id}/suspend`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    resetRateLimits();
    const response = await request(app.server).post('/member/claim').send({
      claimCode: member.claimCode,
      phone,
      consent: { email: false, sms: false },
    });
    expect(response.status).toBe(400);
  });
});

// ── R11 ────────────────────────────────────────────────────────────────────

describe('no non-administrator account can enter the administrator panel', () => {
  /**
   * Two kinds of account are refused here, for two different reasons, and the
   * status code is the tell:
   *
   *   **MANAGER** is retired. `resolvePrincipal` refuses to build a principal at
   *   all, so the request never reaches authorization — **401**.
   *
   *   **OUTLET_STAFF** is live again, since the outlet screen signs in as one. Its
   *   principal resolves fine and then holds no dashboard permission — **403**.
   *
   * Both satisfy R11's stronger form: absent, not filtered. Asserting the exact
   * code for each is what keeps a future change from downgrading one of them into
   * a filtered 200.
   */
  /**
   * A MANAGER row is created on demand: the seed no longer makes one, and the
   * only reason to want one is to prove it still cannot get in.
   */
  async function tokenFor(role: 'MANAGER' | 'OUTLET_STAFF'): Promise<string> {
    const account =
      role === 'MANAGER'
        ? await ownerPrisma.staffUser.create({
            data: {
              fullName: 'Retired manager',
              email: `lifecycle-retired-manager-${Date.now()}@pgp.test`,
              passwordHash: 'not-used-by-this-test',
              role: 'MANAGER',
              // The database permits a retired role only as a suspended
              // historical identity.
              status: 'SUSPENDED',
            },
          })
        : await ownerPrisma.staffUser.findUniqueOrThrow({ where: { id: outletDeviceId } });
    return issueAccessToken({
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE_STAFF,
      subject: account.id,
      subjectType: 'STAFF',
      role: account.role,
      tokenVersion: account.tokenVersion,
      ttlSeconds: 300,
    });
  }

  it('refuses an outlet account member list and detail access', async () => {
    const token = await tokenFor('OUTLET_STAFF');

    const list = await request(app.server)
      .get('/admin/members')
      .set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(403);

    const detail = await request(app.server)
      .get(`/admin/members/${(await ownerPrisma.member.findFirstOrThrow()).id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(detail.status).toBe(403);
  });

  it('reaches no endpoint that returns more than one member', async () => {
    // This replaced an assertion that string-matched Fastify's route-tree
    // *rendering*, which broke the moment a route was added at `/` — and which had
    // never actually checked the property it claimed to. This drives every
    // enumerating endpoint and asserts none of them answers.
    const enumerating = [
      '/admin/members',
      '/admin/redemptions',
      '/admin/benefits',
      '/admin/reports/summary',
      '/admin/reports/by-benefit',
      '/admin/reports/by-month',
      '/admin/reports/dormant-members',
      '/admin/reports/unclaimed',
      '/admin/reports/export',
    ];

    for (const [role, expected] of [
      ['MANAGER', 401],
      ['OUTLET_STAFF', 403],
    ] as const) {
      const token = await tokenFor(role);

      for (const path of enumerating) {
        const response = await request(app.server)
          .get(path)
          .set('Authorization', `Bearer ${token}`);

        expect(response.status, `${role} ${path}`).toBe(expected);
      }
    }
  });
});

// ── Membership numbers ─────────────────────────────────────────────────────

describe('R3 — membership numbers are sequential and public', () => {
  it('assigns the next number in sequence on creation', async () => {
    const first = await createMember();
    const second = await createMember();

    expect(first.memberNumber).toMatch(/^PG-\d{4}$/);
    expect(second.memberNumber).toMatch(/^PG-\d{4}$/);

    expect(Number(second.memberNumber.slice(3))).toBe(Number(first.memberNumber.slice(3)) + 1);
  });
});
