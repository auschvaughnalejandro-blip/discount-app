/**
 * Stage 5 acceptance — benefits.
 *
 * The headline: changing the dining discount from 25% to 20% via PATCH must
 * change what members see, with zero code changes. R14 is the acceptance test
 * for the whole project.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { issueAccessToken } from '../src/security/tokens.js';

const ownerUrl = process.env['DATABASE_MIGRATION_URL'];
if (!ownerUrl) {
  throw new Error('DATABASE_MIGRATION_URL must be set to run benefits.test.ts.');
}

let app: FastifyInstance;
let env: Env;
let adminToken: string;
let managerToken: string;
let memberToken: string;
const ownerPrisma = new PrismaClient({ datasourceUrl: ownerUrl });

/** Restored after each mutation test so the seed stays the source of truth. */
let originalDiningPct: string;

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

  // A manager token signed for the administrator's account would be resolved
  // against the stored role, so a real manager account is needed to test the
  // manager restriction honestly.
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

  const member = await ownerPrisma.member.findUniqueOrThrow({
    where: { memberNumber: 'PG-0003' },
  });
  memberToken = await issueAccessToken({
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE_MEMBER,
    subject: member.id,
    subjectType: 'MEMBER',
    tokenVersion: member.tokenVersion,
    ttlSeconds: 900,
  });

  const dining = await ownerPrisma.benefit.findUniqueOrThrow({ where: { key: 'fnb' } });
  originalDiningPct = String(dining.discountPct);
});

afterAll(async () => {
  await ownerPrisma.benefit.update({
    where: { key: 'fnb' },
    data: { discountPct: originalDiningPct, published: true },
  });
  await ownerPrisma.benefit.deleteMany({ where: { key: { startsWith: 'test-' } } });
  await app.close();
  await ownerPrisma.$disconnect();
});

// ── The headline ───────────────────────────────────────────────────────────

describe('R14 — changing a discount is a database update, not a code change', () => {
  it('changes what members see when an administrator PATCHes 25% to 20%', async () => {
    // What the member sees now.
    const before = await request(app.server)
      .get('/benefits')
      .set('Authorization', `Bearer ${memberToken}`);

    expect(before.status).toBe(200);
    const diningBefore = before.body.benefits.find((b: { key: string }) => b.key === 'fnb');
    expect(diningBefore.discountPct).toBe('25');

    const dining = await ownerPrisma.benefit.findUniqueOrThrow({ where: { key: 'fnb' } });

    // The change. One HTTP call, no deployment, no restart.
    const patched = await request(app.server)
      .patch(`/admin/benefits/${dining.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ discountPct: '20.00' });

    expect(patched.status).toBe(200);

    // What the member sees now — same running process, no restart between.
    const after = await request(app.server)
      .get('/benefits')
      .set('Authorization', `Bearer ${memberToken}`);

    const diningAfter = after.body.benefits.find((b: { key: string }) => b.key === 'fnb');
    expect(diningAfter.discountPct).toBe('20');

    // Put it back.
    await request(app.server)
      .patch(`/admin/benefits/${dining.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ discountPct: originalDiningPct });

    const restored = await request(app.server)
      .get('/benefits')
      .set('Authorization', `Bearer ${memberToken}`);
    expect(
      restored.body.benefits.find((b: { key: string }) => b.key === 'fnb').discountPct,
    ).toBe('25');
  });

  it('carries the guest caps and reservation numbers as data too', async () => {
    const response = await request(app.server)
      .get('/benefits')
      .set('Authorization', `Bearer ${memberToken}`);

    const byKey = Object.fromEntries(
      response.body.benefits.map((b: { key: string }) => [b.key, b]),
    );

    expect(byKey['fnb'].maxGuests).toBe(6);
    expect(byKey['fnb'].reservationPhone).toBe('4020 1720');
    expect(byKey['fnb'].childRules).toEqual({ '6-12': 50, '0-6': 100 });
    expect(byKey['spa'].maxGuests).toBe(2);
    expect(byKey['events'].minGuests).toBe(20);
  });
});

// ── No literals in application code ────────────────────────────────────────

const SRC_DIR = resolve(import.meta.dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return sourceFiles(full);
    }
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('no benefit value appears as a literal in application code', () => {
  /**
   * The values from the printed benefits sheet. If any of these can be found
   * in src/, then a change through the dashboard would not be the only place
   * the number lives — and R14 is broken however well the endpoint works.
   *
   * prisma/seed.ts is deliberately not scanned: it is data, and it is the one
   * place these values are allowed to appear.
   */
  const FORBIDDEN = [
    '4020 1720',
    '4020 1666',
    '4020 1625',
    'F&B Outlets',
    'Rooms & Suites',
    'Meetings & Events',
    'Lifestyle & SPG',
    'published bar rates',
    'Retail products',
    'Outside catering',
    'Pool day pass',
  ];

  it.each(FORBIDDEN)('does not contain %s anywhere in src/', (needle) => {
    const offenders = sourceFiles(SRC_DIR).filter((file) =>
      readFileSync(file, 'utf8').includes(needle),
    );

    expect(offenders, `${needle} found in: ${offenders.join(', ')}`).toEqual([]);
  });

  it('does not hardcode a benefit key alongside a percentage', () => {
    // Catches the "just for now" shortcut: a lookup table of key -> discount
    // sitting next to the code that should be reading the database.
    const pattern = /(fnb|rooms|spa|events|lifestyle)\W{0,6}\b(20|25|30|40|50|100)\b/i;

    const offenders = sourceFiles(SRC_DIR).filter((file) =>
      pattern.test(readFileSync(file, 'utf8')),
    );

    expect(offenders).toEqual([]);
  });
});

// ── Publication ────────────────────────────────────────────────────────────

describe('unpublished benefits are invisible to members', () => {
  it('hides an unpublished benefit from the member endpoint but not from admin', async () => {
    const created = await request(app.server)
      .post('/admin/benefits')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        key: 'test-unpublished',
        title: 'Draft Benefit',
        category: 'Test',
        discountPct: '15.00',
        secondaryLabel: null,
        secondaryPct: null,
        childRules: null,
        maxGuests: null,
        minGuests: null,
        reservationPhone: null,
        terms: 'Not yet live.',
        sortOrder: 99,
        published: false,
      });

    expect(created.status).toBe(201);

    const memberView = await request(app.server)
      .get('/benefits')
      .set('Authorization', `Bearer ${memberToken}`);
    expect(
      memberView.body.benefits.some((b: { key: string }) => b.key === 'test-unpublished'),
    ).toBe(false);

    const adminView = await request(app.server)
      .get('/admin/benefits')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(
      adminView.body.benefits.some((b: { key: string }) => b.key === 'test-unpublished'),
    ).toBe(true);

    // Publishing makes it visible, with no restart.
    const published = await request(app.server)
      .post(`/admin/benefits/${created.body.id}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ published: true });
    expect(published.status).toBe(200);

    const afterPublish = await request(app.server)
      .get('/benefits')
      .set('Authorization', `Bearer ${memberToken}`);
    expect(
      afterPublish.body.benefits.some((b: { key: string }) => b.key === 'test-unpublished'),
    ).toBe(true);
  });
});

// ── Versioning and attribution ─────────────────────────────────────────────

describe('every change is versioned and attributed', () => {
  it('increments the version and records who made the change', async () => {
    const dining = await ownerPrisma.benefit.findUniqueOrThrow({ where: { key: 'fnb' } });
    const versionBefore = dining.version;

    await request(app.server)
      .patch(`/admin/benefits/${dining.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ terms: `Updated at ${new Date().toISOString()}` });

    const after = await ownerPrisma.benefit.findUniqueOrThrow({ where: { key: 'fnb' } });
    const admin = await ownerPrisma.staffUser.findUniqueOrThrow({
      where: { email: 'admin@pgp.test' },
    });

    expect(after.version).toBe(versionBefore + 1);
    expect(after.updatedByUserId).toBe(admin.id);
  });

  it('writes an audit entry naming the user', async () => {
    const dining = await ownerPrisma.benefit.findUniqueOrThrow({ where: { key: 'fnb' } });
    const admin = await ownerPrisma.staffUser.findUniqueOrThrow({
      where: { email: 'admin@pgp.test' },
    });

    await request(app.server)
      .patch(`/admin/benefits/${dining.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ discountPct: '22.00' });

    const entry = await ownerPrisma.auditLog.findFirstOrThrow({
      where: { action: 'benefit.updated', subjectId: dining.id },
      orderBy: { occurredAt: 'desc' },
    });

    expect(entry.actorId).toBe(admin.id);
    expect(entry.actorType).toBe('STAFF');
    // The before and after of the value most likely to be disputed.
    expect(entry.metadata).toMatchObject({ discountPctTo: '22.00' });

    await request(app.server)
      .patch(`/admin/benefits/${dining.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ discountPct: originalDiningPct });
  });
});

// ── Authorization ──────────────────────────────────────────────────────────

describe('benefit editing is administrator-only', () => {
  it('refuses a manager, who may read but not edit', async () => {
    const dining = await ownerPrisma.benefit.findUniqueOrThrow({ where: { key: 'fnb' } });

    const read = await request(app.server)
      .get('/admin/benefits')
      .set('Authorization', `Bearer ${managerToken}`);
    expect(read.status).toBe(200);

    const write = await request(app.server)
      .patch(`/admin/benefits/${dining.id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ discountPct: '5.00' });
    expect(write.status).toBe(403);

    const publish = await request(app.server)
      .post(`/admin/benefits/${dining.id}/publish`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ published: false });
    expect(publish.status).toBe(403);
  });

  it('refuses an unauthenticated request to the member endpoint', async () => {
    const response = await request(app.server).get('/benefits');
    expect(response.status).toBe(401);
  });
});
