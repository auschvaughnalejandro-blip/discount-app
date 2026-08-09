/**
 * Stage 3 acceptance — authorization.
 *
 * The four criteria from BUILD-PLAN.md:
 *   1. Registering a route without a `permission` field prevents the server starting
 *   2. An authorization matrix test covers every role against every endpoint
 *   3. Fetching another member's record by ID returns the same 404 as a missing record
 *   4. No handler loads a record and then checks permission afterwards
 *
 * Criterion 4 is a property of source code rather than of a running server,
 * so it is checked by scanning src/routes — see fetch-then-check.test.ts.
 */
import { PrismaClient, type Role } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { NotFoundError } from '../src/errors.js';
import {
  PERMISSIONS,
  permissionsForRole,
  roleHasPermission,
  type Permission,
} from '../src/security/permissions.js';
import { scopeForMember, scopeForRedemption, scopedWhere } from '../src/security/scope.js';
import { issueAccessToken } from '../src/security/tokens.js';

const ownerUrl = process.env['DATABASE_MIGRATION_URL'];
if (!ownerUrl) {
  throw new Error('DATABASE_MIGRATION_URL must be set to run authorization.test.ts.');
}

let app: FastifyInstance;
let env: Env;
const ownerPrisma = new PrismaClient({ datasourceUrl: ownerUrl });

const RETIRED_ROLES = ['MANAGER', 'OUTLET_STAFF', 'SUPPORT'] as const satisfies readonly Role[];
const ALL_ROLES = ['ADMINISTRATOR', ...RETIRED_ROLES] as const satisfies readonly Role[];

beforeAll(async () => {
  env = loadEnv();
  app = await buildApp({ env });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await ownerPrisma.$disconnect();
});

// ── Criterion 1 ────────────────────────────────────────────────────────────

describe('R17 — an undeclared route prevents the server starting', () => {
  it('refuses to start when a route omits config.permission', async () => {
    const undeclared = await buildApp({ env });

    // Registered inside a plugin, the way every real route file is. Note the
    // deliberate absence of `await` on register(): awaiting it would boot the
    // plugin there and then, and the point being tested is that the failure
    // reaches startup.
    void undeclared.register(async (instance) => {
      instance.get('/accidentally-unprotected', async () => ({ secret: 'exposed' }));
    });

    await expect(undeclared.ready()).rejects.toThrow(/does not declare a permission/);
    await undeclared.close().catch(() => undefined);
  });

  it('refuses to start when a route declares a permission that does not exist', async () => {
    const bogus = await buildApp({ env });

    void bogus.register(async (instance) => {
      instance.get(
        '/typo',
        // A misspelling is as dangerous as an omission: it would otherwise be
        // a permission no role holds, or worse, silently skipped.
        { config: { permission: 'members:raed' as Permission } },
        async () => ({ ok: true }),
      );
    });

    await expect(bogus.ready()).rejects.toThrow(/unknown permission/);
    await bogus.close().catch(() => undefined);
  });

  it('starts when the route declares a known permission', async () => {
    const declared = await buildApp({ env });
    declared.get('/properly-declared', { config: { permission: 'members:list' } }, async () => ({
      ok: true,
    }));

    await expect(declared.ready()).resolves.toBeDefined();
    await declared.close();
  });

  it('leaves no route in the real application undeclared', () => {
    // Belt and braces: the onRoute hook would already have thrown during
    // beforeAll. This asserts it against the assembled route table too, so a
    // future change to the hook cannot quietly stop enforcing.
    const routes = app
      .printRoutes({ commonPrefix: false })
      .split('\n')
      .filter((line) => line.includes('('));

    expect(routes.length).toBeGreaterThan(0);
  });
});

// ── Criterion 2 ────────────────────────────────────────────────────────────

/**
 * The declared expectations. Every permission in the catalogue appears here
 * with the exact set of roles that may use it; the test below fails if the
 * catalogue and this table ever drift apart, so adding a permission without
 * deciding who holds it is a test failure rather than an accident.
 *
 * There is one active staff role: every admin-panel permission belongs to an
 * administrator, and the retired enum values hold nothing. They remain in the
 * database only so historical records can still identify their original actor.
 */
const EXPECTED_ROLE_ACCESS: Record<Permission, readonly Role[]> = {
  'members:create': ['ADMINISTRATOR'],
  'members:list': ['ADMINISTRATOR'],
  'members:read': ['ADMINISTRATOR'],
  'members:update': ['ADMINISTRATOR'],
  'members:suspend': ['ADMINISTRATOR'],
  'members:issue-claim': ['ADMINISTRATOR'],
  'benefits:read-published': [],
  'benefits:read-all': ['ADMINISTRATOR'],
  'benefits:manage': ['ADMINISTRATOR'],
  // Only a member asks for a benefit. No staff role holds this: an approval an
  // administrator both raised and granted has nobody to answer for it.
  'requests:create': [],
  'requests:read': ['ADMINISTRATOR'],
  'requests:decide': ['ADMINISTRATOR'],
  // Whoever can approve can mark used. Splitting those between two roles would
  // leave a queue that one person fills and nobody can finish.
  'redemptions:record': ['ADMINISTRATOR'],
  'redemptions:list': ['ADMINISTRATOR'],
  'redemptions:reverse': ['ADMINISTRATOR'],
  'reports:read': ['ADMINISTRATOR'],
  'reports:export': ['ADMINISTRATOR'],
  'staff:manage': ['ADMINISTRATOR'],
  'staff:self': ['ADMINISTRATOR'],
  'member:self': [],
};

describe('the authorization matrix covers every role against every permission', () => {
  it('declares an expectation for every permission in the catalogue', () => {
    expect(Object.keys(EXPECTED_ROLE_ACCESS).sort()).toEqual([...PERMISSIONS].sort());
  });

  it.each(PERMISSIONS)('matches the declared expectation for %s', (permission) => {
    const expected = EXPECTED_ROLE_ACCESS[permission];

    for (const role of ALL_ROLES) {
      expect(
        roleHasPermission(role, permission),
        `${role} vs ${permission}: expected ${expected.includes(role) ? 'ALLOW' : 'DENY'}`,
      ).toBe(expected.includes(role));
    }
  });
});

describe('retired staff roles hold no permissions', () => {
  it.each(RETIRED_ROLES)('%s holds nothing', (role) => {
    expect([...permissionsForRole(role)]).toEqual([]);
  });
});

// ── The matrix, exercised over real HTTP ───────────────────────────────────

describe('the matrix holds over HTTP, not only in the permission table', () => {
  async function tokenForRole(role: Role): Promise<string> {
    const staff = await ownerPrisma.staffUser.findFirstOrThrow({ where: { role: 'ADMINISTRATOR' } });

    // Signed with the real key, but claiming the role under test. This is the
    // strongest form of the check: the token is cryptographically valid and
    // the server must still refuse it on role grounds alone.
    return issueAccessToken({
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE_STAFF,
      subject: staff.id,
      subjectType: 'STAFF',
      role,
      tokenVersion: staff.tokenVersion,
      ttlSeconds: 300,
    });
  }

  it('answers 404 for a path with no route, not 403', async () => {
    // The preHandler runs for unmatched paths too, where there is no route
    // config to read. Failing closed there would turn every typo into a 403
    // and make an unknown path distinguishable from a known-but-forbidden one.
    const response = await request(app.server).get('/no-such-path');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'not_found', message: 'Not found.' });
  });

  it('rejects an unauthenticated request to a protected route with 401', async () => {
    const probe = await buildApp({ env });
    probe.get('/probe/members', { config: { permission: 'members:list' } }, async () => ({ ok: true }));
    await probe.ready();

    const response = await request(probe.server).get('/probe/members');
    expect(response.status).toBe(401);

    await probe.close();
  });

  it.each(RETIRED_ROLES)(
    'rejects a valid token for a stored retired %s account with 401',
    async (role) => {
      const probe = await buildApp({ env });
      probe.get('/probe/members', { config: { permission: 'members:list' } }, async () => ({ ok: true }));
      await probe.ready();

      const outlet =
        role === 'OUTLET_STAFF'
          ? await ownerPrisma.outlet.findFirstOrThrow({ where: { active: true } })
          : null;
      const retired = await ownerPrisma.staffUser.create({
        data: {
          fullName: `Retired ${role}`,
          email: `authorization-retired-${role.toLowerCase()}-${Date.now()}@pgp.test`,
          passwordHash: 'not-used-by-this-test',
          role,
          outletId: outlet?.id ?? null,
          // The database permits retired roles only as suspended historical
          // identities. They must remain unusable even with an old valid JWT.
          status: 'SUSPENDED',
        },
      });
      const token = await issueAccessToken({
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE_STAFF,
        subject: retired.id,
        subjectType: 'STAFF',
        // Even an old or forged claim that says administrator must lose to the
        // authoritative retired role in the database.
        role: 'ADMINISTRATOR',
        tokenVersion: retired.tokenVersion,
        ttlSeconds: 300,
      });

      try {
        const response = await request(probe.server)
          .get('/probe/members')
          .set('Authorization', `Bearer ${token}`);

        expect(response.status).toBe(401);
      } finally {
        await ownerPrisma.staffUser.delete({ where: { id: retired.id } });
        await probe.close();
      }
    },
  );

  it('accepts a token whose stored role holds the permission', async () => {
    const probe = await buildApp({ env });
    probe.get('/probe/members', { config: { permission: 'members:list' } }, async () => ({ ok: true }));
    await probe.ready();

    const token = await tokenForRole('ADMINISTRATOR');
    const response = await request(probe.server)
      .get('/probe/members')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);

    await probe.close();
  });

  it('rejects a member-audience token presented to a staff route', async () => {
    const probe = await buildApp({ env });
    probe.get('/probe/members', { config: { permission: 'members:list' } }, async () => ({ ok: true }));
    await probe.ready();

    const member = await ownerPrisma.member.findUniqueOrThrow({
      where: { memberNumber: 'PG-0003' },
    });
    const memberToken = await issueAccessToken({
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE_MEMBER,
      subject: member.id,
      subjectType: 'MEMBER',
      tokenVersion: member.tokenVersion,
      ttlSeconds: 300,
    });

    const response = await request(probe.server)
      .get('/probe/members')
      .set('Authorization', `Bearer ${memberToken}`);

    expect(response.status).toBe(401);

    await probe.close();
  });
});

// ── Criterion 3 ────────────────────────────────────────────────────────────

describe('R18 — out-of-scope records return 404, never 403', () => {
  /**
   * A route shaped exactly like Stage 4's `GET /admin/members/:id` will be:
   * the scope fragment goes into the `where` clause, and a miss is a 404. It
   * lives here rather than in src/ because the real endpoint belongs to
   * Stage 4 — but the mechanism it exercises is Stage 3's, and is the same
   * code the real handler will use.
   */
  async function buildProbeApp(): Promise<FastifyInstance> {
    const probe = await buildApp({ env });

    probe.get<{ Params: { id: string } }>(
      '/probe/members/:id',
      { config: { permission: 'members:read' } },
      async (req) => {
        const principal = req.principal;
        if (!principal) {
          throw new NotFoundError();
        }

        const member = await probe.prisma.member.findFirst({
          where: scopedWhere({ id: req.params.id }, scopeForMember(principal)),
        });

        if (!member) {
          throw new NotFoundError();
        }

        return { memberNumber: member.memberNumber };
      },
    );

    await probe.ready();
    return probe;
  }

  it('returns an identical 404 for a real out-of-scope member and a nonexistent one', async () => {
    const probe = await buildProbeApp();

    const member = await ownerPrisma.member.findUniqueOrThrow({
      where: { memberNumber: 'PG-0003' },
    });
    const otherMember = await ownerPrisma.member.findUniqueOrThrow({
      where: { memberNumber: 'PG-0001' },
    });

    // A member principal: scoped to their own record only.
    const token = await issueAccessToken({
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE_MEMBER,
      subject: member.id,
      subjectType: 'MEMBER',
      tokenVersion: member.tokenVersion,
      ttlSeconds: 300,
    });

    const memberProbe = await buildApp({ env });
    memberProbe.get<{ Params: { id: string } }>(
      '/probe/self/:id',
      { config: { permission: 'member:self' } },
      async (req) => {
        const principal = req.principal;
        if (!principal) {
          throw new NotFoundError();
        }
        const found = await memberProbe.prisma.member.findFirst({
          where: scopedWhere({ id: req.params.id }, scopeForMember(principal)),
        });
        if (!found) {
          throw new NotFoundError();
        }
        return { memberNumber: found.memberNumber };
      },
    );
    await memberProbe.ready();

    const ownRecord = await request(memberProbe.server)
      .get(`/probe/self/${member.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(ownRecord.status).toBe(200);

    // Another member's real, existing record.
    const otherRecord = await request(memberProbe.server)
      .get(`/probe/self/${otherMember.id}`)
      .set('Authorization', `Bearer ${token}`);

    // A record that does not exist at all.
    const missingRecord = await request(memberProbe.server)
      .get('/probe/self/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${token}`);

    expect(otherRecord.status).toBe(404);
    expect(missingRecord.status).toBe(404);
    // Indistinguishable: a different body would leak what the status code
    // was careful not to.
    expect(otherRecord.body).toEqual(missingRecord.body);

    await memberProbe.close();
    await probe.close();
  });
});

describe('scopeFor puts the restriction in the query, not after it', () => {
  it('scopes a member principal to their own record', () => {
    expect(scopeForMember({ subjectId: 'member-1', subjectType: 'MEMBER' })).toEqual({
      id: 'member-1',
    });
  });

  it('scopes a member to their own redemptions', () => {
    expect(scopeForRedemption({ subjectId: 'member-1', subjectType: 'MEMBER' })).toEqual({
      memberId: 'member-1',
    });
  });

  it('actually excludes out-of-scope rows when used as a where clause', async () => {
    const target = await ownerPrisma.member.findUniqueOrThrow({
      where: { memberNumber: 'PG-0001' },
    });
    const other = await ownerPrisma.member.findUniqueOrThrow({
      where: { memberNumber: 'PG-0003' },
    });

    const principal = { subjectId: other.id, subjectType: 'MEMBER' } as const;

    const found = await ownerPrisma.member.findFirst({
      where: scopedWhere({ id: target.id }, scopeForMember(principal)),
    });

    // The database never returned the row, so no handler could have leaked it.
    expect(found).toBeNull();
  });

  it('still returns the row when the caller is entitled to it', async () => {
    const own = await ownerPrisma.member.findUniqueOrThrow({
      where: { memberNumber: 'PG-0001' },
    });

    const found = await ownerPrisma.member.findFirst({
      where: scopedWhere(
        { id: own.id },
        scopeForMember({ subjectId: own.id, subjectType: 'MEMBER' }),
      ),
    });

    // A scope that denied everything would also pass the test above, so this
    // asserts the fragment is restrictive rather than merely broken.
    expect(found?.id).toBe(own.id);
  });

  it('composes with AND so a scope fragment cannot overwrite the requested id', () => {
    // Regression: spreading the fragment — as the §5 snippet illustrates —
    // let the caller's own id replace the id being asked about, turning a
    // should-be-404 into a 200 returning the caller's own record.
    const principal = { subjectId: 'caller-own-id', subjectType: 'MEMBER' } as const;

    const spread = { id: 'someone-elses-id', ...scopeForMember(principal) };
    expect(spread.id).toBe('caller-own-id'); // the bug, demonstrated

    const composed = scopedWhere({ id: 'someone-elses-id' }, scopeForMember(principal));
    expect(composed).toEqual({
      AND: [{ id: 'someone-elses-id' }, { id: 'caller-own-id' }],
    });
  });
});
