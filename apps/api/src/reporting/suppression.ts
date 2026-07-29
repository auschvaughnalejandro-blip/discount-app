/**
 * R13 — small-cohort suppression.
 *
 * security-implementation.md §6:
 *
 *   "With a membership of dozens, a report filtered to one benefit, one outlet
 *    and one week may describe exactly one person. Enforce a minimum cohort
 *    size of 5 below which the endpoint returns 'insufficient data' rather
 *    than a number. Without this, aggregate reporting becomes an indirect
 *    route to individual member movements."
 *
 * The cohort is the number of *distinct members* behind a figure, not the
 * number of rows. Four redemptions by one member is a cohort of one, however
 * many rows it is — and it is the member the report must not identify.
 */

export const INSUFFICIENT_DATA = 'insufficient_data' as const;

export type Suppressed = typeof INSUFFICIENT_DATA;

export interface SuppressibleGroup {
  /** Distinct members contributing to this group. */
  cohortSize: number;
}

export function isSuppressed<T extends SuppressibleGroup>(group: T, minimum: number): boolean {
  return group.cohortSize < minimum;
}

/**
 * Replaces every figure in a group with `insufficient_data` when its cohort is
 * too small, keeping the group's label so the shape of the report is stable.
 *
 * The cohort size itself is withheld too: publishing "3 members" is the same
 * disclosure the suppression exists to prevent, only stated outright.
 */
export function suppressGroup<K extends string>(
  label: string,
  values: Record<K, number>,
  cohortSize: number,
  minimum: number,
): { label: string; suppressed: boolean } & Record<K, number | Suppressed> {
  if (cohortSize >= minimum) {
    return { label, suppressed: false, ...values };
  }

  const blanked = Object.fromEntries(
    Object.keys(values).map((key) => [key, INSUFFICIENT_DATA]),
  ) as Record<K, Suppressed>;

  return { label, suppressed: true, ...blanked };
}
