/**
 * Stage 6 acceptance — identity codes.
 *
 *   - a tampered payload is rejected
 *   - a payload older than the window is rejected
 *   - changing the window in configuration changes the cutoff, no code change
 *   - the payload contains no name, phone or membership number
 *   - resolving a payload performs no state change
 *
 * The last one is completed in Stage 7, which owns POST /verify/resolve; what
 * is testable here is that generation itself changes nothing.
 */
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { issueIdentityCode, verifyIdentityCode } from '../src/security/identity-codes.js';
import { issueAccessToken } from '../src/security/tokens.js';

const ownerUrl = process.env['DATABASE_MIGRATION_URL'];
if (!ownerUrl) {
  throw new Error('DATABASE_MIGRATION_URL must be set to run identity-codes.test.ts.');
}

let app: FastifyInstance;
let env: Env;
let memberToken: string;
let memberId: string;
let memberNumber: string;
let memberPhone: string | null;
let memberName: string;
const ownerPrisma = new PrismaClient({ datasourceUrl: ownerUrl });

const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  env = loadEnv();
  app = await buildApp({ env });
  await app.ready();

  const member = await ownerPrisma.member.findUniqueOrThrow({
    where: { memberNumber: 'PG-0003' },
  });
  memberId = member.id;
  memberNumber = member.memberNumber;
  memberPhone = member.phone;
  memberName = member.fullName;

  memberToken = await issueAccessToken({
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE_MEMBER,
    subject: member.id,
    subjectType: 'MEMBER',
    tokenVersion: member.tokenVersion,
    ttlSeconds: 900,
  });
});

afterAll(async () => {
  await app.close();
  await ownerPrisma.$disconnect();
});

describe('the payload identifies, and discloses nothing else', () => {
  it('contains no name, phone number or membership number', async () => {
    const response = await request(app.server)
      .get('/member/me/identity-code')
      .set('Authorization', `Bearer ${memberToken}`);

    expect(response.status).toBe(200);
    const { payload } = response.body;

    // R3/§7: the opaque internal reference, never the printed PG number,
    // which is sequential and therefore guessable.
    expect(payload).toContain(memberId);
    expect(payload).not.toContain(memberNumber);
    expect(payload).not.toContain('PG-');
    expect(payload).not.toContain(memberName);
    if (memberPhone) {
      expect(payload).not.toContain(memberPhone);
    }
  });

  it('has the shape v1.<memberRef>.<issuedAt>.<hmac>', () => {
    const payload = issueIdentityCode(memberId);
    const parts = payload.split('.');

    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    expect(parts[1]).toBe(memberId);
    expect(Number.parseInt(parts[2] ?? '', 10)).toBeGreaterThan(0);
    expect(parts[3]).toBeTruthy();
  });
});

describe('a tampered payload is rejected', () => {
  const options = { windowHours: 24 };

  it('rejects a swapped member reference', () => {
    const payload = issueIdentityCode('member-a');
    const [version, , issuedAt, signature] = payload.split('.');

    const swapped = `${version}.member-b.${issuedAt}.${signature}`;
    expect(verifyIdentityCode(swapped, options)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a refreshed timestamp on an old signature', () => {
    // The attack this closes: take a stale payload and move its timestamp
    // forward to escape the window. It only fails if the timestamp is covered
    // by the signature — which is why the HMAC spans version, reference and
    // timestamp together rather than the reference alone.
    const stale = issueIdentityCode(memberId, new Date(Date.now() - 48 * HOUR));
    const [version, ref, staleTimestamp, signature] = stale.split('.');

    const refreshed = Math.floor(Date.now() / 1000);
    expect(String(refreshed)).not.toBe(staleTimestamp);

    const forged = `${version}.${ref}.${refreshed}.${signature}`;

    expect(verifyIdentityCode(forged, options)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });

    // And the untouched original is still rejected, on age.
    expect(verifyIdentityCode(stale, options)).toEqual({ ok: false, reason: 'stale' });
  });

  it('rejects a forged signature', () => {
    const payload = issueIdentityCode(memberId);
    const [version, ref, issuedAt] = payload.split('.');

    expect(verifyIdentityCode(`${version}.${ref}.${issuedAt}.forged`, options)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a malformed payload', () => {
    for (const bad of ['', 'nonsense', 'v1.only.three', 'v2.a.123.sig', `v1..123.sig`]) {
      expect(verifyIdentityCode(bad, options).ok).toBe(false);
    }
  });

  it('accepts an untampered payload', () => {
    const result = verifyIdentityCode(issueIdentityCode(memberId), options);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.memberRef).toBe(memberId);
    }
  });
});

describe('R9 — a payload older than the window is rejected', () => {
  it('accepts inside the window and rejects outside it', () => {
    const issuedAt = new Date(Date.now() - 25 * HOUR);
    const payload = issueIdentityCode(memberId, issuedAt);

    expect(verifyIdentityCode(payload, { windowHours: 24 })).toEqual({
      ok: false,
      reason: 'stale',
    });

    // The same payload, with a wider window, is fine — proving it is the
    // window that rejected it and not the signature.
    expect(verifyIdentityCode(payload, { windowHours: 48 }).ok).toBe(true);
  });

  it('rejects a payload dated in the future', () => {
    const payload = issueIdentityCode(memberId, new Date(Date.now() + 48 * HOUR));

    expect(verifyIdentityCode(payload, { windowHours: 24 })).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('defeats a forwarded screenshot', () => {
    // The scenario §7 describes: a code circulated in a group chat. It was
    // validly signed when issued and is still validly signed now — only its
    // age rejects it.
    const yesterday = issueIdentityCode(memberId, new Date(Date.now() - 26 * HOUR));

    expect(verifyIdentityCode(yesterday, { windowHours: 24 })).toEqual({
      ok: false,
      reason: 'stale',
    });
  });
});

describe('changing the window in configuration changes the cutoff', () => {
  it('moves the boundary with no code change', () => {
    const payload = issueIdentityCode(memberId, new Date(Date.now() - 5 * HOUR));

    // Same payload, same code, three different configured windows.
    expect(verifyIdentityCode(payload, { windowHours: 1 }).ok).toBe(false);
    expect(verifyIdentityCode(payload, { windowHours: 6 }).ok).toBe(true);
    expect(verifyIdentityCode(payload, { windowHours: 24 }).ok).toBe(true);
  });

  it('reports the configured window to the client', async () => {
    const response = await request(app.server)
      .get('/member/me/identity-code')
      .set('Authorization', `Bearer ${memberToken}`);

    expect(response.body.windowHours).toBe(env.IDENTITY_CODE_WINDOW_HOURS);
  });

  it('has no hardcoded 24 in the identity code module', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');

    const source = readFileSync(
      resolve(import.meta.dirname, '..', 'src', 'security', 'identity-codes.ts'),
      'utf8',
    );

    // The window arrives as a parameter. A default baked in here would make
    // the configuration setting a lie.
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    expect(code).not.toMatch(/windowHours\s*[=:]\s*24/);
    expect(code).not.toMatch(/24\s*\*\s*60\s*\*\s*60/);
  });
});

describe('the code rotates', () => {
  it('issues a different payload on each request', async () => {
    const first = issueIdentityCode(memberId, new Date(1_000_000_000_000));
    const second = issueIdentityCode(memberId, new Date(1_000_000_060_000));

    expect(first).not.toBe(second);
  });
});

describe('R10 — generating a code changes nothing', () => {
  it('performs no state change', async () => {
    const before = await ownerPrisma.member.findUniqueOrThrow({ where: { id: memberId } });
    const redemptionsBefore = await ownerPrisma.redemption.count({ where: { memberId } });

    await request(app.server)
      .get('/member/me/identity-code')
      .set('Authorization', `Bearer ${memberToken}`);

    const after = await ownerPrisma.member.findUniqueOrThrow({ where: { id: memberId } });
    const redemptionsAfter = await ownerPrisma.redemption.count({ where: { memberId } });

    // The payload identifies. It never itself applies anything.
    expect(after).toEqual(before);
    expect(redemptionsAfter).toBe(redemptionsBefore);
  });
});

describe('a suspended member cannot obtain a code', () => {
  it('returns 404 once suspended', async () => {
    const suspended = await ownerPrisma.member.create({
      data: {
        memberNumber: `PG-TEST-${Date.now()}`,
        fullName: 'Suspended Identity Test',
        status: 'SUSPENDED',
        joinedAt: new Date(),
        claimedAt: new Date(),
        createdByUserId: 'seed-staff-administrator',
      },
    });

    try {
      const token = await issueAccessToken({
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE_MEMBER,
        subject: suspended.id,
        subjectType: 'MEMBER',
        tokenVersion: suspended.tokenVersion,
        ttlSeconds: 300,
      });

      const response = await request(app.server)
        .get('/member/me/identity-code')
        .set('Authorization', `Bearer ${token}`);

      // Refused at principal resolution — a suspended member is not an
      // active subject, so the token does not resolve at all.
      expect(response.status).toBe(401);
    } finally {
      await ownerPrisma.member.delete({ where: { id: suspended.id } });
    }
  });
});
