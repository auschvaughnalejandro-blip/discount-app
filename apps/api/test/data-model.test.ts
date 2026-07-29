/**
 * Stage 1 acceptance — the data model.
 *
 * These are integration tests: they need a migrated, seeded database.
 *   npm run db:up && npm run migrate && npm run seed
 *
 * Two connections are used deliberately. `appPrisma` is the least-privileged
 * role the application runs as; `ownerPrisma` owns the schema and is used only
 * for fixture setup and teardown. The gap between them is the control R7
 * depends on — if both were the same role, every immutability test below would
 * pass vacuously.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const appUrl = process.env['DATABASE_URL'];
const ownerUrl = process.env['DATABASE_MIGRATION_URL'];

if (!appUrl || !ownerUrl) {
  throw new Error(
    'DATABASE_URL and DATABASE_MIGRATION_URL must both be set to run the data-model tests. ' +
      'Copy .env.example to apps/api/.env and start the database with `npm run db:up`.',
  );
}

const appPrisma = new PrismaClient({ datasourceUrl: appUrl });
const ownerPrisma = new PrismaClient({ datasourceUrl: ownerUrl });

const FIXTURE_REDEMPTION_ID = 'test-immutability-redemption';
const FIXTURE_IDEMPOTENCY_KEY = 'test-immutability-idempotency-key';
const FIXTURE_AUDIT_ID = 'test-immutability-audit';

beforeAll(async () => {
  await ownerPrisma.redemption.deleteMany({ where: { id: FIXTURE_REDEMPTION_ID } });
  await ownerPrisma.auditLog.deleteMany({ where: { id: FIXTURE_AUDIT_ID } });

  const [member, benefit, outlet, staff] = await Promise.all([
    ownerPrisma.member.findUniqueOrThrow({ where: { memberNumber: 'PG-0003' } }),
    ownerPrisma.benefit.findUniqueOrThrow({ where: { key: 'spa' } }),
    ownerPrisma.outlet.findFirstOrThrow({ where: { kind: 'SPA' } }),
    ownerPrisma.staffUser.findFirstOrThrow({ where: { role: 'OUTLET_STAFF' } }),
  ]);

  await ownerPrisma.redemption.create({
    data: {
      id: FIXTURE_REDEMPTION_ID,
      memberId: member.id,
      benefitId: benefit.id,
      outletId: outlet.id,
      staffUserId: staff.id,
      partySize: 2,
      billAmountMinor: 45_000,
      idempotencyKey: FIXTURE_IDEMPOTENCY_KEY,
    },
  });

  await ownerPrisma.auditLog.create({
    data: { id: FIXTURE_AUDIT_ID, actorType: 'system', action: 'test.fixture' },
  });
});

afterAll(async () => {
  // Only the owner can clean these up — which is the point.
  await ownerPrisma.redemption.deleteMany({ where: { id: FIXTURE_REDEMPTION_ID } });
  await ownerPrisma.auditLog.deleteMany({ where: { id: FIXTURE_AUDIT_ID } });
  await Promise.all([appPrisma.$disconnect(), ownerPrisma.$disconnect()]);
});

describe('the application and owner roles are distinct', () => {
  it('does not run the application as the schema owner', async () => {
    const appRows = await appPrisma.$queryRaw<{ user: string }[]>`SELECT current_user AS user`;
    const ownerRows = await ownerPrisma.$queryRaw<{ user: string }[]>`SELECT current_user AS user`;

    expect(appRows[0]?.user).toBeTruthy();
    expect(appRows[0]?.user).not.toBe(ownerRows[0]?.user);
  });

  it('grants the application only SELECT and INSERT on Redemption', async () => {
    const rows = await appPrisma.$queryRaw<{ privilege_type: string }[]>`
      SELECT privilege_type
      FROM information_schema.table_privileges
      WHERE grantee = current_user AND table_name = 'Redemption'
    `;

    const granted = rows.map((r) => r.privilege_type).sort();
    expect(granted).toEqual(['INSERT', 'SELECT']);
  });
});

describe('R7 — redemptions are immutable', () => {
  it('rejects UPDATE by the application role', async () => {
    await expect(
      appPrisma.redemption.update({
        where: { id: FIXTURE_REDEMPTION_ID },
        data: { partySize: 99 },
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('rejects DELETE by the application role', async () => {
    await expect(
      appPrisma.redemption.delete({ where: { id: FIXTURE_REDEMPTION_ID } }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('leaves the original row byte-identical after a rejected write', async () => {
    const row = await appPrisma.redemption.findUniqueOrThrow({
      where: { id: FIXTURE_REDEMPTION_ID },
    });

    expect(row.partySize).toBe(2);
    expect(row.billAmountMinor).toBe(45_000);
    expect(row.idempotencyKey).toBe(FIXTURE_IDEMPOTENCY_KEY);
    expect(row.reversesId).toBeNull();
  });

  it('still allows the application to record a redemption', async () => {
    const created = await appPrisma.redemption.create({
      data: {
        memberId: (await appPrisma.member.findUniqueOrThrow({ where: { memberNumber: 'PG-0003' } }))
          .id,
        benefitId: (await appPrisma.benefit.findUniqueOrThrow({ where: { key: 'spa' } })).id,
        outletId: (await appPrisma.outlet.findFirstOrThrow({ where: { kind: 'SPA' } })).id,
        staffUserId: (await appPrisma.staffUser.findFirstOrThrow({ where: { role: 'OUTLET_STAFF' } }))
          .id,
        partySize: 1,
        idempotencyKey: `test-insert-${Date.now()}`,
      },
    });

    expect(created.id).toBeTruthy();
    await ownerPrisma.redemption.delete({ where: { id: created.id } });
  });
});

describe('R16 — members are suspended, never deleted', () => {
  it('rejects DELETE on Member by the application role', async () => {
    const member = await appPrisma.member.findUniqueOrThrow({
      where: { memberNumber: 'PG-0002' },
    });

    await expect(appPrisma.member.delete({ where: { id: member.id } })).rejects.toThrow(
      /permission denied/i,
    );

    const stillThere = await appPrisma.member.findUnique({ where: { id: member.id } });
    expect(stillThere).not.toBeNull();
  });
});

describe('the audit log is append-only', () => {
  it('rejects UPDATE and DELETE by the application role', async () => {
    await expect(
      appPrisma.auditLog.update({
        where: { id: FIXTURE_AUDIT_ID },
        data: { action: 'tampered' },
      }),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      appPrisma.auditLog.delete({ where: { id: FIXTURE_AUDIT_ID } }),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('money is never floating point', () => {
  it('stores bill amounts and party sizes as integers', async () => {
    const columns = await appPrisma.$queryRaw<{ table_name: string; column_name: string; data_type: string }[]>`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type IN ('real', 'double precision')
    `;

    expect(columns).toEqual([]);

    const billAmount = await appPrisma.$queryRaw<{ data_type: string }[]>`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Redemption'
        AND column_name = 'billAmountMinor'
    `;

    expect(billAmount[0]?.data_type).toBe('integer');
  });
});

describe('R14 — benefit values live in the database, not in code', () => {
  it('seeds the five benefits from the printed sheet with their real values', async () => {
    const benefits = await appPrisma.benefit.findMany({ orderBy: { sortOrder: 'asc' } });

    expect(benefits.map((b) => b.key)).toEqual(['fnb', 'rooms', 'spa', 'events', 'lifestyle']);

    const byKey = Object.fromEntries(benefits.map((b) => [b.key, b]));

    expect(byKey['fnb']?.discountPct.toString()).toBe('25');
    expect(byKey['fnb']?.maxGuests).toBe(6);
    expect(byKey['fnb']?.reservationPhone).toBe('4020 1720');
    expect(byKey['fnb']?.childRules).toEqual({ '6-12': 50, '0-6': 100 });

    expect(byKey['rooms']?.discountPct.toString()).toBe('30');
    expect(byKey['rooms']?.reservationPhone).toBe('4020 1666');

    expect(byKey['spa']?.discountPct.toString()).toBe('40');
    expect(byKey['spa']?.secondaryPct?.toString()).toBe('25');
    expect(byKey['spa']?.maxGuests).toBe(2);
    expect(byKey['spa']?.reservationPhone).toBe('4020 1625');

    expect(byKey['events']?.discountPct.toString()).toBe('25');
    expect(byKey['events']?.secondaryPct?.toString()).toBe('20');
    expect(byKey['events']?.minGuests).toBe(20);

    expect(byKey['lifestyle']?.discountPct.toString()).toBe('30');
    expect(byKey['lifestyle']?.secondaryPct?.toString()).toBe('25');

    expect(benefits.every((b) => b.published)).toBe(true);
  });
});

describe('R3 — membership numbers are sequential and separate from the internal id', () => {
  it('issues the next number from a database sequence', async () => {
    const [first] = await ownerPrisma.$queryRaw<{ next_member_number: string }[]>`
      SELECT next_member_number()
    `;
    const [second] = await ownerPrisma.$queryRaw<{ next_member_number: string }[]>`
      SELECT next_member_number()
    `;

    expect(first?.next_member_number).toMatch(/^PG-\d{4}$/);
    expect(second?.next_member_number).toMatch(/^PG-\d{4}$/);

    const firstNumber = Number(first?.next_member_number.slice(3));
    const secondNumber = Number(second?.next_member_number.slice(3));
    expect(secondNumber).toBe(firstNumber + 1);
  });

  it('does not derive the internal reference from the membership number', async () => {
    const member = await appPrisma.member.findUniqueOrThrow({
      where: { memberNumber: 'PG-0003' },
    });

    expect(member.id).not.toContain('0003');
    expect(member.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('database-level coherence constraints', () => {
  it('requires an outlet on an outlet_staff account and forbids one otherwise', async () => {
    await expect(
      ownerPrisma.staffUser.create({
        data: {
          fullName: 'Unscoped Outlet Staff',
          email: `unscoped-${Date.now()}@pgp.test`,
          passwordHash: 'x',
          role: 'OUTLET_STAFF',
          outletId: null,
        },
      }),
    ).rejects.toThrow(/StaffUser_outlet_required_for_outlet_staff|constraint/i);
  });

  it('rejects a non-positive party size', async () => {
    const [member, benefit, outlet, staff] = await Promise.all([
      ownerPrisma.member.findUniqueOrThrow({ where: { memberNumber: 'PG-0003' } }),
      ownerPrisma.benefit.findUniqueOrThrow({ where: { key: 'spa' } }),
      ownerPrisma.outlet.findFirstOrThrow({ where: { kind: 'SPA' } }),
      ownerPrisma.staffUser.findFirstOrThrow({ where: { role: 'OUTLET_STAFF' } }),
    ]);

    await expect(
      ownerPrisma.redemption.create({
        data: {
          memberId: member.id,
          benefitId: benefit.id,
          outletId: outlet.id,
          staffUserId: staff.id,
          partySize: 0,
          idempotencyKey: `test-zero-party-${Date.now()}`,
        },
      }),
    ).rejects.toThrow(/Redemption_party_size_positive|constraint/i);
  });

  it('rejects a discount percentage outside 0–100', async () => {
    await expect(
      ownerPrisma.benefit.create({
        data: {
          key: `test-bad-pct-${Date.now()}`,
          title: 'Impossible',
          category: 'Test',
          discountPct: '150.00',
          terms: 'n/a',
          sortOrder: 99,
        },
      }),
    ).rejects.toThrow(/Benefit_discount_pct_range|constraint/i);
  });
});
