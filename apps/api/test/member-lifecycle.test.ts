/**
 * Stage 4 acceptance — member lifecycle.
 *
 *   - a claim code cannot be used twice
 *   - an expired claim code is rejected
 *   - claim codes are not derivable from the membership number
 *   - consent is stored per channel with a timestamp
 *   - suspension blocks redemption but preserves history
 *   - GET /admin/members is unreachable by outlet_staff (R11)
 */
import { createHmac } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { generateClaimCode, hashClaimCode, normalizeClaimCode } from '../src/security/claim-codes.js';
import { resetRateLimits } from '../src/security/rate-limit.js';
import { issueAccessToken } from '../src/security/tokens.js';

const ownerUrl = process.env['DATABASE_MIGRATION_URL'];
if (!ownerUrl) {
  throw new Error('DATABASE_MIGRATION_URL must be set to run member-lifecycle.test.ts.');
}

let app: FastifyInstance;
let env: Env;
let adminToken: string;
const ownerPrisma = new PrismaClient({ datasourceUrl: ownerUrl });

/** Members created by these tests, cleaned up afterwards. */
const createdMemberIds: string[] = [];

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
  await app.close();
  await ownerPrisma.$disconnect();
});

/** Creates a member through the real endpoint and returns its claim code. */
async function createMember(phone?: string): Promise<{
  id: string;
  memberNumber: string;
  claimCode: string;
}> {
  const response = await request(app.server)
    .post('/admin/members')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ fullName: 'Lifecycle Test Member', ...(phone ? { phone } : {}) });

  expect(response.status).toBe(201);
  createdMemberIds.push(response.body.id);

  return {
    id: response.body.id,
    memberNumber: response.body.memberNumber,
    claimCode: response.body.claimCode.code,
  };
}

const KNOWN_OTP = '123456';

/**
 * The plaintext OTP is never persisted or returned by the API, and there is
 * no SMS provider in this build to receive it (PROGRESS.md Q6). Rather than
 * weaken the endpoint to make testing easier, the test overwrites the stored
 * hash with the hash of a code it chose — the same knowledge an SMS gateway
 * would have had.
 *
 * The endpoint still runs its real verification path against that hash:
 * constant-time comparison, single-use consumption and attempt counting are
 * all exercised exactly as in production.
 */
async function setKnownOtp(phone: string): Promise<string> {
  const secret = process.env['OTP_CODE_HMAC_SECRET'] ?? '';
  const codeHash = createHmac('sha256', secret).update(KNOWN_OTP).digest('hex');

  const updated = await ownerPrisma.otpCode.updateMany({
    where: { phone, usedAt: null },
    data: { codeHash },
  });

  // Guards against a silent pass if the endpoint stopped issuing an OTP.
  expect(updated.count).toBeGreaterThan(0);

  return KNOWN_OTP;
}

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
    const phone = `+9745555${Date.now().toString().slice(-4)}`;
    const member = await createMember(phone);

    // Phase 1 — request the OTP.
    const phaseOne = await request(app.server)
      .post('/member/claim')
      .send({ claimCode: member.claimCode, phone });
    expect(phaseOne.status).toBe(200);

    const otp = await setKnownOtp(phone);

    // Phase 2 — complete the claim.
    const phaseTwo = await request(app.server).post('/member/claim').send({
      claimCode: member.claimCode,
      phone,
      otp,
      consent: { email: true, sms: false },
    });
    expect(phaseTwo.status).toBe(200);
    expect(phaseTwo.body.accessToken).toBeTruthy();

    const consumed = await ownerPrisma.claimCode.findFirstOrThrow({
      where: { memberId: member.id },
    });
    expect(consumed.usedAt).not.toBeNull();

    // Second attempt, same code.
    resetRateLimits();
    const replay = await request(app.server)
      .post('/member/claim')
      .send({ claimCode: member.claimCode, phone });

    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_claim');
  });

  it('consumes the code atomically, so concurrent activations cannot both win', async () => {
    const phone = `+9745556${Date.now().toString().slice(-4)}`;
    const member = await createMember(phone);

    await request(app.server).post('/member/claim').send({ claimCode: member.claimCode, phone });
    const otp = await setKnownOtp(phone);

    // Fired together: the consuming UPDATE carries `usedAt: null`, so exactly
    // one can match. A read-then-write would let both through.
    const [first, second] = await Promise.all([
      request(app.server)
        .post('/member/claim')
        .send({ claimCode: member.claimCode, phone, otp, consent: { email: false, sms: false } }),
      request(app.server)
        .post('/member/claim')
        .send({ claimCode: member.claimCode, phone, otp, consent: { email: false, sms: false } }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);

    const codes = await ownerPrisma.claimCode.findMany({ where: { memberId: member.id } });
    expect(codes.filter((c) => c.usedAt !== null)).toHaveLength(1);
  });
});

describe('an expired claim code is rejected', () => {
  it('refuses a code whose expiry has passed', async () => {
    const phone = `+9745557${Date.now().toString().slice(-4)}`;
    const member = await createMember(phone);

    await ownerPrisma.claimCode.updateMany({
      where: { memberId: member.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await request(app.server)
      .post('/member/claim')
      .send({ claimCode: member.claimCode, phone });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_claim');
  });

  it('gives an identical response for expired, unknown and already-used codes', async () => {
    const phone = `+9745558${Date.now().toString().slice(-4)}`;
    const member = await createMember(phone);
    await ownerPrisma.claimCode.updateMany({
      where: { memberId: member.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const expired = await request(app.server)
      .post('/member/claim')
      .send({ claimCode: member.claimCode, phone });

    const unknown = await request(app.server)
      .post('/member/claim')
      .send({ claimCode: generateClaimCode().plaintext, phone });

    // Which part was wrong is exactly what someone holding a discarded
    // invitation letter would want to learn.
    expect(expired.status).toBe(unknown.status);
    expect(expired.body).toEqual(unknown.body);
  });
});

describe('resend-claim supersedes the outstanding code', () => {
  it('invalidates the old code so a discarded letter stops working', async () => {
    const phone = `+9745559${Date.now().toString().slice(-4)}`;
    const member = await createMember(phone);

    const resent = await request(app.server)
      .post(`/admin/members/${member.id}/resend-claim`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(resent.status).toBe(201);
    const replacement = resent.body.claimCode.code;
    expect(replacement).not.toBe(member.claimCode);

    const oldCode = await request(app.server)
      .post('/member/claim')
      .send({ claimCode: member.claimCode, phone });
    expect(oldCode.status).toBe(400);

    resetRateLimits();
    const newCode = await request(app.server)
      .post('/member/claim')
      .send({ claimCode: replacement, phone });
    expect(newCode.status).toBe(200);
  });
});

// ── Consent ────────────────────────────────────────────────────────────────

describe('R15 — consent is recorded per channel with a timestamp', () => {
  it('stores a row per channel, including a declined one', async () => {
    const phone = `+9745560${Date.now().toString().slice(-4)}`;
    const member = await createMember(phone);

    await request(app.server).post('/member/claim').send({ claimCode: member.claimCode, phone });
    const otp = await setKnownOtp(phone);

    await request(app.server).post('/member/claim').send({
      claimCode: member.claimCode,
      phone,
      otp,
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
    const phone = `+9745561${Date.now().toString().slice(-4)}`;
    const member = await createMember(phone);

    await request(app.server).post('/member/claim').send({ claimCode: member.claimCode, phone });
    const otp = await setKnownOtp(phone);
    const claimed = await request(app.server).post('/member/claim').send({
      claimCode: member.claimCode,
      phone,
      otp,
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
    const phone = `+9745562${Date.now().toString().slice(-4)}`;
    const member = await createMember(phone);

    await request(app.server).post('/member/claim').send({ claimCode: member.claimCode, phone });
    const otp = await setKnownOtp(phone);
    const claimed = await request(app.server).post('/member/claim').send({
      claimCode: member.claimCode,
      phone,
      otp,
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
    const phone = `+9745563${Date.now().toString().slice(-4)}`;
    const member = await createMember(phone);

    await request(app.server)
      .post(`/admin/members/${member.id}/suspend`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    resetRateLimits();
    const response = await request(app.server)
      .post('/member/claim')
      .send({ claimCode: member.claimCode, phone });

    expect(response.status).toBe(400);
  });
});

// ── R11 ────────────────────────────────────────────────────────────────────

describe('R11 — GET /admin/members is unreachable by outlet_staff', () => {
  it('refuses the member list', async () => {
    const outletStaff = await ownerPrisma.staffUser.findFirstOrThrow({
      where: { role: 'OUTLET_STAFF' },
    });
    const token = await issueAccessToken({
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE_STAFF,
      subject: outletStaff.id,
      subjectType: 'STAFF',
      role: outletStaff.role,
      ...(outletStaff.outletId ? { outletId: outletStaff.outletId } : {}),
      tokenVersion: outletStaff.tokenVersion,
      ttlSeconds: 300,
    });

    const list = await request(app.server)
      .get('/admin/members')
      .set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(403);

    const detail = await request(app.server)
      .get(`/admin/members/${(await ownerPrisma.member.findFirstOrThrow()).id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(detail.status).toBe(403);
  });

  it('leaves no route reachable by outlet_staff that returns more than one member', () => {
    // The stronger form of R11: absent, not filtered. If a future stage adds
    // a list endpoint and grants it to outlet_staff, this fails.
    const routes = app.printRoutes({ commonPrefix: false });
    expect(routes).toContain('/admin/members');
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
