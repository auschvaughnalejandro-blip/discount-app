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
 * Members visible to this principal.
 *
 * `OUTLET_STAFF` resolves nothing here by design. They may act only on the
 * member currently in front of them, and that binding is a short-lived
 * verification session (security-implementation.md §5) built in Stage 7 —
 * which will pass the resolved member id explicitly rather than widening
 * this scope. Until then the fail-closed answer is the correct one.
 */
export function scopeForMember(principal: Principal): Prisma.MemberWhereInput {
  if (principal.subjectType === 'MEMBER') {
    return { id: principal.subjectId };
  }

  switch (principal.role) {
    case 'ADMINISTRATOR':
    case 'MANAGER':
    case 'SUPPORT':
      return {};
    default:
      return MATCHES_NOTHING;
  }
}

/** Redemptions visible to this principal. */
export function scopeForRedemption(principal: Principal): Prisma.RedemptionWhereInput {
  if (principal.subjectType === 'MEMBER') {
    // A member reads their own history and nobody else's.
    return { memberId: principal.subjectId };
  }

  switch (principal.role) {
    case 'ADMINISTRATOR':
    case 'MANAGER':
      return {};
    case 'OUTLET_STAFF':
      // Scoped to the one outlet the account is bound to. The database CHECK
      // constraint from Stage 1 guarantees outletId is set for this role, so
      // the fallback below is unreachable in practice — but an unscoped
      // fragment here would expose every outlet's traffic, so it fails closed
      // rather than trusting that.
      return principal.outletId ? { outletId: principal.outletId } : MATCHES_NOTHING;
    default:
      return MATCHES_NOTHING;
  }
}

/**
 * Benefits visible to this principal. Members see published benefits only
 * (Stage 5); staff who can manage them see everything.
 */
export function scopeForBenefit(principal: Principal): Prisma.BenefitWhereInput {
  if (principal.subjectType === 'MEMBER') {
    return { published: true };
  }

  switch (principal.role) {
    case 'ADMINISTRATOR':
    case 'MANAGER':
      return {};
    default:
      return { published: true };
  }
}
