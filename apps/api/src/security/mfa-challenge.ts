/**
 * The token issued after a correct password and before a second factor.
 *
 * Kept in its own module, and with its own audience, because the one thing that
 * must not happen is a challenge token being accepted anywhere an access token
 * is. `verifyAccessToken` is called with the staff audience; this is signed for
 * a different one, so the authorization plugin rejects it as surely as it
 * rejects a forgery — the separation is enforced by the audience check that
 * already exists rather than by a new rule somebody has to remember.
 *
 * It carries no role and no outlet: it authorises nothing except the attempt to
 * present a second factor.
 */
import { randomUUID } from 'node:crypto';

import { jwtVerify, SignJWT, errors as joseErrors } from 'jose';

import { TokenVerificationError } from './tokens.js';

const ALGORITHM = 'HS256';

/** Distinct from JWT_AUDIENCE_STAFF. That distinctness is the security property. */
export const MFA_CHALLENGE_AUDIENCE_SUFFIX = ':mfa-challenge';

export function mfaChallengeAudience(staffAudience: string): string {
  return `${staffAudience}${MFA_CHALLENGE_AUDIENCE_SUFFIX}`;
}

function signingKey(): Uint8Array {
  const secret = process.env['JWT_SIGNING_KEY'];
  if (!secret) {
    throw new Error('JWT_SIGNING_KEY is not set.');
  }
  return new TextEncoder().encode(secret);
}

/** What the challenge still has to do once the second factor arrives. */
export type MfaChallengeStage = 'enroll' | 'verify';

export interface MfaChallengeClaims {
  staffUserId: string;
  stage: MfaChallengeStage;
  jti: string;
}

export async function issueMfaChallenge(input: {
  issuer: string;
  audience: string;
  staffUserId: string;
  stage: MfaChallengeStage;
  ttlSeconds: number;
}): Promise<string> {
  return new SignJWT({ stage: input.stage })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuer(input.issuer)
    .setAudience(mfaChallengeAudience(input.audience))
    .setSubject(input.staffUserId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${input.ttlSeconds}s`)
    .sign(signingKey());
}

export async function verifyMfaChallenge(
  token: string,
  expected: { issuer: string; audience: string },
): Promise<MfaChallengeClaims> {
  try {
    const { payload } = await jwtVerify(token, signingKey(), {
      // Pinned, never read from the header — same reasoning as tokens.ts.
      algorithms: [ALGORITHM],
      issuer: expected.issuer,
      audience: mfaChallengeAudience(expected.audience),
    });

    const { sub, jti } = payload;
    const stage = payload['stage'];

    if (typeof sub !== 'string' || sub.length === 0) {
      throw new TokenVerificationError('Missing subject claim.');
    }
    if (typeof jti !== 'string' || jti.length === 0) {
      throw new TokenVerificationError('Missing jti claim.');
    }
    if (stage !== 'enroll' && stage !== 'verify') {
      throw new TokenVerificationError('Missing or invalid stage claim.');
    }

    return { staffUserId: sub, stage, jti };
  } catch (error) {
    if (error instanceof TokenVerificationError) {
      throw error;
    }
    if (error instanceof joseErrors.JOSEError) {
      throw new TokenVerificationError(error.message);
    }
    throw error;
  }
}
