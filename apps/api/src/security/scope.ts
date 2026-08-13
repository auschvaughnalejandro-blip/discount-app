import type { Prisma } from '@prisma/client';

import type { Principal } from './principal.js';

/**
 * Scope fragments, and the combinator that applies them to a query's `where`
 * clause, so the query cannot return a record the caller may not see.
 *
 * security-implementation.md §5: "Scope the query; do not fetch and then
 * check." Loading a record first and testing it afterwards leaks its
 * existence through timing, error shape and logs even when the response is
 * eventually a 404.
 *
 * ── Why `scopedWhere` and not the spread in the §5 snippet ────────────────
 *
 * §5 illustrates the idea as:
 *
 *     where: { id: req.params.id, ...scopeFor(req.principal) }
 *
 * That is only safe while the scope fragment shares no keys with the base
 * query. It does share one — a member's scope is `{ id: <their own id> }` —
 * and a later spread wins in an object literal, so the `id` the caller asked
 * for is silently replaced by the caller's own id. The query then succeeds,
 * returning the caller's own record for *any* id they ask about: a 200 where
 * the answer should have been 404.
 *
 * `scopedWhere` composes with `AND` instead, which cannot clobber: both
 * conditions must hold, so an out-of-scope id yields a contradiction and no
 * rows. Same intent as §5, without the collision.
 */

/**
 * Fails closed. Prisma compiles an empty `in` list to a false predicate, so
 * the query returns no rows — where an accidentally-empty fragment (`{}`)
 * would have returned every row.
 */
const MATCHES_NOTHING = { id: { in: [] as string[] } } as const;

/**
 * Combines a query with a scope fragment such that both must hold.
 *
 * Handlers should never spread a scope fragment directly; use this.
 */
export function scopedWhere<T extends object>(base: T, scope: T): T {
  return { AND: [base, scope] } as T;
}

/**
 * The outlet an outlet principal is bound to, or a fragment matching nothing.
 *
 * Every outlet scope routes through this rather than reading
 * `principal.outletId` directly, so the "no outlet means no rows" rule is
 * written once. `resolvePrincipal` already refuses to mint such a principal;
 * this is the second lock on the same door.
 */
function outletBinding(principal: Principal): string | null {
  return principal.role === 'OUTLET_STAFF' && principal.outletId !== undefined
    ? principal.outletId
    : null;
}

/**
 * Members visible to this principal.
 *
 * An outlet account resolves **nothing** here, deliberately: it reads a member
 * only through the scan/lookup path, which returns one exact match and is rate
 * limited. Membership numbers are sequential and printed on cards, so any scope
 * that let a counter credential query members at all would be an enumeration
 * tool (§5).
 */
export function scopeForMember(principal: Principal): Prisma.MemberWhereInput {
  if (principal.subjectType === 'MEMBER') {
    return { id: principal.subjectId };
  }

  switch (principal.role) {
    case 'ADMINISTRATOR':
      return {};
    default:
      return MATCHES_NOTHING;
  }
}

/** Redemptions visible to this principal. An outlet sees only its own. */
export function scopeForRedemption(principal: Principal): Prisma.RedemptionWhereInput {
  if (principal.subjectType === 'MEMBER') {
    // A member reads their own history and nobody else's.
    return { memberId: principal.subjectId };
  }

  switch (principal.role) {
    case 'ADMINISTRATOR':
      return {};
    case 'OUTLET_STAFF': {
      const outletId = outletBinding(principal);
      return outletId === null ? MATCHES_NOTHING : { outletId };
    }
    default:
      return MATCHES_NOTHING;
  }
}

/**
 * Benefit requests visible to this principal.
 *
 * An outlet sees the notices addressed to it. Not every notice of its own kind —
 * the guest names one outlet, and a steakhouse has no business reading what
 * somebody told the other restaurant.
 */
export function scopeForBenefitRequest(principal: Principal): Prisma.BenefitRequestWhereInput {
  if (principal.subjectType === 'MEMBER') {
    // A member reads their own requests and nobody else's.
    return { memberId: principal.subjectId };
  }

  switch (principal.role) {
    case 'ADMINISTRATOR':
      return {};
    case 'OUTLET_STAFF': {
      const outletId = outletBinding(principal);
      return outletId === null ? MATCHES_NOTHING : { outletId };
    }
    default:
      return MATCHES_NOTHING;
  }
}

/**
 * Benefits visible to this principal. Members see published benefits only;
 * administrators see everything and historical staff roles see nothing.
 */
export function scopeForBenefit(principal: Principal): Prisma.BenefitWhereInput {
  if (principal.subjectType === 'MEMBER') {
    return { published: true };
  }

  switch (principal.role) {
    case 'ADMINISTRATOR':
      return {};
    default:
      return MATCHES_NOTHING;
  }
}
