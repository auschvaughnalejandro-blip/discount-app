/**
 * The code on the card.
 *
 * Two forms: the static one printed in ink, and the rotating one kept alive for a
 * client that refreshes it. The interesting assertions are about what each form
 * refuses, and about the fact that neither can be re-read as the other.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  issueCardCode,
  issueRotatingCode,
  verifyIdentityCode,
} from '../src/security/identity-codes.js';
import { issueVerificationSession, verifyVerificationSession } from '../src/security/verification-session.js';

const MEMBER = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-8888-7777-6666-555555555555';

beforeAll(() => {
  // Set explicitly rather than relied on from .env, so this file's assertions do
  // not silently depend on a deployment's secret length.
  process.env['IDENTITY_CODE_HMAC_SECRET'] ??= 'test-identity-code-secret-value';
});

describe('the card code', () => {
  it('round-trips and reports which form was presented', () => {
    const result = verifyIdentityCode(issueCardCode(MEMBER), { windowHours: 24 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.memberRef).toBe(MEMBER);
    expect(result.form).toBe('card');
  });

  it('is the same value every time, because ink cannot rotate', () => {
    expect(issueCardCode(MEMBER)).toBe(issueCardCode(MEMBER));
  });

  it('never expires', () => {
    // A card issued years ago still scans. This is the deliberate difference from
    // the rotating form, and the reason the version prefix exists.
    const result = verifyIdentityCode(issueCardCode(MEMBER), {
      windowHours: 24,
      now: new Date(Date.now() + 5 * 365 * 24 * 60 * 60 * 1000),
    });
    expect(result.ok).toBe(true);
  });

  it('is different per member and cannot be derived from another', () => {
    expect(issueCardCode(MEMBER)).not.toBe(issueCardCode(OTHER));
  });

  it('refuses a tampered member reference', () => {
    const [, , signature] = issueCardCode(MEMBER).split('.');
    const forged = `v2.${OTHER}.${signature}`;

    const result = verifyIdentityCode(forged, { windowHours: 24 });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a malformed payload without throwing', () => {
    for (const bad of ['', 'v2', 'v2.only-two', 'v9.a.b', 'not a code at all']) {
      const result = verifyIdentityCode(bad, { windowHours: 24 });
      expect(result.ok).toBe(false);
    }
  });
});

describe('the rotating code', () => {
  it('round-trips inside its window', () => {
    const result = verifyIdentityCode(issueRotatingCode(MEMBER), { windowHours: 24 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form).toBe('rotating');
    expect(result.issuedAt).toBeInstanceOf(Date);
  });

  it('goes stale outside it', () => {
    const issued = issueRotatingCode(MEMBER, new Date(Date.now() - 48 * 60 * 60 * 1000));
    const result = verifyIdentityCode(issued, { windowHours: 24 });
    expect(result).toEqual({ ok: false, reason: 'stale' });
  });

  it('refuses a payload from the future, which would otherwise never expire', () => {
    const issued = issueRotatingCode(MEMBER, new Date(Date.now() + 48 * 60 * 60 * 1000));
    const result = verifyIdentityCode(issued, { windowHours: 24 });
    expect(result).toEqual({ ok: false, reason: 'stale' });
  });

  it('checks the signature before the timestamp', () => {
    // A forged payload dated far in the past must fail on the signature, not on
    // freshness: reporting 'stale' would mean the timestamp had been trusted.
    const stamp = Math.floor((Date.now() - 48 * 60 * 60 * 1000) / 1000);
    const result = verifyIdentityCode(`v1.${MEMBER}.${stamp}.not-a-signature`, {
      windowHours: 24,
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('the two forms cannot be confused', () => {
  it('will not read a card code as a rotating one', () => {
    const [, memberRef, signature] = issueCardCode(MEMBER).split('.');
    // Same signature, re-labelled as the rotating form with a timestamp bolted on.
    const result = verifyIdentityCode(`v1.${memberRef}.${Math.floor(Date.now() / 1000)}.${signature}`, {
      windowHours: 24,
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('will not read a verification session as an identity code', () => {
    // Both are HMACed with the same key. The version prefix is inside the signed
    // body, which is what keeps one from being verified as the other.
    const session = issueVerificationSession('account-id', MEMBER);
    expect(verifyIdentityCode(session, { windowHours: 24 }).ok).toBe(false);
  });
});

describe('the verification session', () => {
  it('binds one account to one member', () => {
    const token = issueVerificationSession('account-a', MEMBER);

    expect(
      verifyVerificationSession(token, {
        staffUserId: 'account-a',
        memberId: MEMBER,
        ttlSeconds: 600,
      }),
    ).toEqual({ ok: true });

    // A session handed to a colleague is not a session for their call.
    expect(
      verifyVerificationSession(token, {
        staffUserId: 'account-b',
        memberId: MEMBER,
        ttlSeconds: 600,
      }),
    ).toEqual({ ok: false, reason: 'not_bound' });

    // Nor is it a licence to record against a different member.
    expect(
      verifyVerificationSession(token, {
        staffUserId: 'account-a',
        memberId: OTHER,
        ttlSeconds: 600,
      }),
    ).toEqual({ ok: false, reason: 'not_bound' });
  });

  it('expires', () => {
    const token = issueVerificationSession(
      'account-a',
      MEMBER,
      new Date(Date.now() - 20 * 60 * 1000),
    );
    expect(
      verifyVerificationSession(token, {
        staffUserId: 'account-a',
        memberId: MEMBER,
        ttlSeconds: 600,
      }),
    ).toEqual({ ok: false, reason: 'expired' });
  });
});
