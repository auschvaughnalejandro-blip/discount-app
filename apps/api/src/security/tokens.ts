import { randomUUID } from 'node:crypto';

import { jwtVerify, SignJWT, errors as joseErrors } from 'jose';

export type SubjectType = 'MEMBER' | 'STAFF';

export interface AccessTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  subjectType: SubjectType;
  role?: string;
  /** Outlet the token is scoped to. Present only for OUTLET_STAFF. */
  oid?: string;
  /** Token version. Compared against the subject's current value on every
   * request; incrementing the stored value invalidates every outstanding
   * access token (security-implementation.md §4). */
  tv: number;
  jti: string;
}

export class TokenVerificationError extends Error {}

/**
 * security-implementation.md §4: "EdDSA (Ed25519) or RS256. HS256 acceptable
 * only within a single deployable." This build is one Fastify process serving
 * all three surfaces (member app, verification page, admin dashboard) — a
 * single deployable — so HS256 applies. See DECISIONS.md.
 *
 * The algorithm is a constant, never read from the token: `jwtVerify` is
 * called with `algorithms: [ACCESS_TOKEN_ALGORITHM]` below, which makes jose
 * reject anything else — including `alg: none` — before checking the
 * signature at all.
 */
const ACCESS_TOKEN_ALGORITHM = 'HS256';

function signingKey(): Uint8Array {
  const secret = process.env['JWT_SIGNING_KEY'];
  if (!secret) {
    throw new Error('JWT_SIGNING_KEY is not set.');
  }
  return new TextEncoder().encode(secret);
}

export interface IssueAccessTokenInput {
  issuer: string;
  audience: string;
  subject: string;
  subjectType: SubjectType;
  role?: string;
  outletId?: string;
  tokenVersion: number;
  ttlSeconds: number;
}

export async function issueAccessToken(input: IssueAccessTokenInput): Promise<string> {
  const jti = randomUUID();

  let builder = new SignJWT({
    subjectType: input.subjectType,
    tv: input.tokenVersion,
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.outletId !== undefined ? { oid: input.outletId } : {}),
  })
    .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM })
    .setIssuer(input.issuer)
    .setAudience(input.audience)
    .setSubject(input.subject)
    .setJti(jti)
    .setIssuedAt();

  builder = builder.setExpirationTime(`${input.ttlSeconds}s`);

  return builder.sign(signingKey());
}

/**
 * Verifies signature, issuer, audience and expiry. Does **not** check token
 * version — that requires a database read against the current subject, which
 * callers perform separately (`tv` is returned for them to compare) so this
 * function stays a pure cryptographic check with no I/O.
 */
export async function verifyAccessToken(
  token: string,
  expected: { issuer: string; audience: string | string[] },
): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, signingKey(), {
      algorithms: [ACCESS_TOKEN_ALGORITHM],
      issuer: expected.issuer,
      audience: expected.audience,
    });

    const { sub, aud, iss, jti } = payload;
    const subjectType = payload['subjectType'];
    const tv = payload['tv'];

    if (typeof sub !== 'string' || sub.length === 0) {
      throw new TokenVerificationError('Missing subject claim.');
    }
    if (typeof jti !== 'string' || jti.length === 0) {
      throw new TokenVerificationError('Missing jti claim.');
    }
    if (subjectType !== 'MEMBER' && subjectType !== 'STAFF') {
      throw new TokenVerificationError('Missing or invalid subjectType claim.');
    }
    if (typeof tv !== 'number') {
      throw new TokenVerificationError('Missing tv claim.');
    }
    const role = payload['role'];
    const oid = payload['oid'];
    if (role !== undefined && typeof role !== 'string') {
      throw new TokenVerificationError('Invalid role claim.');
    }
    if (oid !== undefined && typeof oid !== 'string') {
      throw new TokenVerificationError('Invalid oid claim.');
    }

    return {
      iss: typeof iss === 'string' ? iss : expected.issuer,
      aud: typeof aud === 'string' ? aud : Array.isArray(aud) ? (aud[0] ?? '') : '',
      sub,
      subjectType,
      tv,
      jti,
      ...(role !== undefined ? { role } : {}),
      ...(oid !== undefined ? { oid } : {}),
    };
  } catch (error) {
    if (error instanceof TokenVerificationError) {
      throw error;
    }
    // Every error jose itself raises — bad signature, wrong alg (including
    // `alg: none`, via the `algorithms` allowlist above), expired, wrong
    // iss/aud, malformed — extends JOSEError. Anything else is a genuine bug
    // and should propagate rather than be silently reclassified.
    if (error instanceof joseErrors.JOSEError) {
      throw new TokenVerificationError(error.message);
    }
    throw error;
  }
}
