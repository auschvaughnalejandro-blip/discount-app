import type { PrismaClient, Role } from '@prisma/client';

import { verifyAccessToken, type SubjectType } from './tokens.js';

export interface Principal {
  subjectId: string;
  subjectType: SubjectType;
  /** Present only for STAFF principals. Typed as the Prisma enum so the
   * permission matrix lookup is exhaustive rather than string-keyed. */
  role?: Role;
}

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
    const staff = await prisma.staffUser.findUnique({ where: { id: claims.sub } });
    if (!staff) {
      throw new PrincipalResolutionError('subject_not_found');
    }
    if (staff.status !== 'ACTIVE') {
      throw new PrincipalResolutionError('subject_inactive');
    }
    // The other enum values remain on suspended historical rows so member and
    // redemption attribution keeps its original actor. They are not live
    // account types and no access token may revive one.
    if (staff.role !== 'ADMINISTRATOR') {
      throw new PrincipalResolutionError('role_not_allowed');
    }
    if (staff.tokenVersion !== claims.tv) {
      throw new PrincipalResolutionError('stale_token_version');
    }
    return {
      subjectId: staff.id,
      subjectType: 'STAFF',
      role: staff.role,
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
