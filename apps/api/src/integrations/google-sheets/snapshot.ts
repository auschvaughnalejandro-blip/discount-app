import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * Google Sheets is a derived hotel-facing view, never an alternative write
 * path. These are the only tabs the synchroniser owns; every other worksheet
 * in the workbook is left alone.
 */
export const GOOGLE_SHEETS_SCHEMA_VERSION = 2;

export type SheetCell = string | number | boolean;

export interface SheetTable {
  title:
    | 'Overview'
    | 'Members'
    | 'Requests'
    | 'Redemptions'
    | 'Benefits'
    | 'Outlets'
    | 'Sync Info';
  columns: readonly string[];
  rows: SheetCell[][];
}

export interface HotelSheetsSnapshot {
  generatedAt: Date;
  tables: SheetTable[];
}

export interface HotelSheetsSource {
  members: Array<{
    memberNumber: string;
    status: string;
    joinedAt: Date;
    claimed: boolean;
    totalUses: number;
    lastUsedAt: Date | null;
  }>;
  benefits: Array<{
    key: string;
    title: string;
    category: string;
    discountPct: string;
    secondaryLabel: string | null;
    secondaryPct: string | null;
    childRulesJson: string | null;
    maxGuests: number | null;
    minGuests: number | null;
    reservationPhone: string | null;
    terms: string;
    published: boolean;
    sortOrder: number;
    outletKind: string | null;
    version: number;
    updatedAt: Date;
  }>;
  outlets: Array<{
    name: string;
    kind: string;
    active: boolean;
  }>;
  requests: Array<{
    requestedAt: Date;
    memberNumber: string;
    benefit: string;
    status: string;
    decidedAt: Date | null;
    fulfilledAt: Date | null;
  }>;
  redemptions: Array<{
    occurredAt: Date;
    memberNumber: string;
    benefit: string;
    outlet: string;
    discountPct: string;
    partySize: number | null;
    billAmountMinor: number | null;
    recordedBy: string;
    reversal: boolean;
    reversed: boolean;
  }>;
}

const QATAR_TIME_ZONE = 'Asia/Qatar';

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatQatarDate(value: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: QATAR_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(value);
}

function formatQatarDateTime(value: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: QATAR_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(value);
}

function qatarMonthKey(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: QATAR_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(value);
  const year = parts.find((part) => part.type === 'year')?.value ?? '';
  const month = parts.find((part) => part.type === 'month')?.value ?? '';
  return `${year}-${month}`;
}

function secondaryOffer(label: string | null, pct: string | null): string {
  if (label === null) return '';
  return pct === null ? label : `${label}: ${Number(pct)}%`;
}

function benefitTerms(terms: string, childRulesJson: string | null): string {
  if (childRulesJson === null) return terms;
  try {
    const rules = JSON.parse(childRulesJson) as Record<string, unknown>;
    const readable = Object.entries(rules)
      .map(([group, discount]) => `${group}: ${String(discount)}%`)
      .join('; ');
    return readable.length === 0 ? terms : `${terms} Children: ${readable}.`;
  } catch {
    return terms;
  }
}

/**
 * Read one coherent point-in-time snapshot. The transaction is finished before
 * any Google request starts, so a slow or unavailable Sheets API never holds a
 * database transaction open and never affects normal application writes.
 *
 * Every Prisma query uses an explicit allowlist. In particular, this module
 * never reads member names/contact details or any authentication table, which
 * makes it impossible for those values to leak into the workbook later in the
 * projection pipeline.
 */
export async function readHotelSheetsSource(prisma: PrismaClient): Promise<HotelSheetsSource> {
  const [memberRows, benefitRows, outletRows, requestRows, redemptionRows] = await prisma.$transaction(
    [
      prisma.member.findMany({
        orderBy: { memberNumber: 'asc' },
        select: {
          memberNumber: true,
          status: true,
          joinedAt: true,
          claimedAt: true,
          _count: {
            select: {
              redemptions: { where: { reversesId: null } },
            },
          },
          redemptions: {
            where: { reversesId: null },
            orderBy: { occurredAt: 'desc' },
            take: 1,
            select: { occurredAt: true },
          },
        },
      }),
      prisma.benefit.findMany({
        orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
        select: {
          key: true,
          title: true,
          category: true,
          discountPct: true,
          secondaryLabel: true,
          secondaryPct: true,
          childRules: true,
          maxGuests: true,
          minGuests: true,
          reservationPhone: true,
          terms: true,
          published: true,
          sortOrder: true,
          outletKind: true,
          version: true,
          updatedAt: true,
        },
      }),
      prisma.outlet.findMany({
        orderBy: [{ name: 'asc' }, { kind: 'asc' }],
        select: {
          name: true,
          kind: true,
          active: true,
        },
      }),
      prisma.benefitRequest.findMany({
        orderBy: [{ requestedAt: 'desc' }, { id: 'asc' }],
        select: {
          requestedAt: true,
          status: true,
          decidedAt: true,
          fulfilledAt: true,
          member: { select: { memberNumber: true } },
          benefit: { select: { title: true } },
        },
      }),
      prisma.redemption.findMany({
        orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
        select: {
          occurredAt: true,
          discountPctApplied: true,
          partySize: true,
          billAmountMinor: true,
          reversesId: true,
          member: { select: { memberNumber: true } },
          benefit: { select: { title: true } },
          outlet: { select: { name: true } },
          staffUser: { select: { fullName: true } },
          reversedBy: { select: { id: true } },
        },
      }),
    ],
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );

  return {
    members: memberRows.map((row) => ({
      memberNumber: row.memberNumber,
      status: row.status,
      joinedAt: row.joinedAt,
      claimed: row.claimedAt !== null,
      totalUses: row._count.redemptions,
      lastUsedAt: row.redemptions[0]?.occurredAt ?? null,
    })),
    benefits: benefitRows.map((row) => ({
      key: row.key,
      title: row.title,
      category: row.category,
      discountPct: row.discountPct.toString(),
      secondaryLabel: row.secondaryLabel,
      secondaryPct: row.secondaryPct?.toString() ?? null,
      childRulesJson: row.childRules === null ? null : JSON.stringify(row.childRules),
      maxGuests: row.maxGuests,
      minGuests: row.minGuests,
      reservationPhone: row.reservationPhone,
      terms: row.terms,
      published: row.published,
      sortOrder: row.sortOrder,
      outletKind: row.outletKind,
      version: row.version,
      updatedAt: row.updatedAt,
    })),
    outlets: outletRows,
    requests: requestRows.map((row) => ({
      requestedAt: row.requestedAt,
      memberNumber: row.member.memberNumber,
      benefit: row.benefit.title,
      status: row.status,
      decidedAt: row.decidedAt,
      fulfilledAt: row.fulfilledAt,
    })),
    redemptions: redemptionRows.map((row) => ({
      occurredAt: row.occurredAt,
      memberNumber: row.member.memberNumber,
      benefit: row.benefit.title,
      outlet: row.outlet.name,
      discountPct: row.discountPctApplied.toString(),
      partySize: row.partySize,
      billAmountMinor: row.billAmountMinor,
      recordedBy: row.staffUser.fullName,
      reversal: row.reversesId !== null,
      reversed: row.reversedBy !== null,
    })),
  };
}

function valueOrBlank(value: string | number | null): string | number {
  return value ?? '';
}

/** Pure projection, kept separate so the privacy boundary is easy to test. */
export function buildHotelSheetsSnapshot(
  source: HotelSheetsSource,
  generatedAt = new Date(),
): HotelSheetsSnapshot {
  const currentMonth = qatarMonthKey(generatedAt);
  const currentEntries = source.redemptions.filter(
    (row) => qatarMonthKey(row.occurredAt) === currentMonth,
  );
  const signedCount = (row: HotelSheetsSource['redemptions'][number]) =>
    row.reversal ? -1 : 1;
  const redemptionsThisMonth = currentEntries.reduce((total, row) => total + signedCount(row), 0);
  const memberUses = new Map<string, number>();
  const benefitUses = new Map<string, number>();
  const outletUses = new Map<string, number>();
  let billTotal = 0;
  let discountTotal = 0;

  for (const row of currentEntries) {
    const sign = signedCount(row);
    memberUses.set(row.memberNumber, (memberUses.get(row.memberNumber) ?? 0) + sign);
    benefitUses.set(row.benefit, (benefitUses.get(row.benefit) ?? 0) + sign);
    outletUses.set(row.outlet, (outletUses.get(row.outlet) ?? 0) + sign);
    if (row.billAmountMinor !== null) {
      billTotal += sign * (row.billAmountMinor / 100);
      discountTotal += sign * ((row.billAmountMinor * Number(row.discountPct)) / 10_000);
    }
  }

  const rank = (values: Map<string, number>) =>
    [...values.entries()]
      .filter(([, uses]) => uses > 0)
      .sort(([leftName, leftUses], [rightName, rightUses]) =>
        rightUses === leftUses ? leftName.localeCompare(rightName) : rightUses - leftUses,
      )
      .slice(0, 5);
  const topBenefits = rank(benefitUses);
  const topOutlets = rank(outletUses);
  const activeMembers = source.members.filter((row) => row.status === 'ACTIVE');
  const activatedMembers = activeMembers.filter((row) => row.claimed).length;
  const activationRate =
    activeMembers.length === 0 ? 0 : (activatedMembers / activeMembers.length) * 100;

  const overview: SheetTable = {
    title: 'Overview',
    columns: ['Privilege Guest — Management Overview', '', '', '', '', '', '', ''],
    rows: [
      [`Last updated: ${formatQatarDateTime(generatedAt)} Qatar time`, '', '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', ''],
      ['Active Members', '', 'App Activated', '', 'Pending Requests', '', 'Redemptions This Month', ''],
      [
        activeMembers.length,
        '',
        `${activatedMembers} (${activationRate.toFixed(1)}%)`,
        '',
        source.requests.filter((row) => row.status === 'PENDING').length,
        '',
        redemptionsThisMonth,
        '',
      ],
      ['', '', '', '', '', '', '', ''],
      ['Unique Users This Month', '', 'Total Bill Value (QAR)', '', 'Discounts Given (QAR)', '', 'Suspended Members', ''],
      [
        [...memberUses.values()].filter((uses) => uses > 0).length,
        '',
        Number(billTotal.toFixed(2)),
        '',
        Number(discountTotal.toFixed(2)),
        '',
        source.members.filter((row) => row.status === 'SUSPENDED').length,
        '',
      ],
      ['', '', '', '', '', '', '', ''],
      ['Top Benefits This Month', 'Uses', '', '', 'Top Outlets This Month', 'Uses', '', ''],
      ...Array.from({ length: 5 }, (_, index): SheetCell[] => [
        topBenefits[index]?.[0] ?? '—',
        topBenefits[index]?.[1] ?? '',
        '',
        '',
        topOutlets[index]?.[0] ?? '—',
        topOutlets[index]?.[1] ?? '',
        '',
        '',
      ]),
    ],
  };

  const members: SheetTable = {
    title: 'Members',
    columns: [
      'Membership Number',
      'Status',
      'Joined Date',
      'App Activated',
      'Total Uses',
      'Last Used',
    ],
    rows: source.members.map((row) => [
      row.memberNumber,
      titleCase(row.status),
      formatQatarDate(row.joinedAt),
      row.claimed ? 'Yes' : 'No',
      row.totalUses,
      row.lastUsedAt === null ? '' : formatQatarDateTime(row.lastUsedAt),
    ]),
  };

  const requests: SheetTable = {
    title: 'Requests',
    columns: [
      'Requested At',
      'Membership Number',
      'Benefit',
      'Status',
      'Decision Date',
      'Fulfilled Date',
    ],
    rows: source.requests.map((row) => [
      formatQatarDateTime(row.requestedAt),
      row.memberNumber,
      row.benefit,
      titleCase(row.status),
      row.decidedAt === null ? '' : formatQatarDateTime(row.decidedAt),
      row.fulfilledAt === null ? '' : formatQatarDateTime(row.fulfilledAt),
    ]),
  };

  const benefits: SheetTable = {
    title: 'Benefits',
    columns: [
      'Benefit',
      'Category',
      'Main Discount',
      'Secondary Offer',
      'Minimum Guests',
      'Maximum Guests',
      'Applicable Outlet',
      'Reservation Phone',
      'Terms',
      'Published',
      'Last Updated',
    ],
    rows: source.benefits.map((row) => [
      row.title,
      row.category,
      Number(row.discountPct),
      secondaryOffer(row.secondaryLabel, row.secondaryPct),
      valueOrBlank(row.minGuests),
      valueOrBlank(row.maxGuests),
      row.outletKind === null ? 'All outlets' : titleCase(row.outletKind),
      valueOrBlank(row.reservationPhone),
      benefitTerms(row.terms, row.childRulesJson),
      row.published ? 'Published' : 'Draft',
      formatQatarDateTime(row.updatedAt),
    ]),
  };

  const outlets: SheetTable = {
    title: 'Outlets',
    columns: ['Outlet Name', 'Type', 'Status'],
    rows: source.outlets.map((row) => [
      row.name,
      titleCase(row.kind),
      row.active ? 'Active' : 'Inactive',
    ]),
  };

  const redemptions: SheetTable = {
    title: 'Redemptions',
    columns: [
      'Date and Time',
      'Membership Number',
      'Benefit',
      'Outlet',
      'Discount',
      'Party Size',
      'Bill Total',
      'Discount Value',
      'Recorded By',
      'Entry Type',
    ],
    rows: source.redemptions.map((row) => {
      const pct = Number(row.discountPct);
      const billTotal = row.billAmountMinor === null ? null : row.billAmountMinor / 100;
      const discountValue =
        row.billAmountMinor === null
          ? null
          : Number(((row.billAmountMinor * pct) / 10_000).toFixed(2));

      return [
        formatQatarDateTime(row.occurredAt),
        row.memberNumber,
        row.benefit,
        row.outlet,
        pct,
        valueOrBlank(row.partySize),
        valueOrBlank(billTotal),
        valueOrBlank(discountValue === null ? null : row.reversal ? -discountValue : discountValue),
        row.recordedBy,
        row.reversal ? 'Reversal' : row.reversed ? 'Reversed redemption' : 'Redemption',
      ];
    }),
  };

  const businessTables = [members, requests, redemptions, benefits, outlets];
  const sync: SheetTable = {
    title: 'Sync Info',
    columns: ['Field', 'Value'],
    rows: [
      ['Authoritative Source', 'PostgreSQL'],
      ['Last Successful Sync', `${formatQatarDateTime(generatedAt)} Qatar time`],
      ['Schema Version', GOOGLE_SHEETS_SCHEMA_VERSION],
      ['Editing', 'Read only. Changes to managed tabs are overwritten.'],
      ...businessTables.map((table): SheetCell[] => [
        `${table.title} Rows`,
        table.rows.length,
      ]),
    ],
  };

  return {
    generatedAt,
    tables: [overview, ...businessTables, sync],
  };
}
