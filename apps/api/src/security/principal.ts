import type { PrismaClient, Role } from '@prisma/client';

import { verifyAccessToken, type SubjectType } from './tokens.js';

export interface Principal {
  subjectId: string;
  subjectType: SubjectType;
  /** Present only for STAFF principals. Typed as the Prisma enum so the
   * permission matrix lookup is exhaustive rather than string-keyed. */
  role?: Role;
  /**
   * The outlet an OUTLET_STAFF principal is bound to. Read from the account row
   * on every request, never from the token — so moving an account to a different
   * outlet, or suspending it, takes effect immediately rather than when its
   * current access token happens to expire.
   *
   * Undefined for administrators and members. Every outlet query scopes on it,
   * so an outlet principal that somehow arrived without one must resolve
   * nothing rather than everything.
   */
  outletId?: string;
}

/**
 * Roles that may hold a live session. `MANAGER` and `SUPPORT` are absent: they
 * survive as enum values so historical rows keep their original actor, and a
 * token or account row bearing one is refused here regardless of its status.
 */
const LIVE_ROLES: readonly Role[] = ['ADMINISTRATOR', 'OUTLET_STAFF'];

export type PrincipalResolutionFailureReason =
  | 'token_invalid'
  | 'subject_not_found'
  | 'subject_inactive'
  | 'role_not_allowed'
  | 'stale_token_version';

export class PrincipalResolutionError extends Error {
  constructor(public readonly reason: PrincipalResolutionFailureReason) {
    super(`Principal resolution failed: ${reason}`);
  }
}

/**
 * Stage 2's "token version check on every request": verifies the JWT
 * cryptographically, then confirms the subject still exists, is active, and
 * that the token's `tv` claim matches the subject's *current* token version.
 * Incrementing that version — on logout-all, suspension, or role change —
 * makes every access token minted before the increment fail here, even
 * though the token itself remains a validly signed, unexpired JWT.
 *
 * Stage 3 builds the permission/scope wrapper on top of this; it does not
 * duplicate this check.
 */
export async function resolvePrincipal(
  prisma: PrismaClient,
  token: string,
  expected: { issuer: string; audience: string | string[] },
): Promise<Principal> {
  const claims = await verifyAccessToken(token, expected).catch(() => {
    throw new PrincipalResolutionError('token_invalid');
  });

  if (claims.subjectType === 'STAFF') {
    const staff = await prisma.staffUser.findUnique({
      where: { id: claims.sub },
      include: { outlet: { select: { active: true } } },
    });
    if (!staff) {
      throw new PrincipalResolutionError('subject_not_found');
    }
    if (staff.status !== 'ACTIVE') {
      throw new PrincipalResolutionError('subject_inactive');
    }
    // MANAGER and SUPPORT remain on suspended historical rows so member and
    // redemption attribution keeps its original actor. They are not live
    // account types and no access token may revive one.
    if (!LIVE_ROLES.includes(staff.role)) {
      throw new PrincipalResolutionError('role_not_allowed');
    }
    // Outlet sessions are device-token sessions only. A missing/closed outlet or
    // any historical/anomalous auth method fails closed even if a valid JWT for
    // the row still exists.
    if (
      staff.role === 'OUTLET_STAFF' &&
      (staff.authMethod !== 'TOKEN' || staff.outletId === null || !staff.outlet?.active)
    ) {
      throw new PrincipalResolutionError('role_not_allowed');
    }
    if (staff.tokenVersion !== claims.tv) {
      throw new PrincipalResolutionError('stale_token_version');
    }
    return {
      subjectId: staff.id,
      subjectType: 'STAFF',
      role: staff.role,
      ...(staff.outletId !== null ? { outletId: staff.outletId } : {}),
    };
  }

  const member = await prisma.member.findUnique({ where: { id: claims.sub } });
  if (!member) {
    throw new PrincipalResolutionError('subject_not_found');
  }
  if (member.status !== 'ACTIVE') {
    throw new PrincipalResolutionError('subject_inactive');
  }
  if (member.tokenVersion !== claims.tv) {
    throw new PrincipalResolutionError('stale_token_version');
  }
  return { subjectId: member.id, subjectType: 'MEMBER' };
}
