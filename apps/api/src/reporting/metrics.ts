import { Prisma } from '@prisma/client';

/**
 * The server-side allowlist from security-implementation.md §6.
 *
 *   "No client-supplied SQL, ever — including fragments. Metrics and
 *    dimensions come from a server-side allowlist mapping identifiers to
 *    validated expressions. Anything absent from the map is rejected before a
 *    query is built."
 *
 * Nothing here interpolates a caller-supplied string into SQL. A request names
 * a metric and a dimension; those names are looked up, and it is the *looked-up
 * value* — a `Prisma.Sql` fragment written here, in this file — that reaches
 * the query. An unknown name never reaches a query builder at all.
 */

export const METRICS = {
  redemptions: Prisma.sql`count(*)::bigint`,
  guests: Prisma.sql`coalesce(sum(r."partySize"), 0)::bigint`,
  distinct_members: Prisma.sql`count(distinct r."memberId")::bigint`,
  /**
   * Integer minor units throughout: `billAmountMinor * discountPct / 100`,
   * rounded to a whole minor unit at the end. No floating point anywhere in
   * the expression — `numeric` in PostgreSQL is exact decimal.
   */
  est_value_minor: Prisma.sql`
    coalesce(sum(round(r."billAmountMinor" * b."discountPct" / 100.0)), 0)::bigint
  `,
} as const;

export type MetricName = keyof typeof METRICS;

/**
 * Each dimension carries the expression to group by and the expression to
 * label the group with. Both are written here; neither is ever assembled from
 * request data.
 */
export const DIMENSIONS = {
  month: {
    group: Prisma.sql`to_char(r."occurredAt", 'YYYY-MM')`,
    label: Prisma.sql`to_char(r."occurredAt", 'YYYY-MM')`,
  },
  benefit: {
    group: Prisma.sql`b."key"`,
    label: Prisma.sql`b."title"`,
  },
  outlet: {
    group: Prisma.sql`o."id"`,
    label: Prisma.sql`o."name"`,
  },
} as const;

export type DimensionName = keyof typeof DIMENSIONS;

const METRIC_NAMES = new Set(Object.keys(METRICS));
const DIMENSION_NAMES = new Set(Object.keys(DIMENSIONS));

export function isMetricName(value: unknown): value is MetricName {
  return typeof value === 'string' && METRIC_NAMES.has(value);
}

export function isDimensionName(value: unknown): value is DimensionName {
  return typeof value === 'string' && DIMENSION_NAMES.has(value);
}

export const METRIC_NAME_LIST = Object.keys(METRICS) as MetricName[];
export const DIMENSION_NAME_LIST = Object.keys(DIMENSIONS) as DimensionName[];
