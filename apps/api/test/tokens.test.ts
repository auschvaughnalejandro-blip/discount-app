/**
 * Stage 2 acceptance — JWT verification.
 *
 * Pure cryptographic checks: no database required. Uses the same
 * JWT_SIGNING_KEY / JWT_ISSUER / JWT_AUDIENCE_STAFF loaded from apps/api/.env
 * by test/setup.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { issueAccessToken, verifyAccessToken, TokenVerificationError } from '../src/security/tokens.js';

let issuer: string;
let audience: string;
let otherAudience: string;

beforeAll(() => {
  issuer = process.env['JWT_ISSUER'] ?? '';
  audience = process.env['JWT_AUDIENCE_STAFF'] ?? '';
  otherAudience = process.env['JWT_AUDIENCE_MEMBER'] ?? '';

  if (!issuer || !audience || !otherAudience) {
    throw new Error('JWT_ISSUER, JWT_AUDIENCE_STAFF and JWT_AUDIENCE_MEMBER must be set to run tokens.test.ts.');
  }
});

function base64url(input: object): string {
  return Buffer.from(JSON.stringify(input)).toString('base64url');
}

describe('a token with alg: none is rejected', () => {
  it('rejects an unsigned token even with an otherwise well-formed payload', async () => {
    const header = base64url({ alg: 'none', typ: 'JWT' });
    const now = Math.floor(Date.now() / 1000);
    const payload = base64url({
      iss: issuer,
      aud: audience,
      sub: 'attacker-controlled-subject',
      subjectType: 'STAFF',
      role: 'ADMINISTRATOR',
      tv: 1,
      jti: 'forged-jti',
      iat: now,
      exp: now + 600,
    });
    const forgedToken = `${header}.${payload}.`;

    await expect(verifyAccessToken(forgedToken, { issuer, audience })).rejects.toThrow(
      TokenVerificationError,
    );
  });
});

describe('a token with a modified role claim is rejected', () => {
  it('fails signature verification once the payload is tampered with', async () => {
    const token = await issueAccessToken({
      issuer,
      audience,
      subject: 'staff-subject-id',
      subjectType: 'STAFF',
      role: 'OUTLET_STAFF',
      tokenVersion: 1,
      ttlSeconds: 600,
    });

    const [headerPart, payloadPart, signaturePart] = token.split('.');
    if (!headerPart || !payloadPart || !signaturePart) {
      throw new Error('Malformed token under test.');
    }

    const decoded = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(decoded['role']).toBe('OUTLET_STAFF');
    decoded['role'] = 'ADMINISTRATOR';

    const tamperedPayload = Buffer.from(JSON.stringify(decoded)).toString('base64url');
    // The original signature, kept as-is: an attacker without the signing
    // key cannot produce a valid one for the new payload.
    const tamperedToken = `${headerPart}.${tamperedPayload}.${signaturePart}`;

    await expect(verifyAccessToken(tamperedToken, { issuer, audience })).rejects.toThrow(
      TokenVerificationError,
    );
  });
});

describe('an expired token is rejected', () => {
  it('rejects a token past its exp claim', async () => {
    const token = await issueAccessToken({
      issuer,
      audience,
      subject: 'staff-subject-id',
      subjectType: 'STAFF',
      role: 'ADMINISTRATOR',
      tokenVersion: 1,
      ttlSeconds: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    await expect(verifyAccessToken(token, { issuer, audience })).rejects.toThrow(
      TokenVerificationError,
    );
  });
});

describe('a token with the wrong aud is rejected', () => {
  it('rejects a staff-audience token presented to a member-audience check', async () => {
    const token = await issueAccessToken({
      issuer,
      audience,
      subject: 'staff-subject-id',
      subjectType: 'STAFF',
      role: 'ADMINISTRATOR',
      tokenVersion: 1,
      ttlSeconds: 600,
    });

    await expect(
      verifyAccessToken(token, { issuer, audience: otherAudience }),
    ).rejects.toThrow(TokenVerificationError);
  });

  it('accepts the same token against its correct audience', async () => {
    const token = await issueAccessToken({
      issuer,
      audience,
      subject: 'staff-subject-id',
      subjectType: 'STAFF',
      role: 'ADMINISTRATOR',
      tokenVersion: 1,
      ttlSeconds: 600,
    });

    const claims = await verifyAccessToken(token, { issuer, audience });
    expect(claims.sub).toBe('staff-subject-id');
    expect(claims.role).toBe('ADMINISTRATOR');
  });
});
