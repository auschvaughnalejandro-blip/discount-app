import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { PrismaClient, SubjectType } from '@prisma/client';

/**
 * Opaque, high-entropy, unrelated to any JWT. 32 bytes (256 bits) of
 * cryptographically secure randomness, base64url-encoded.
 */
function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Refresh tokens are high-entropy random strings, not low-entropy secrets
 * like passwords — brute-forcing a 256-bit token by guessing is infeasible
 * regardless of hash speed, so a fast hash (SHA-256) is appropriate here,
 * unlike the deliberately slow Argon2id used for passwords. Lookup is by
 * unique index on the hash, not by iterating and comparing — the DB index
 * does not leak timing information about which hash was closest.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type RefreshTokenFailureReason =
  | 'not_found'
  | 'revoked'
  | 'reuse_detected'
  | 'expired';

export class RefreshTokenError extends Error {
  constructor(public readonly reason: RefreshTokenFailureReason) {
    super(`Refresh token rejected: ${reason}`);
  }
}

export interface IssuedRefreshToken {
  token: string;
  familyId: string;
  expiresAt: Date;
}

export interface IssueRefreshTokenInput {
  subjectId: string;
  subjectType: SubjectType;
  ttlSeconds: number;
}

export async function issueRefreshToken(
  prisma: PrismaClient,
  input: IssueRefreshTokenInput,
): Promise<IssuedRefreshToken> {
  const token = generateOpaqueToken();
  const familyId = randomUUID();
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);

  await prisma.refreshToken.create({
    data: {
      subjectId: input.subjectId,
      subjectType: input.subjectType,
      familyId,
      tokenHash: hashToken(token),
      expiresAt,
    },
  });

  return { token, familyId, expiresAt };
}

export interface RotatedRefreshToken extends IssuedRefreshToken {
  subjectId: string;
  subjectType: SubjectType;
}

/**
 * Consumes a presented refresh token and issues its successor in the same
 * family.
 *
 * security-implementation.md §4: "If a spent refresh token is presented
 * again, revoke the whole family and force re-authentication. A legitimate
 * client never replays one." A legitimate client always presents the most
 * recently issued token in its chain; `usedAt` already set means either the
 * client double-submitted (rare, and safe to treat the same way) or someone
 * else is replaying a token the legitimate client already rotated past —
 * both are indistinguishable from here, so both revoke the family.
 */
export async function rotateRefreshToken(
  prisma: PrismaClient,
  presentedToken: string,
  ttlSeconds: number,
): Promise<RotatedRefreshToken> {
  const tokenHash = hashToken(presentedToken);
  const existing = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!existing) {
    throw new RefreshTokenError('not_found');
  }

  if (existing.revokedAt !== null) {
    throw new RefreshTokenError('revoked');
  }

  if (existing.usedAt !== null) {
    await revokeFamily(prisma, existing.familyId);
    throw new RefreshTokenError('reuse_detected');
  }

  if (existing.expiresAt.getTime() <= Date.now()) {
    throw new RefreshTokenError('expired');
  }

  const newToken = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  // Consuming the old token and creating its successor together means a
  // concurrent replay of the same presented token cannot both succeed: the
  // second writer's WHERE clause (usedAt IS NULL) matches zero rows.
  const [updated] = await prisma.$transaction([
    prisma.refreshToken.updateMany({
      where: { tokenHash, usedAt: null },
      data: { usedAt: new Date() },
    }),
    prisma.refreshToken.create({
      data: {
        subjectId: existing.subjectId,
        subjectType: existing.subjectType,
        familyId: existing.familyId,
        tokenHash: hashToken(newToken),
        expiresAt,
      },
    }),
  ]);

  if (updated.count === 0) {
    // Lost the race: another request consumed this token first.
    await revokeFamily(prisma, existing.familyId);
    throw new RefreshTokenError('reuse_detected');
  }

  return {
    token: newToken,
    familyId: existing.familyId,
    expiresAt,
    subjectId: existing.subjectId,
    subjectType: existing.subjectType,
  };
}

export async function revokeFamily(prisma: PrismaClient, familyId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export interface RefreshTokenLookup {
  subjectId: string;
  subjectType: SubjectType;
  familyId: string;
}

/** Identifies the holder of a token without consuming or mutating it. */
export async function identifyRefreshToken(
  prisma: PrismaClient,
  presentedToken: string,
): Promise<RefreshTokenLookup | null> {
  const row = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(presentedToken) },
  });

  if (!row) {
    return null;
  }

  return { subjectId: row.subjectId, subjectType: row.subjectType, familyId: row.familyId };
}

/** Revokes only the presented token's own family — ordinary logout. */
export async function revokeToken(prisma: PrismaClient, presentedToken: string): Promise<void> {
  const row = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(presentedToken) },
  });

  if (row) {
    await revokeFamily(prisma, row.familyId);
  }
}

/**
 * Revokes every refresh token family for a subject, across every device —
 * "logout everywhere". Callers separately increment the subject's
 * `tokenVersion` so outstanding access tokens stop verifying too; revoking
 * refresh tokens alone would leave an already-issued access token valid
 * until it naturally expires.
 */
export async function revokeAllForSubject(
  prisma: PrismaClient,
  subjectId: string,
  subjectType: SubjectType,
): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { subjectId, subjectType, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
