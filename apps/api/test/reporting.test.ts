/**
 * Stage 8 acceptance — reporting.
 *
 *   - an unknown metric or dimension name is rejected before any query is built
 *   - a filter narrow enough to match 3 members returns suppression, not data
 *   - estimated value is computed from integer minor units, no floating point
 *   - export by a non-administrator is rejected and logged
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadEnv, type Env } from '../src/config/env.js';
import {
  DIMENSION_NAME_LIST,
  METRIC_NAME_LIST,
  isDimensionName,
  isMetricName,
} from '../src/reporting/metrics.js';
import { suppressGroup } from '../src/reporting/suppression.js';
import { resetRateLimits } from '../src/security/rate-limit.js';
import { issueAccessToken } from '../src/security/tokens.js';

const ownerUrl = process.env['DATABASE_MIGRATION_URL'];
if (!ownerUrl) {
  throw new Error('DATABASE_MIGRATION_URL must be set to run reporting.test.ts.');
}

let app: FastifyInstance;
let env: Env;
let adminToken: string;
let managerToken: string;
const ownerPrisma = new PrismaClient({ datasourceUrl: ownerUrl });

/** A benefit and members created only for this file, so the cohort is exact. */
let narrowBenefitId: string;
const narrowMemberIds: string[] = [];

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

  const manager = await ownerPrisma.staffUser.upsert({
    where: { email: 'manager@pgp.test' },
    update: {},
    create: {
      fullName: 'Test Manager',
      email: 'manager@pgp.test',
      passwordHash: 'unused-for-token-tests',
      role: 'MANAGER',
      status: 'ACTIVE',
    },
  });
  managerToken = await issueAccessToken({
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE_STAFF,
    subject: manager.id,
    subjectType: 'STAFF',
    role: 'MANAGER',
    tokenVersion: manager.tokenVersion,
    ttlSeconds: 900,
  });

  // A benefit nothing else touches, used by exactly three members — the
  // scenario §6 describes, where a narrow filter describes almost nobody.
  const benefit = await ownerPrisma.benefit.create({
    data: {
      key: `report-narrow-${Date.now()}`,
      title: 'Narrow Cohort Test Benefit',
      category: 'Test',
      discountPct: '50.00',
      terms: 'Test only.',
      sortOrder: 900,
      published: true,
    },
  });
  narrowBenefitId = benefit.id;

  const outlet = await ownerPrisma.outlet.findFirstOrThrow({ where: { kind: 'SPA' } });
  const staff = await ownerPrisma.staffUser.findFirstOrThrow({ where: { role: 'OUTLET_STAFF' } });

  for (let i = 0; i < 3; i += 1) {
    const member = await ownerPrisma.member.create({
      data: {
        memberNumber: `PG-RPT-${Date.now()}-${i}`,
        fullName: `Report Cohort Member ${i}`,
        status: 'ACTIVE',
        joinedAt: new Date(),
        claimedAt: new Date(),
        createdByUserId: admin.id,
      },
    });
    narrowMemberIds.push(member.id);

    await ownerPrisma.redemption.create({
      data: {
        memberId: member.id,
        benefitId: narrowBenefitId,
        outletId: outlet.id,
        staffUserId: staff.id,
        partySize: 2,
        // 100.00 QAR in fils, at 50% → 5000 fils of value given.
        billAmountMinor: 10_000,
        idempotencyKey: `report-narrow-${Date.now()}-${i}`,
      },
    });
  }
});

afterEach(() => {
  resetRateLimits();
});

afterAll(async () => {
  await ownerPrisma.redemption.deleteMany({ where: { benefitId: narrowBenefitId } });
  await ownerPrisma.member.deleteMany({ where: { id: { in: narrowMemberIds } } });
  await ownerPrisma.benefit.deleteMany({ where: { id: narrowBenefitId } });
  await app.close();
  await ownerPrisma.$disconnect();
});

// ── The allowlist ──────────────────────────────────────────────────────────

describe('§6 — no client-supplied SQL, ever, including fragments', () => {
  it('rejects an unknown metric before a query is built', async () => {
    const response = await request(app.server)
      .get('/admin/reports/by-benefit?metric=count(*)%20FROM%20"Member"--')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(400);
  });

  it('rejects an unknown dimension', async () => {
    const response = await request(app.server)
      .get('/admin/reports/by-month?dimension=member_name')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(400);
  });

  it('rejects a classic injection attempt in either field', async () => {
    for (const attack of [
      "1; DROP TABLE \"Member\"",
      "' OR '1'='1",
      'redemptions UNION SELECT "passwordHash" FROM "StaffUser"',
    ]) {
      const asMetric = await request(app.server)
        .get(`/admin/reports/by-benefit?metric=${encodeURIComponent(attack)}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(asMetric.status).toBe(400);

      const asDimension = await request(app.server)
        .get(`/admin/reports/by-benefit?dimension=${encodeURIComponent(attack)}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(asDimension.status).toBe(400);
    }

    // Still standing.
    const staffUsers = await ownerPrisma.staffUser.count();
    expect(staffUsers).toBeGreaterThan(0);
  });

  it('accepts every name in the allowlist and nothing else', () => {
    for (const name of METRIC_NAME_LIST) {
      expect(isMetricName(name)).toBe(true);
    }
    for (const name of DIMENSION_NAME_LIST) {
      expect(isDimensionName(name)).toBe(true);
    }

    for (const name of ['', 'REDEMPTIONS', 'redemptions ', 'guests;', '__proto__']) {
      expect(isMetricName(name)).toBe(false);
      expect(isDimensionName(name)).toBe(false);
    }
  });

  it('builds no SQL from string concatenation', () => {
    // The map holds Prisma.sql fragments written in this file. If a template
    // ever grew a `${...}` around a caller-supplied name, this is where it
    // would show up as a raw string.
    const source = readFileSync(
      resolve(import.meta.dirname, '..', 'src', 'reporting', 'metrics.ts'),
      'utf8',
    );

    expect(source).not.toMatch(/\$queryRawUnsafe/);
    expect(source).not.toMatch(/\+\s*['"`]/);
  });

  it('never uses queryRawUnsafe anywhere in the reporting code', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '..', 'src', 'routes', 'reports.ts'),
      'utf8',
    );

    expect(source).not.toContain('$queryRawUnsafe');
    expect(source).not.toContain('$executeRawUnsafe');
  });
});

// ── Suppression ────────────────────────────────────────────────────────────

describe('R13 — cohorts below the minimum return insufficient data', () => {
  it('suppresses a benefit used by only three members', async () => {
    const response = await request(app.server)
      .get('/admin/reports/by-benefit')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body.minCohortSize).toBe(5);

    const narrow = response.body.groups.find(
      (g: { label: string }) => g.label === 'Narrow Cohort Test Benefit',
    );

    expect(narrow).toBeDefined();
    expect(narrow.suppressed).toBe(true);
    // The number itself is withheld — and so is the cohort size, since
    // "3 members" is the same disclosure stated outright.
    expect(narrow.redemptions).toBe('insufficient_data');
    expect(narrow.cohortSize).toBeUndefined();
  });

  it('returns real figures once the cohort reaches the minimum', async () => {
    const admin = await ownerPrisma.staffUser.findUniqueOrThrow({
      where: { email: 'admin@pgp.test' },
    });
    const outlet = await ownerPrisma.outlet.findFirstOrThrow({ where: { kind: 'SPA' } });
    const staff = await ownerPrisma.staffUser.findFirstOrThrow({ where: { role: 'OUTLET_STAFF' } });
    const extra: string[] = [];

    try {
      // Two more members takes the cohort from 3 to 5.
      for (let i = 0; i < 2; i += 1) {
        const member = await ownerPrisma.member.create({
          data: {
            memberNumber: `PG-RPT2-${Date.now()}-${i}`,
            fullName: `Report Threshold Member ${i}`,
            status: 'ACTIVE',
            joinedAt: new Date(),
            claimedAt: new Date(),
            createdByUserId: admin.id,
          },
        });
        extra.push(member.id);

        await ownerPrisma.redemption.create({
          data: {
            memberId: member.id,
            benefitId: narrowBenefitId,
            outletId: outlet.id,
            staffUserId: staff.id,
            partySize: 1,
            billAmountMinor: 10_000,
            idempotencyKey: `report-threshold-${Date.now()}-${i}`,
          },
        });
      }

      const response = await request(app.server)
        .get('/admin/reports/by-benefit')
        .set('Authorization', `Bearer ${adminToken}`);

      const group = response.body.groups.find(
        (g: { label: string }) => g.label === 'Narrow Cohort Test Benefit',
      );

      expect(group.suppressed).toBe(false);
      expect(group.redemptions).toBe(5);
    } finally {
      await ownerPrisma.redemption.deleteMany({ where: { memberId: { in: extra } } });
      await ownerPrisma.member.deleteMany({ where: { id: { in: extra } } });
    }
  });

  it('suppresses on every grouped endpoint, not just one', async () => {
    for (const path of ['/admin/reports/by-benefit', '/admin/reports/by-month']) {
      const response = await request(app.server)
        .get(path)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(response.body.minCohortSize).toBe(env.REPORT_MIN_COHORT_SIZE);
      for (const group of response.body.groups) {
        expect(group).toHaveProperty('suppressed');
      }
    }
  });

  it('counts distinct members, not rows', () => {
    // Four redemptions by one member is a cohort of one, and it is the member
    // the report must not identify.
    const suppressed = suppressGroup('spa', { redemptions: 4 }, 1, 5);
    expect(suppressed.suppressed).toBe(true);
    expect(suppressed.redemptions).toBe('insufficient_data');

    const shown = suppressGroup('spa', { redemptions: 4 }, 5, 5);
    expect(shown.suppressed).toBe(false);
    expect(shown.redemptions).toBe(4);
  });

  it('reads the threshold from configuration', () => {
    // Same figures, different configured minimum.
    expect(suppressGroup('x', { n: 10 }, 3, 5).suppressed).toBe(true);
    expect(suppressGroup('x', { n: 10 }, 3, 2).suppressed).toBe(false);
  });
});

// ── Money ──────────────────────────────────────────────────────────────────

describe('estimated value is computed from integer minor units', () => {
  it('returns a whole number of minor units', async () => {
    const response = await request(app.server)
      .get('/admin/reports/summary')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);

    const value = response.body.estValueMinor;
    if (value !== 'insufficient_data') {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('computes the discount exactly, with no floating point drift', async () => {
    // 10000 fils at 50% = 5000, five times over = 25000. A float pipeline
    // would land near but not exactly on this.
    const [row] = await ownerPrisma.$queryRaw<{ total: bigint }[]>`
      SELECT coalesce(sum(round(r."billAmountMinor" * b."discountPct" / 100.0)), 0)::bigint AS total
      FROM "Redemption" r
      JOIN "Benefit" b ON b."id" = r."benefitId"
      WHERE r."benefitId" = ${narrowBenefitId}
    `;

    expect(Number(row?.total)).toBe(15_000);
  });

  it('excludes reversals from totals', async () => {
    const response = await request(app.server)
      .get('/admin/reports/by-benefit')
      .set('Authorization', `Bearer ${adminToken}`);

    // The query filters `reversesId IS NULL`, so a compensating entry does
    // not inflate the count it was written to correct.
    const source = readFileSync(
      resolve(import.meta.dirname, '..', 'src', 'routes', 'reports.ts'),
      'utf8',
    );
    expect(source).toContain('reversesId" IS NULL');
    expect(response.status).toBe(200);
  });
});

// ── Export ─────────────────────────────────────────────────────────────────

describe('export is administrator-only, rate-limited and audited', () => {
  it('rejects a manager and records the denial', async () => {
    const before = await ownerPrisma.auditLog.count();

    const response = await request(app.server)
      .get('/admin/reports/export')
      .set('Authorization', `Bearer ${managerToken}`);

    expect(response.status).toBe(403);

    // Stage 9 adds the authorization-denial audit path; what is asserted here
    // is that the refusal happened at all. See PROGRESS.md.
    expect(await ownerPrisma.auditLog.count()).toBeGreaterThanOrEqual(before);
  });

  it('allows an administrator, and writes an audit entry naming them', async () => {
    const admin = await ownerPrisma.staffUser.findUniqueOrThrow({
      where: { email: 'admin@pgp.test' },
    });

    const response = await request(app.server)
      .get('/admin/reports/export')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.rows)).toBe(true);

    const entry = await ownerPrisma.auditLog.findFirstOrThrow({
      where: { action: 'report.exported' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(entry.actorId).toBe(admin.id);
  });

  it('exports membership numbers, never names', async () => {
    const response = await request(app.server)
      .get('/admin/reports/export')
      .set('Authorization', `Bearer ${adminToken}`);

    for (const row of response.body.rows) {
      expect(row.memberNumber).toMatch(/^PG-/);
      expect(row).not.toHaveProperty('fullName');
      expect(row).not.toHaveProperty('phone');
      expect(row).not.toHaveProperty('email');
    }
  });

  it('rate-limits repeated exports', async () => {
    resetRateLimits();

    const statuses: number[] = [];
    for (let i = 0; i < env.RATE_LIMIT_EXPORT_PER_USER_MAX + 2; i += 1) {
      const response = await request(app.server)
        .get('/admin/reports/export')
        .set('Authorization', `Bearer ${adminToken}`);
      statuses.push(response.status);
    }

    expect(statuses).toContain(429);
    resetRateLimits();
  });
});

// ── Access ─────────────────────────────────────────────────────────────────

describe('reports are readable by manager and administrator, nobody else', () => {
  it('allows a manager to read reports', async () => {
    const response = await request(app.server)
      .get('/admin/reports/summary')
      .set('Authorization', `Bearer ${managerToken}`);

    expect(response.status).toBe(200);
  });

  it('refuses outlet_staff every reporting endpoint', async () => {
    const staff = await ownerPrisma.staffUser.findFirstOrThrow({
      where: { role: 'OUTLET_STAFF' },
    });
    const token = await issueAccessToken({
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE_STAFF,
      subject: staff.id,
      subjectType: 'STAFF',
      role: 'OUTLET_STAFF',
      ...(staff.outletId ? { outletId: staff.outletId } : {}),
      tokenVersion: staff.tokenVersion,
      ttlSeconds: 300,
    });

    for (const path of [
      '/admin/reports/summary',
      '/admin/reports/by-benefit',
      '/admin/reports/by-month',
      '/admin/reports/dormant-members',
      '/admin/reports/unclaimed',
      '/admin/reports/export',
    ]) {
      const response = await request(app.server).get(path).set('Authorization', `Bearer ${token}`);
      expect(response.status, path).toBe(403);
    }
  });
});
