/**
 * The card-print export.
 *
 *   - an administrator gets a CSV, and the download is audited naming them
 *   - every card code in the file verifies back to the member on its own row
 *   - the file carries names, which is the one export that may
 *   - a non-administrator is refused
 *   - repeated exports are rate limited
 */
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { verifyIdentityCode } from '../src/security/identity-codes.js';
import { resetRateLimits } from '../src/security/rate-limit.js';
import { issueAccessToken } from '../src/security/tokens.js';
import {
  generateOutletLoginToken,
  hashOutletLoginToken,
} from '../src/security/outlet-login-token.js';

const ownerUrl = process.env['DATABASE_MIGRATION_URL'];
if (!ownerUrl) {
  throw new Error('DATABASE_MIGRATION_URL must be set to run card-export.test.ts.');
}

let app: FastifyInstance;
let env: Env;
let adminToken: string;
let outletToken: string;
let outletStaffId: string;
const ownerPrisma = new PrismaClient({ datasourceUrl: ownerUrl });

/** Members created only for this file, so the rows under test are exact. */
const fixtureMemberIds: string[] = [];
const fixturePrefix = `PG-CARD-${Date.now()}`;

/**
 * A name long enough to have needed the second line on the card, so the export
 * is exercised against the naming form this programme actually issues to rather
 * than against "Test User".
 */
const LONG_NAME = 'Sheikha Noora bint Hamad bin Khalifa Al-Thani Al Mahmoud';

/** A name that would break a naive CSV writer. */
const COMMA_NAME = 'Al-Thani, Noora "Nora"';

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
    role: 'ADMINISTRATOR',
    tokenVersion: admin.tokenVersion,
    ttlSeconds: 900,
  });

  const outlet = await ownerPrisma.outlet.findFirstOrThrow({
    where: { active: true },
    select: { id: true },
  });
  const outletStaff = await ownerPrisma.staffUser.create({
    data: {
      fullName: `Card export outlet fixture ${Date.now()}`,
      email: null,
      role: 'OUTLET_STAFF',
      outletId: outlet.id,
      authMethod: 'TOKEN',
      passwordHash: null,
      outletTokenHash: hashOutletLoginToken(generateOutletLoginToken()),
      outletTokenIssuedAt: new Date(),
    },
  });
  outletStaffId = outletStaff.id;

  // Cryptographically valid and backed by a real subject whose live database
  // role does not hold the permission. `resolvePrincipal` deliberately ignores
  // a forged role claim and reloads this row on every request.
  outletToken = await issueAccessToken({
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE_STAFF,
    subject: outletStaff.id,
    subjectType: 'STAFF',
    role: 'OUTLET_STAFF',
    tokenVersion: outletStaff.tokenVersion,
    ttlSeconds: 900,
  });

  for (const [i, fullName] of [LONG_NAME, COMMA_NAME].entries()) {
    const member = await ownerPrisma.member.create({
      data: {
        memberNumber: `${fixturePrefix}-${i}`,
        fullName,
        status: 'ACTIVE',
        joinedAt: new Date(),
        createdByUserId: admin.id,
      },
    });
    fixtureMemberIds.push(member.id);
  }
});

afterAll(async () => {
  if (fixtureMemberIds.length > 0) {
    await ownerPrisma.member.deleteMany({ where: { id: { in: fixtureMemberIds } } });
  }
  if (outletStaffId) {
    await ownerPrisma.staffUser.delete({ where: { id: outletStaffId } });
  }
  await ownerPrisma.$disconnect();
  await app.close();
});

/** U+FEFF, built from its code point so no literal BOM sits in this source. */
const BOM = String.fromCharCode(0xfeff);

/** `membership_number,full_name,card_code,status` per row, quotes stripped. */
function parseCsv(text: string): string[][] {
  return (text.startsWith(BOM) ? text.slice(BOM.length) : text)
    .trim()
    .split('\r\n')
    .map((line) => (line.match(/"(?:[^"]|"")*"/g) ?? []).map((c) => c.slice(1, -1).replace(/""/g, '"')));
}

describe('the card export is administrator-only, rate-limited and audited', () => {
  it('returns a CSV and audits the download naming the administrator', async () => {
    resetRateLimits();
    const admin = await ownerPrisma.staffUser.findUniqueOrThrow({
      where: { email: 'admin@pgp.test' },
    });

    const response = await request(app.server)
      .get('/admin/members/card-export')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/csv/);
    expect(response.headers['content-disposition']).toMatch(/attachment; filename=".*\.csv"/);

    const [header] = parseCsv(response.text);
    expect(header).toEqual(['membership_number', 'full_name', 'card_code', 'status']);

    const entry = await ownerPrisma.auditLog.findFirstOrThrow({
      where: { action: 'member.cards.exported' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(entry.actorId).toBe(admin.id);
  });

  /**
   * The guarantee the whole file exists for.
   *
   * A code that does not verify is a card that scans cleanly at the counter and
   * is then refused — after the batch has been manufactured. Checking the
   * printed value against the same verifier the outlet screen uses is the only
   * way to know before the print run rather than after it.
   */
  it('writes card codes that verify back to the member on their own row', async () => {
    resetRateLimits();
    const response = await request(app.server)
      .get('/admin/members/card-export')
      .set('Authorization', `Bearer ${adminToken}`);

    const [, ...rows] = parseCsv(response.text);
    const mine = rows.filter((row) => row[0]?.startsWith(fixturePrefix));
    expect(mine).toHaveLength(fixtureMemberIds.length);

    for (const row of mine) {
      const [memberNumber, , cardCode] = row;
      const result = verifyIdentityCode(cardCode ?? '', {
        windowHours: env.IDENTITY_CODE_WINDOW_HOURS,
      });

      expect(result.ok, `${memberNumber} exported an unverifiable code`).toBe(true);
      if (!result.ok) continue;

      // The static printed form, not the rotating one — ink cannot rotate.
      expect(result.form).toBe('card');

      const member = await ownerPrisma.member.findUniqueOrThrow({
        where: { id: result.memberRef },
      });
      expect(member.memberNumber).toBe(memberNumber);
    }
  });

  /**
   * The deliberate inverse of `reporting.test.ts`'s "never names".
   *
   * That rule is right for the redemption export and is not relaxed. This file
   * cannot obey it: a card export without names produces blank cards. Asserted
   * so the difference stays a decision on the record rather than an oversight
   * somebody later "fixes".
   */
  it('carries names, unlike the redemption export', async () => {
    resetRateLimits();
    const response = await request(app.server)
      .get('/admin/members/card-export')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.text).toContain(LONG_NAME);
  });

  it('quotes a name containing a comma and a quotation mark without shifting columns', async () => {
    resetRateLimits();
    const response = await request(app.server)
      .get('/admin/members/card-export')
      .set('Authorization', `Bearer ${adminToken}`);

    const [, ...rows] = parseCsv(response.text);
    const row = rows.find((r) => r[0] === `${fixturePrefix}-1`);

    // Four cells, not six: the comma inside the name must not become a column
    // break, or every field after it belongs to the wrong header.
    expect(row).toHaveLength(4);
    expect(row?.[1]).toBe(COMMA_NAME);
    expect(row?.[3]).toBe('ACTIVE');
  });

  it('narrows to a print batch with `since`', async () => {
    resetRateLimits();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const response = await request(app.server)
      .get(`/admin/members/card-export?since=${encodeURIComponent(future)}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    const [header, ...rows] = parseCsv(response.text);
    expect(header).toHaveLength(4);
    expect(rows).toHaveLength(0);
  });

  it('refuses a role that does not hold members:export-cards', async () => {
    resetRateLimits();
    const response = await request(app.server)
      .get('/admin/members/card-export')
      .set('Authorization', `Bearer ${outletToken}`);

    expect(response.status).toBe(403);
    expect(response.text).not.toContain(LONG_NAME);
  });

  it('refuses an unauthenticated request', async () => {
    resetRateLimits();
    const response = await request(app.server).get('/admin/members/card-export');

    expect(response.status).toBe(401);
  });

  it('rate-limits repeated exports', async () => {
    resetRateLimits();

    const statuses: number[] = [];
    for (let i = 0; i < env.RATE_LIMIT_EXPORT_PER_USER_MAX + 2; i += 1) {
      const response = await request(app.server)
        .get('/admin/members/card-export')
        .set('Authorization', `Bearer ${adminToken}`);
      statuses.push(response.status);
    }

    expect(statuses).toContain(429);
    resetRateLimits();
  });

  /**
   * The export shares a bucket key prefix with nothing else, so exhausting the
   * report export must not lock out a print run — they are different jobs done
   * by different people on different days.
   */
  it('does not share a rate limit bucket with the report export', async () => {
    resetRateLimits();

    for (let i = 0; i < env.RATE_LIMIT_EXPORT_PER_USER_MAX + 2; i += 1) {
      await request(app.server)
        .get('/admin/reports/export')
        .set('Authorization', `Bearer ${adminToken}`);
    }

    const response = await request(app.server)
      .get('/admin/members/card-export')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    resetRateLimits();
  });
});
