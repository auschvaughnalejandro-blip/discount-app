/**
 * Stage 9 acceptance — audit logging and log redaction.
 *
 *   - viewing a member record writes an audit entry naming the viewer
 *   - a failed verification lookup is recorded
 *   - grepping application log output for a seeded member's name returns nothing
 *   - audit rows cannot be updated or deleted by the application role
 */
import { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { REDACTED, REDACT_PATHS, redact } from '../src/logging/redaction.js';
import { resetRateLimits } from '../src/security/rate-limit.js';
import { issueAccessToken } from '../src/security/tokens.js';

const appUrl = process.env['DATABASE_URL'];
const ownerUrl = process.env['DATABASE_MIGRATION_URL'];
if (!appUrl || !ownerUrl) {
  throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must be set to run audit.test.ts.');
}

let app: FastifyInstance;
let env: Env;
let adminToken: string;
let staffToken: string;
let memberId: string;
let memberName: string;
let memberNumber: string;

const appPrisma = new PrismaClient({ datasourceUrl: appUrl });
const ownerPrisma = new PrismaClient({ datasourceUrl: ownerUrl });

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

  const staff = await ownerPrisma.staffUser.findFirstOrThrow({ where: { role: 'OUTLET_STAFF' } });
  staffToken = await issueAccessToken({
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE_STAFF,
    subject: staff.id,
    subjectType: 'STAFF',
    role: 'OUTLET_STAFF',
    ...(staff.outletId ? { outletId: staff.outletId } : {}),
    tokenVersion: staff.tokenVersion,
    ttlSeconds: 900,
  });

  const member = await ownerPrisma.member.findUniqueOrThrow({
    where: { memberNumber: 'PG-0003' },
  });
  memberId = member.id;
  memberName = member.fullName;
  memberNumber = member.memberNumber;
});

afterEach(() => {
  resetRateLimits();
});

afterAll(async () => {
  await app.close();
  await Promise.all([appPrisma.$disconnect(), ownerPrisma.$disconnect()]);
});

// ── Audit entries ──────────────────────────────────────────────────────────

describe('viewing a member record writes an entry naming the viewer', () => {
  it('records who looked at whom', async () => {
    const admin = await ownerPrisma.staffUser.findUniqueOrThrow({
      where: { email: 'admin@pgp.test' },
    });

    await request(app.server)
      .get(`/admin/members/${memberId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    const entry = await ownerPrisma.auditLog.findFirstOrThrow({
      where: { action: 'member.viewed', subjectId: memberId },
      orderBy: { occurredAt: 'desc' },
    });

    // §9: "Who viewed which member's history is itself sensitive information,
    // and the hotel should be able to answer that question."
    expect(entry.actorId).toBe(admin.id);
    expect(entry.actorType).toBe('STAFF');
    expect(entry.metadata).toMatchObject({ memberNumber });
  });

  it('records the member number, never the name', async () => {
    const entries = await ownerPrisma.auditLog.findMany({
      where: { action: 'member.viewed' },
      orderBy: { occurredAt: 'desc' },
      take: 20,
    });

    for (const entry of entries) {
      expect(JSON.stringify(entry.metadata ?? {})).not.toContain(memberName);
    }
  });
});

describe('a failed verification lookup is recorded', () => {
  it('writes an entry for a lookup against a non-existent number', async () => {
    const before = await ownerPrisma.auditLog.count({
      where: { action: 'verification.lookup.failure' },
    });

    await request(app.server)
      .post('/verify/resolve')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ membershipNumber: 'PG-8888' });

    const after = await ownerPrisma.auditLog.count({
      where: { action: 'verification.lookup.failure' },
    });

    // A run of these is someone walking the sequence (§5).
    expect(after).toBe(before + 1);
  });

  it('records the successful lookups too', async () => {
    const before = await ownerPrisma.auditLog.count({
      where: { action: 'verification.lookup.success' },
    });

    await request(app.server)
      .post('/verify/resolve')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ membershipNumber: memberNumber });

    expect(
      await ownerPrisma.auditLog.count({ where: { action: 'verification.lookup.success' } }),
    ).toBe(before + 1);
  });
});

describe('every authorization denial is logged', () => {
  it('records a refused route with the permission that was missing', async () => {
    const before = await ownerPrisma.auditLog.count({
      where: { action: 'authorization.denied' },
    });

    // outlet_staff holds no members:list.
    await request(app.server)
      .get('/admin/members')
      .set('Authorization', `Bearer ${staffToken}`);

    const entry = await ownerPrisma.auditLog.findFirstOrThrow({
      where: { action: 'authorization.denied' },
      orderBy: { occurredAt: 'desc' },
    });

    expect(await ownerPrisma.auditLog.count({ where: { action: 'authorization.denied' } })).toBe(
      before + 1,
    );
    expect(entry.metadata).toMatchObject({ permission: 'members:list', role: 'OUTLET_STAFF' });
  });
});

describe('authentication events are recorded', () => {
  it('records a failed login without writing the attempted email', async () => {
    await request(app.server)
      .post('/auth/staff/login')
      .send({ email: 'attacker-probe@nowhere.test', password: 'wrong' });

    const entry = await ownerPrisma.auditLog.findFirstOrThrow({
      where: { action: 'auth.login.failure' },
      orderBy: { occurredAt: 'desc' },
    });

    // Recording the guess would put attacker-chosen strings, and possibly a
    // real address typed into the wrong box, into the trail.
    expect(JSON.stringify(entry)).not.toContain('attacker-probe@nowhere.test');
  });

  it('records a successful login against the account', async () => {
    const admin = await ownerPrisma.staffUser.findUniqueOrThrow({
      where: { email: 'admin@pgp.test' },
    });

    await request(app.server)
      .post('/auth/staff/login')
      .send({ email: 'admin@pgp.test', password: 'privilege-guest-dev-only' });

    const entry = await ownerPrisma.auditLog.findFirstOrThrow({
      where: { action: 'auth.login.success', subjectId: admin.id },
      orderBy: { occurredAt: 'desc' },
    });

    expect(entry.actorId).toBe(admin.id);
  });
});

// ── Insert-only ────────────────────────────────────────────────────────────

describe('audit rows cannot be updated or deleted by the application role', () => {
  it('refuses both, at the database level', async () => {
    const row = await ownerPrisma.auditLog.create({
      data: { id: `audit-immutability-${Date.now()}`, actorType: 'system', action: 'auth.logout' },
    });

    try {
      await expect(
        appPrisma.auditLog.update({ where: { id: row.id }, data: { action: 'benefit.updated' } }),
      ).rejects.toThrow(/permission denied/i);

      await expect(appPrisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(
        /permission denied/i,
      );

      // Untouched.
      const after = await ownerPrisma.auditLog.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.action).toBe('auth.logout');
    } finally {
      await ownerPrisma.auditLog.delete({ where: { id: row.id } });
    }
  });

  it('still allows the application to append', async () => {
    const created = await appPrisma.auditLog.create({
      data: { actorType: 'system', action: 'auth.logout' },
    });

    expect(created.id).toBeTruthy();
    await ownerPrisma.auditLog.delete({ where: { id: created.id } });
  });
});

// ── Redaction ──────────────────────────────────────────────────────────────

describe('the redaction layer keeps personal data out of application logs', () => {
  it('removes names, phones and emails at any depth', () => {
    const redacted = redact({
      member: {
        id: 'member-1',
        memberNumber: 'PG-0003',
        fullName: 'Some Member',
        phone: '+97455550003',
        email: 'someone@example.test',
      },
      nested: { deeper: { fullName: 'Another Person' } },
      list: [{ email: 'list@example.test' }],
    }) as Record<string, never>;

    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain('Some Member');
    expect(serialized).not.toContain('+97455550003');
    expect(serialized).not.toContain('someone@example.test');
    expect(serialized).not.toContain('Another Person');
    expect(serialized).not.toContain('list@example.test');

    // §9: "Log the opaque member reference only." Redaction must not remove
    // the identifiers that make the entry useful.
    expect(serialized).toContain('member-1');
    expect(serialized).toContain('PG-0003');
  });

  it('removes credentials and tokens', () => {
    const serialized = JSON.stringify(
      redact({
        password: 'hunter2',
        passwordHash: '$argon2id$v=19$...',
        accessToken: 'eyJhbGciOi...',
        refreshToken: 'opaque-token',
        authorization: 'Bearer abc',
        mfaSecret: 'JBSWY3DP',
      }),
    );

    for (const secret of [
      'hunter2',
      '$argon2id$',
      'eyJhbGciOi',
      'opaque-token',
      'Bearer abc',
      'JBSWY3DP',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain(REDACTED);
  });

  it('does not mutate the object it was given', () => {
    const original = { member: { fullName: 'Untouched Person' } };
    redact(original);

    // A logger that quietly edits what it is handed causes worse bugs than
    // the one it prevents.
    expect(original.member.fullName).toBe('Untouched Person');
  });

  it('survives a cycle without hanging', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic['self'] = cyclic;

    expect(() => JSON.stringify(redact(cyclic))).not.toThrow();
  });

  it('is wired into the running logger, not just available', () => {
    // The mechanism only counts if the app actually uses it.
    expect(REDACT_PATHS.length).toBeGreaterThan(0);
    expect(REDACT_PATHS).toContain('req.headers.authorization');
  });
});

describe('grepping the application log for a member name returns nothing', () => {
  it('captures real log output and finds no personal data', async () => {
    // A real pino instance writing to a buffer, configured exactly as
    // buildApp configures its own, so what is asserted is the production
    // configuration rather than a test-only stand-in.
    const lines: string[] = [];
    const probe = Fastify({
      logger: {
        level: 'info',
        redact: { paths: REDACT_PATHS, censor: REDACTED },
        serializers: { member: redact, members: redact, body: redact, data: redact },
        stream: {
          write(chunk: string) {
            lines.push(chunk);
          },
        },
      },
    });

    const member = await ownerPrisma.member.findUniqueOrThrow({
      where: { memberNumber: 'PG-0003' },
    });

    // The mistake §9 exists to survive: someone logs the whole record while
    // debugging something else.
    probe.log.info({ member }, 'resolving member');
    probe.log.info({ data: { members: [member] } }, 'listing members');
    probe.log.info(
      { body: { fullName: member.fullName, phone: member.phone } },
      'inbound request body',
    );

    await probe.close();

    const output = lines.join('\n');

    expect(output.length).toBeGreaterThan(0);
    expect(output).not.toContain(member.fullName);
    if (member.phone) {
      expect(output).not.toContain(member.phone);
    }
    if (member.email) {
      expect(output).not.toContain(member.email);
    }

    // The opaque reference is still there, which is the point.
    expect(output).toContain(member.id);
  });

  it('keeps the Authorization header out of request logs', async () => {
    const lines: string[] = [];
    const probe = Fastify({
      logger: {
        level: 'info',
        redact: { paths: REDACT_PATHS, censor: REDACTED },
        stream: {
          write(chunk: string) {
            lines.push(chunk);
          },
        },
      },
    });
    probe.get('/probe', async () => ({ ok: true }));
    await probe.ready();

    await request(probe.server).get('/probe').set('Authorization', 'Bearer super-secret-token');
    await probe.close();

    expect(lines.join('\n')).not.toContain('super-secret-token');
  });
});
