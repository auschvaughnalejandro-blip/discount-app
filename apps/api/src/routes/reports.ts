import { Prisma } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { NotFoundError, RateLimitedError } from '../errors.js';
import {
  DIMENSIONS,
  DIMENSION_NAME_LIST,
  METRICS,
  METRIC_NAME_LIST,
  isDimensionName,
  isMetricName,
  type DimensionName,
  type MetricName,
} from '../reporting/metrics.js';
import { suppressGroup } from '../reporting/suppression.js';
import { writeAudit } from '../security/audit.js';
import { checkRateLimit } from '../security/rate-limit.js';
import { scopeForMember, scopeForRedemption, scopedWhere } from '../security/scope.js';

/**
 * Reporting (wireframes screens 13 and D5).
 *
 * Aggregate by default. Reaching named individuals requires a deliberate step
 * into the member screens, which is separately logged (D5 note 4).
 */

const rangeSchema = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict();

const groupedSchema = rangeSchema.extend({
  metric: z.string().optional(),
  dimension: z.string().optional(),
});

interface GroupedRow {
  label: string;
  value: bigint | number | null;
  cohort: bigint | number | null;
}

/**
 * Apply a stored percentage to integer minor units without passing through a
 * binary float. PostgreSQL's numeric `round` sends halves away from zero, so
 * the magnitude is rounded before restoring the sign for reversal rows.
 */
function discountValueMinor(billAmountMinor: number, discountPctApplied: unknown): bigint {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(String(discountPctApplied));
  if (!match) {
    throw new Error('Stored redemption percentage is invalid.');
  }

  const basisPoints = BigInt(Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')));
  const signedMinor = BigInt(billAmountMinor);
  const magnitude = signedMinor < 0n ? -signedMinor : signedMinor;
  const rounded = (magnitude * basisPoints + 5_000n) / 10_000n;
  return signedMinor < 0n ? -rounded : rounded;
}

/** Exact two-decimal major-unit text for a CSV cell, e.g. 1000n -> `10.00`. */
function formatMinorUnits(minorUnits: bigint): string {
  const negative = minorUnits < 0n;
  const magnitude = negative ? -minorUnits : minorUnits;
  const whole = magnitude / 100n;
  const fraction = (magnitude % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

const reportRoutes: FastifyPluginAsync = async (app) => {
  const env = app.env;

  function dateFilter(from?: string, to?: string): Prisma.Sql {
    // Parameterised, never concatenated (§8: "parameterised queries only").
    if (from && to) {
      return Prisma.sql`AND r."occurredAt" >= ${new Date(from)} AND r."occurredAt" < ${new Date(to)}`;
    }
    if (from) {
      return Prisma.sql`AND r."occurredAt" >= ${new Date(from)}`;
    }
    if (to) {
      return Prisma.sql`AND r."occurredAt" < ${new Date(to)}`;
    }
    return Prisma.empty;
  }

  /**
   * Runs one metric over one dimension.
   *
   * `metric` and `dimension` are names that have already been checked against
   * the allowlist by the caller; what is interpolated here is the fragment the
   * allowlist maps them to, written in src/reporting/metrics.ts.
   */
  async function grouped(
    metric: MetricName,
    dimension: DimensionName,
    from?: string,
    to?: string,
  ): Promise<GroupedRow[]> {
    const dim = DIMENSIONS[dimension];

    return app.prisma.$queryRaw<GroupedRow[]>`
      SELECT ${dim.label} AS label,
             ${METRICS[metric]} AS value,
             count(distinct r."memberId")::bigint AS cohort
      FROM "Redemption" r
      JOIN "Benefit" b ON b."id" = r."benefitId"
      JOIN "Outlet" o ON o."id" = r."outletId"
      WHERE r."reversesId" IS NULL
      ${dateFilter(from, to)}
      GROUP BY ${dim.group}, ${dim.label}
      ORDER BY 1
    `;
  }

  function present(rows: GroupedRow[], metric: MetricName) {
    return rows.map((row) =>
      suppressGroup(
        row.label,
        { [metric]: Number(row.value ?? 0) } as Record<MetricName, number>,
        Number(row.cohort ?? 0),
        env.REPORT_MIN_COHORT_SIZE,
      ),
    );
  }

  // ── GET /admin/reports/summary ────────────────────────────────────────
  app.get('/admin/reports/summary', { config: { permission: 'reports:read' } }, async (request) => {
    const query = rangeSchema.parse(request.query);
    const filter = dateFilter(query.from, query.to);

    const [totals] = await app.prisma.$queryRaw<
      { redemptions: bigint; guests: bigint; cohort: bigint; est_value_minor: bigint }[]
    >`
      SELECT count(*)::bigint AS redemptions,
             coalesce(sum(r."partySize"), 0)::bigint AS guests,
             count(distinct r."memberId")::bigint AS cohort,
             coalesce(sum(round(r."billAmountMinor" * r."discountPctApplied" / 100.0)), 0)::bigint
               AS est_value_minor
      FROM "Redemption" r
      WHERE r."reversesId" IS NULL
      ${filter}
    `;

    const [members] = await app.prisma.$queryRaw<{ total: bigint; never_used: bigint }[]>`
      SELECT count(*)::bigint AS total,
             count(*) FILTER (
               WHERE NOT EXISTS (SELECT 1 FROM "Redemption" x WHERE x."memberId" = m."id")
             )::bigint AS never_used
      FROM "Member" m
    `;

    const cohort = Number(totals?.cohort ?? 0);

    return {
      // The four headline numbers from wireframes D5.
      ...suppressGroup(
        'summary',
        {
          redemptions: Number(totals?.redemptions ?? 0),
          guests: Number(totals?.guests ?? 0),
          activeMembers: cohort,
          estValueMinor: Number(totals?.est_value_minor ?? 0),
        },
        cohort,
        env.REPORT_MIN_COHORT_SIZE,
      ),
      // Membership totals are not a cohort measurement — they describe the
      // programme, not a filtered slice of member behaviour.
      totalMembers: Number(members?.total ?? 0),
      neverUsed: Number(members?.never_used ?? 0),
      minCohortSize: env.REPORT_MIN_COHORT_SIZE,
    };
  });

  // ── GET /admin/reports/by-benefit ─────────────────────────────────────
  app.get(
    '/admin/reports/by-benefit',
    { config: { permission: 'reports:read' } },
    async (request) => {
      const query = groupedSchema.parse(request.query);
      // Both names are checked against the allowlist before a query exists.
      const metric = resolveMetric(query.metric);
      const dimension = resolveDimension(query.dimension, 'benefit');

      return {
        dimension,
        metric,
        minCohortSize: env.REPORT_MIN_COHORT_SIZE,
        groups: present(await grouped(metric, dimension, query.from, query.to), metric),
      };
    },
  );

  // ── GET /admin/reports/by-month ───────────────────────────────────────
  app.get('/admin/reports/by-month', { config: { permission: 'reports:read' } }, async (request) => {
    const query = groupedSchema.parse(request.query);
    const metric = resolveMetric(query.metric);
    const dimension = resolveDimension(query.dimension, 'month');

    return {
      dimension,
      metric,
      minCohortSize: env.REPORT_MIN_COHORT_SIZE,
      groups: present(await grouped(metric, dimension, query.from, query.to), metric),
    };
  });

  // ── GET /admin/reports/dormant-members ────────────────────────────────
  // "Six personally invited guests who have never redeemed anything is a list
  // for the General Manager, not a statistic" (wireframes D5 note 3). This is
  // the deliberate step into named individuals, and it is audit-logged.
  app.get(
    '/admin/reports/dormant-members',
    { config: { permission: 'reports:read' } },
    async (request) => {
      const principal = request.principal;
      if (!principal) {
        throw new NotFoundError();
      }

      const members = await app.prisma.member.findMany({
        // A no-op for the roles that hold reports:read today, but the scope
        // belongs in the query rather than in an assumption about the matrix.
        where: scopedWhere<Prisma.MemberWhereInput>(
          { redemptions: { none: {} } },
          scopeForMember(principal),
        ),
        orderBy: { memberNumber: 'asc' },
        take: env.MEMBER_LIST_MAX_PAGE_SIZE,
        select: {
          id: true,
          memberNumber: true,
          fullName: true,
          joinedAt: true,
          claimedAt: true,
          status: true,
        },
      });

      await writeAudit(app.prisma, {
        action: 'report.viewed',
        principal,
        subjectType: 'Report',
        metadata: { report: 'dormant-members', rows: members.length },
        ipAddress: request.ip,
      });

      return { members, total: members.length };
    },
  );

  // ── GET /admin/reports/unclaimed ──────────────────────────────────────
  app.get(
    '/admin/reports/unclaimed',
    { config: { permission: 'reports:read' } },
    async (request) => {
      const principal = request.principal;
      if (!principal) {
        throw new NotFoundError();
      }

      const members = await app.prisma.member.findMany({
        where: scopedWhere<Prisma.MemberWhereInput>(
          { claimedAt: null },
          scopeForMember(principal),
        ),
        orderBy: { memberNumber: 'asc' },
        take: env.MEMBER_LIST_MAX_PAGE_SIZE,
        select: {
          id: true,
          memberNumber: true,
          fullName: true,
          joinedAt: true,
          status: true,
        },
      });

      await writeAudit(app.prisma, {
        action: 'report.viewed',
        principal,
        subjectType: 'Report',
        metadata: { report: 'unclaimed', rows: members.length },
        ipAddress: request.ip,
      });

      return { members, total: members.length };
    },
  );

  // ── GET /admin/reports/export ─────────────────────────────────────────
  // §6: "Exports are a separate permission, administrator-only, rate-limited,
  // individually audited, and alerted in real time." §9 calls bulk export the
  // most sensitive action in the system.
  app.get(
    '/admin/reports/export',
    { config: { permission: 'reports:export' } },
    async (request, reply) => {
    const query = rangeSchema.parse(request.query);
    const principal = request.principal;
    if (!principal) {
      throw new NotFoundError();
    }

    const limit = checkRateLimit(`export:${principal.subjectId}`, {
      windowSeconds: env.RATE_LIMIT_EXPORT_WINDOW_SECONDS,
      max: env.RATE_LIMIT_EXPORT_PER_USER_MAX,
    });
    if (!limit.allowed) {
      // Logged before refusing: a burst of attempts is itself the signal.
      await writeAudit(app.prisma, {
        action: 'report.export.throttled',
        principal,
        subjectType: 'Report',
        ipAddress: request.ip,
      });
      throw new RateLimitedError(limit.retryAfterSeconds);
    }

    const rows = await app.prisma.redemption.findMany({
      where: scopedWhere<Prisma.RedemptionWhereInput>(
        {
          ...(query.from ? { occurredAt: { gte: new Date(query.from) } } : {}),
          ...(query.to ? { occurredAt: { lt: new Date(query.to) } } : {}),
        },
        scopeForRedemption(principal),
      ),
      orderBy: { occurredAt: 'desc' },
      take: 5000,
      select: {
        id: true,
        occurredAt: true,
        partySize: true,
        billAmountMinor: true,
        discountPctApplied: true,
        reversesId: true,
        member: { select: { memberNumber: true } },
        benefit: { select: { key: true, title: true } },
        outlet: { select: { name: true } },
        staffUser: { select: { fullName: true } },
      },
    });

    await writeAudit(app.prisma, {
      action: 'report.exported',
      principal,
      subjectType: 'Report',
      metadata: { rows: rows.length, from: query.from ?? null, to: query.to ?? null },
      ipAddress: request.ip,
    });

    /**
     * A file a person can open, not a payload a program can parse.
     *
     * This is the one artefact that leaves the system for someone outside it —
     * the finance team, reconciling against transactions their own till already
     * recorded. It returned JSON, which meant the one audience it exists for
     * could not read it.
     */
    const csv = toCsv(
      [
        'occurred_at',
        'membership_number',
        'benefit',
        'outlet',
        // The rate on this visit, not the benefit's rate today. An
        // administrator changing a percentage must not restate a month that
        // has already been reported.
        'discount_pct',
        'party_size',
        'bill_total',
        'discount_value',
        'recorded_by',
        'reversal',
      ],
      rows.map((row) => {
        const bill = row.billAmountMinor;
        return [
          row.occurredAt.toISOString(),
          // The membership number, not the name: an export is the most
          // sensitive artefact this system produces, and it should not be a
          // ready-made list of named individuals.
          row.member.memberNumber,
          row.benefit.title,
          row.outlet.name,
          row.discountPctApplied.toString(),
          row.partySize === null ? '' : String(row.partySize),
          // Whole currency in the file, integer minor units in the database.
          // Finance reads QAR; nobody outside this system thinks in fils.
          bill === null ? '' : (bill / 100).toFixed(2),
          bill === null
            ? ''
            : formatMinorUnits(discountValueMinor(bill, row.discountPctApplied)),
          row.staffUser.fullName,
          row.reversesId !== null ? 'yes' : 'no',
        ];
      }),
    );

    const filename = `privilege-guest-redemptions-${new Date().toISOString().slice(0, 10)}.csv`;

    return reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(csv);
    },
  );

  /**
   * Minimal RFC 4180. Quote every field and double any quote inside it.
   *
   * Quoting unconditionally rather than only when needed: a member's name never
   * appears here, but an outlet called "Crust, Doha" or a staff member called
   * O'Brien would otherwise shift every column after it, and a spreadsheet that
   * is subtly wrong is worse than one that fails to open.
   *
   * A BOM, because Excel reads a UTF-8 file without one as the local codepage
   * and mangles any non-ASCII outlet or staff name.
   */
  function toCsv(header: string[], rows: string[][]): string {
    const escape = (field: string) => `"${field.replace(/"/g, '""')}"`;
    const lines = [header, ...rows].map((row) => row.map(escape).join(','));
    return `\ufeff${lines.join('\r\n')}\r\n`;
  }

  function resolveMetric(value: string | undefined): MetricName {
    if (value === undefined) {
      return 'redemptions';
    }
    if (!isMetricName(value)) {
      // Rejected before any query is built (§6).
      throw new UnknownReportField('metric', value, METRIC_NAME_LIST);
    }
    return value;
  }

  function resolveDimension(value: string | undefined, fallback: DimensionName): DimensionName {
    if (value === undefined) {
      return fallback;
    }
    if (!isDimensionName(value)) {
      throw new UnknownReportField('dimension', value, DIMENSION_NAME_LIST);
    }
    return value;
  }
};

export class UnknownReportField extends Error {
  readonly statusCode = 400;

  constructor(
    readonly field: 'metric' | 'dimension',
    readonly supplied: string,
    readonly allowed: readonly string[],
  ) {
    // The name is echoed back because it came from the caller and is not a
    // secret; nothing about the schema is revealed beyond the allowlist,
    // which is fixed and public by design.
    super(`Unknown ${field}: ${supplied}`);
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    resolveReportDimension: (value: string | undefined) => DimensionName;
  }
}

export default reportRoutes;
