/**
 * Stage 1 seed — 5 outlets, the 5 benefits with their real values, one
 * administrator, one outlet staff user, three test members.
 *
 * Runs as the schema owner (`DATABASE_MIGRATION_URL`), not the application
 * role, because the application role is deliberately denied some of the writes
 * a seed performs.
 *
 * Every value below comes from docs/product-definition.md §2 and the benefit
 * table in docs/wireframes.html. None of it is duplicated in application code —
 * these rows are the only place the numbers live (R14).
 */
import { hash, type Algorithm } from '@node-rs/argon2';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * `Algorithm` is an ambient `const enum`, which `verbatimModuleSyntax` cannot
 * import as a value. Annotating with the type keeps the value checked against
 * the enum rather than being a bare magic number.
 */
const ARGON2ID: Algorithm = 2;

const databaseUrl = process.env['DATABASE_MIGRATION_URL'] ?? process.env['DATABASE_URL'];

if (!databaseUrl) {
  throw new Error('Set DATABASE_MIGRATION_URL (preferred) or DATABASE_URL before seeding.');
}

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });

/**
 * Parameters are fixed by docs/security-implementation.md §3 and are not
 * configurable — an environment variable here would be a way to silently
 * weaken password hashing.
 *
 * TODO(stage-2): §3 also requires a pepper held in the key management service,
 * passed as `secret`. Stage 2 owns credential handling and will introduce it,
 * at which point seeded hashes must be regenerated.
 */
async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, {
    algorithm: ARGON2ID,
    memoryCost: 65536, // 64 MB
    timeCost: 3,
    parallelism: 2,
    outputLen: 32,
  });
}

/**
 * Development credentials only. Real staff accounts are created through the
 * dashboard, and §3 makes MFA mandatory on every account that can reach more
 * than the verification page.
 */
const DEV_PASSWORD = 'privilege-guest-dev-only';

const OUTLETS = [
  { key: 'crust', name: 'Crust', kind: 'DINING' },
  { key: 'spa', name: 'The Spa', kind: 'SPA' },
  { key: 'rooms', name: 'Rooms & Residence', kind: 'ROOMS' },
  { key: 'events', name: 'Meetings & Events', kind: 'EVENTS' },
  { key: 'entrance', name: 'Entrance', kind: 'OTHER' },
] as const;

interface BenefitSeed {
  key: string;
  title: string;
  category: string;
  /** Decimal as a string so no value passes through binary floating point. */
  discountPct: string;
  secondaryLabel: string | null;
  secondaryPct: string | null;
  /** Percentage off by age band, e.g. { "6-12": 50, "0-6": 100 }. */
  childRules: Record<string, number> | null;
  maxGuests: number | null;
  minGuests: number | null;
  reservationPhone: string | null;
  terms: string;
  sortOrder: number;
}

/**
 * The printed benefits sheet, as data. Changing the dining discount from 25%
 * to 20% is an UPDATE against this table and nothing else (R14).
 */
const BENEFITS: BenefitSeed[] = [
  {
    key: 'fnb',
    title: 'F&B Outlets',
    category: 'Dining',
    discountPct: '25.00',
    secondaryLabel: null,
    secondaryPct: null,
    childRules: { '6-12': 50, '0-6': 100 },
    maxGuests: 6,
    minGuests: null,
    reservationPhone: '4020 1720',
    terms:
      'Maximum 6 people per cardholder. 50% discount for children aged 6–12; children under 6 dine free. Benefits are subject to change; you will be notified of significant changes.',
    sortOrder: 1,
  },
  {
    key: 'rooms',
    title: 'Rooms & Suites',
    category: 'Rooms',
    discountPct: '30.00',
    secondaryLabel: null,
    secondaryPct: null,
    childRules: null,
    maxGuests: null,
    minGuests: null,
    reservationPhone: '4020 1666',
    terms:
      'Off published bar rates at the Hotel & Residence. Subject to availability. Benefits are subject to change; you will be notified of significant changes.',
    sortOrder: 2,
  },
  {
    key: 'spa',
    title: 'Spa',
    category: 'Spa',
    discountPct: '40.00',
    secondaryLabel: 'Retail products',
    secondaryPct: '25.00',
    childRules: null,
    maxGuests: 2,
    minGuests: null,
    reservationPhone: '4020 1625',
    terms:
      'Maximum 2 people per cardholder. Applies to all treatments booked directly with the spa. Subject to availability. Benefits are subject to change; you will be notified of significant changes.',
    sortOrder: 3,
  },
  {
    key: 'events',
    title: 'Meetings & Events',
    category: 'Events',
    discountPct: '25.00',
    secondaryLabel: 'Outside catering',
    secondaryPct: '20.00',
    childRules: null,
    maxGuests: null,
    minGuests: 20,
    reservationPhone: null,
    terms:
      'Minimum 20 people. 20% discount applies to outside catering. Benefits are subject to change; you will be notified of significant changes.',
    sortOrder: 4,
  },
  {
    key: 'lifestyle',
    title: 'Lifestyle & SPG Memberships',
    category: 'Lifestyle',
    discountPct: '30.00',
    secondaryLabel: 'Pool day pass',
    secondaryPct: '25.00',
    childRules: null,
    maxGuests: null,
    minGuests: null,
    reservationPhone: null,
    terms:
      'Complimentary valet parking and wifi included. Benefits are subject to change; you will be notified of significant changes.',
    sortOrder: 5,
  },
];

/**
 * TODO(open-question): product-definition.md §11 Q5 asks whether membership
 * expires or renews. Nothing here expires; there is no expiry column.
 */
const MEMBERS = [
  {
    memberNumber: 'PG-0001',
    fullName: 'Test Member One',
    phone: '+97455550001',
    email: 'member1@pgp.test',
    joinedAt: new Date('2024-04-15T00:00:00Z'),
    claimedAt: new Date('2024-04-18T00:00:00Z'),
  },
  {
    // Card issued, app never claimed. A distinct, reportable state from
    // "claimed but never redeemed" — see wireframes D3 note 3.
    memberNumber: 'PG-0002',
    fullName: 'Test Member Two',
    phone: '+97455550002',
    email: 'member2@pgp.test',
    joinedAt: new Date('2024-11-02T00:00:00Z'),
    claimedAt: null,
  },
  {
    // The reference card throughout the specification documents.
    memberNumber: 'PG-0003',
    fullName: 'Test Member Three',
    phone: '+97455550003',
    email: 'member3@pgp.test',
    joinedAt: new Date('2024-04-15T00:00:00Z'),
    claimedAt: new Date('2024-04-18T00:00:00Z'),
  },
] as const;

/** §10: consent is stored with the wording version it was given against. */
const CONSENT_WORDING_VERSION = 'v1-2026-07';

async function main(): Promise<void> {
  const outletIds = new Map<string, string>();

  for (const outlet of OUTLETS) {
    const row = await prisma.outlet.upsert({
      where: { id: `seed-outlet-${outlet.key}` },
      update: { name: outlet.name, kind: outlet.kind, active: true },
      create: {
        id: `seed-outlet-${outlet.key}`,
        name: outlet.name,
        kind: outlet.kind,
        active: true,
      },
    });
    outletIds.set(outlet.key, row.id);
  }

  const passwordHash = await hashPassword(DEV_PASSWORD);

  const administrator = await prisma.staffUser.upsert({
    where: { email: 'admin@pgp.test' },
    update: {},
    create: {
      id: 'seed-staff-administrator',
      fullName: 'S. Abouelmagd',
      email: 'admin@pgp.test',
      passwordHash,
      role: 'ADMINISTRATOR',
      outletId: null,
      status: 'ACTIVE',
    },
  });

  const spaOutletId = outletIds.get('spa');
  if (!spaOutletId) {
    throw new Error('Spa outlet missing — cannot scope the outlet staff account.');
  }

  await prisma.staffUser.upsert({
    where: { email: 'fatima.a@pgp.test' },
    update: {},
    create: {
      id: 'seed-staff-outlet',
      fullName: 'Fatima A.',
      email: 'fatima.a@pgp.test',
      passwordHash,
      role: 'OUTLET_STAFF',
      // An outlet_staff account is bound to exactly one outlet; the database
      // CHECK constraint rejects it otherwise.
      outletId: spaOutletId,
      status: 'ACTIVE',
    },
  });

  for (const benefit of BENEFITS) {
    const fields = {
      title: benefit.title,
      category: benefit.category,
      discountPct: benefit.discountPct,
      secondaryLabel: benefit.secondaryLabel,
      secondaryPct: benefit.secondaryPct,
      // Prisma.DbNull writes a SQL NULL; a bare `null` would be ambiguous with
      // a JSON `null` value for a nullable Json column.
      childRules: benefit.childRules === null ? Prisma.DbNull : benefit.childRules,
      maxGuests: benefit.maxGuests,
      minGuests: benefit.minGuests,
      reservationPhone: benefit.reservationPhone,
      terms: benefit.terms,
      published: true,
      sortOrder: benefit.sortOrder,
      updatedByUserId: administrator.id,
    };

    await prisma.benefit.upsert({
      where: { key: benefit.key },
      update: fields,
      create: { key: benefit.key, ...fields },
    });
  }

  for (const member of MEMBERS) {
    const created = await prisma.member.upsert({
      where: { memberNumber: member.memberNumber },
      update: {},
      create: {
        memberNumber: member.memberNumber,
        fullName: member.fullName,
        phone: member.phone,
        email: member.email,
        status: 'ACTIVE',
        joinedAt: member.joinedAt,
        claimedAt: member.claimedAt,
        createdByUserId: administrator.id,
      },
    });

    // Consent applies only to members who completed activation — it is
    // captured during the claim flow (R15), so an unclaimed member has none.
    if (member.claimedAt !== null) {
      const existing = await prisma.consentRecord.findFirst({
        where: { memberId: created.id, channel: 'EMAIL' },
      });

      if (!existing) {
        await prisma.consentRecord.create({
          data: {
            memberId: created.id,
            channel: 'EMAIL',
            granted: true,
            wordingVersion: CONSENT_WORDING_VERSION,
            recordedAt: member.claimedAt,
          },
        });
      }
    }
  }

  // The seed writes fixed numbers, so advance the sequence past them; the next
  // member an administrator creates is PG-0004 (R3).
  const highest = MEMBERS.length;
  await prisma.$executeRawUnsafe(`SELECT setval('member_number_seq', ${highest}, true)`);

  // §9: no member names, phone numbers or email addresses in log output —
  // membership numbers and counts only.
  console.log(
    `Seeded ${OUTLETS.length} outlets, ${BENEFITS.length} benefits, 2 staff users, ` +
      `${MEMBERS.length} members (${MEMBERS.map((m) => m.memberNumber).join(', ')}).`,
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
