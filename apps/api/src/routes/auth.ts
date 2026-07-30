import type { Role } from '@prisma/client';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';

import type { Env } from '../config/env.js';
import { writeAudit } from '../security/audit.js';
import { logDeliveryOutcome } from '../notifications/code-sender.js';
import { echoNoOtpForDevelopment, echoOtpForDevelopment } from '../security/dev-otp.js';
import { normalizePhone } from '../security/phone.js';
import { checkRateLimit } from '../security/rate-limit.js';
import { verifyAgainstDummy, verifyPassword } from '../security/password.js';
import { issueOtp, verifyOtp } from '../security/otp.js';
import {
  decryptMfaSecret,
  encryptMfaSecret,
  generateMfaSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  mfaEnrollmentUri,
  roleRequiresMfa,
  verifyRecoveryCode,
  verifyTotp,
} from '../security/mfa.js';
import {
  issueMfaChallenge,
  verifyMfaChallenge,
  type MfaChallengeStage,
} from '../security/mfa-challenge.js';
import { issueAccessToken, TokenVerificationError } from '../security/tokens.js';
import {
  identifyRefreshToken,
  issueRefreshToken,
  revokeAllForSubject,
  revokeToken,
  rotateRefreshToken,
  RefreshTokenError,
} from '../security/refresh-tokens.js';

/**
 * Every route in this file is public, and says so explicitly (R17) — you
 * cannot require a token from an endpoint whose purpose is to issue one.
 *
 * Being public is not the same as being unprotected: each handler below
 * applies its own rate limiting, uniform error shapes and constant-time
 * comparisons. `public` here means "no principal required", not "no controls".
 */
const PUBLIC_ROUTE = { config: { permission: 'public' } } as const;

const staffLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
}).strict();

const requestOtpSchema = z.object({
  phone: z.string().min(1),
}).strict();

const verifyOtpSchema = z.object({
  phone: z.string().min(1),
  code: z.string().min(1),
}).strict();

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
}).strict();

/** Stage 19. A TOTP code, or a recovery code in place of one. */
const mfaVerifySchema = z
  .object({
    challengeToken: z.string().min(1),
    code: z.string().min(1).optional(),
    recoveryCode: z.string().min(1).optional(),
  })
  .strict()
  // Exactly one. Accepting both would invite a caller that sends a guessed
  // TOTP alongside a real recovery code and burns the latter on a typo.
  .refine((value) => (value.code === undefined) !== (value.recoveryCode === undefined), {
    message: 'Provide either code or recoveryCode.',
  });

const mfaEnrollStartSchema = z.object({
  challengeToken: z.string().min(1),
}).strict();

const mfaEnrollConfirmSchema = z.object({
  challengeToken: z.string().min(1),
  code: z.string().min(1),
}).strict();

const logoutSchema = z.object({
  refreshToken: z.string().min(1),
}).strict();

/**
 * security-implementation.md §4's TTL table is keyed by surface (dashboard /
 * verification page / member app), not directly by role. `OUTLET_STAFF` is
 * the only role that reaches the verification page; every other staff role
 * reaches the dashboard — so the surface is a function of role.
 */
function staffAccessTokenTtlSeconds(role: string, env: Env): number {
  return role === 'OUTLET_STAFF'
    ? env.ACCESS_TOKEN_TTL_STAFF_VERIFY_SECONDS
    : env.ACCESS_TOKEN_TTL_STAFF_DASHBOARD_SECONDS;
}

function sendTooManyRequests(reply: FastifyReply, retryAfterSeconds: number): void {
  reply.header('Retry-After', String(retryAfterSeconds));
  reply.code(429).send({ error: 'rate_limited', message: 'Too many requests.' });
}

/**
 * The tokens a completed staff sign-in yields.
 *
 * Extracted in Stage 19 so the password-only path (outlet staff) and the
 * post-second-factor path (dashboard accounts) cannot drift apart. If one grew
 * a shorter TTL or forgot an audit entry, the other would silently keep the old
 * behaviour, and the difference would be invisible until someone compared them.
 */
async function completeStaffSignIn(
  app: Parameters<FastifyPluginAsync>[0],
  env: Env,
  staff: { id: string; role: Role; outletId: string | null; tokenVersion: number },
  ipAddress: string,
): Promise<{ accessToken: string; accessTokenExpiresIn: number; refreshToken: string }> {
  const ttlSeconds = staffAccessTokenTtlSeconds(staff.role, env);

  const accessToken = await issueAccessToken({
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE_STAFF,
    subject: staff.id,
    subjectType: 'STAFF',
    role: staff.role,
    ...(staff.outletId ? { outletId: staff.outletId } : {}),
    tokenVersion: staff.tokenVersion,
    ttlSeconds,
  });

  const refresh = await issueRefreshToken(app.prisma, {
    subjectId: staff.id,
    subjectType: 'STAFF',
    ttlSeconds: env.REFRESH_TOKEN_TTL_STAFF_SECONDS,
  });

  await writeAudit(app.prisma, {
    action: 'auth.login.success',
    principal: { subjectId: staff.id, subjectType: 'STAFF', role: staff.role },
    subjectType: 'StaffUser',
    subjectId: staff.id,
    ipAddress,
  });

  return { accessToken, accessTokenExpiresIn: ttlSeconds, refreshToken: refresh.token };
}

const authRoutes: FastifyPluginAsync = async (app) => {
  const env = app.env;

  // ── POST /auth/staff/login ────────────────────────────────────────────
  app.post('/auth/staff/login', PUBLIC_ROUTE, async (request, reply) => {
    const body = staffLoginSchema.parse(request.body);

    const ipLimit = checkRateLimit(`login:ip:${request.ip}`, {
      windowSeconds: env.RATE_LIMIT_LOGIN_WINDOW_SECONDS,
      max: env.RATE_LIMIT_LOGIN_PER_IP_MAX,
    });
    if (!ipLimit.allowed) {
      return sendTooManyRequests(reply, ipLimit.retryAfterSeconds);
    }
    const identifierLimit = checkRateLimit(`login:id:${body.email.toLowerCase()}`, {
      windowSeconds: env.RATE_LIMIT_LOGIN_WINDOW_SECONDS,
      max: env.RATE_LIMIT_LOGIN_PER_IDENTIFIER_MAX,
    });
    if (!identifierLimit.allowed) {
      return sendTooManyRequests(reply, identifierLimit.retryAfterSeconds);
    }

    const staff = await app.prisma.staffUser.findUnique({ where: { email: body.email } });

    // Uniform response and timing whether or not the account exists
    // (security-implementation.md §3 "Account enumeration"): a real Argon2
    // verification always runs, against either the account's own hash or a
    // fixed dummy hash, before any branch that could differ in shape returns.
    const passwordOk = staff
      ? await verifyPassword(body.password, staff.passwordHash)
      : await verifyAgainstDummy();

    if (!staff || !passwordOk || staff.status !== 'ACTIVE') {
      // §9: every authentication event. The email is not recorded — a failed
      // login against a non-existent account would otherwise write the
      // attacker's guess into the audit trail.
      await writeAudit(app.prisma, {
        action: 'auth.login.failure',
        subjectType: 'StaffUser',
        ...(staff ? { subjectId: staff.id } : {}),
        ipAddress: request.ip,
      });

      return reply.code(401).send({ error: 'invalid_credentials', message: 'Invalid credentials.' });
    }

    /**
     * Stage 19 (Q5). §3: MFA on every account that reaches more than the
     * verification page. The password alone gets no tokens for those accounts —
     * only a challenge, which authorises nothing but the attempt to present a
     * second factor.
     *
     * `enroll` when the account has never completed enrollment, so "without
     * exception" cannot be satisfied by simply never enrolling. There is no
     * path from an un-enrolled dashboard account to an access token.
     */
    if (roleRequiresMfa(staff.role)) {
      const stage: MfaChallengeStage = staff.mfaEnrolledAt === null ? 'enroll' : 'verify';

      const challengeToken = await issueMfaChallenge({
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE_STAFF,
        staffUserId: staff.id,
        stage,
        ttlSeconds: env.MFA_CHALLENGE_TTL_SECONDS,
      });

      await writeAudit(app.prisma, {
        action: 'auth.mfa.challenged',
        principal: { subjectId: staff.id, subjectType: 'STAFF', role: staff.role },
        subjectType: 'StaffUser',
        subjectId: staff.id,
        ipAddress: request.ip,
      });

      return reply.code(200).send({
        mfaRequired: true,
        stage,
        challengeToken,
        challengeExpiresIn: env.MFA_CHALLENGE_TTL_SECONDS,
      });
    }

    // OUTLET_STAFF only, by the branch above: the verification page is not a
    // dashboard, and §3 covers it with named accounts and shift-length expiry.
    return reply.code(200).send(await completeStaffSignIn(app, env, staff, request.ip));
  });

  // ── MFA (Stage 19) ────────────────────────────────────────────────────

  /**
   * Resolves a challenge token to a live, active staff account.
   *
   * Re-reads the account on every step rather than trusting the challenge: an
   * account suspended in the seconds between password and second factor must
   * not complete sign-in, and §3 requires instant revocation to mean instant.
   */
  async function resolveChallenge(
    token: string,
    expectedStage: MfaChallengeStage,
  ): Promise<
    | { ok: false }
    | {
        ok: true;
        staff: {
          id: string;
          role: Role;
          email: string;
          outletId: string | null;
          tokenVersion: number;
          mfaSecret: string | null;
          mfaEnrolledAt: Date | null;
          mfaLastUsedEpoch: number | null;
        };
      }
  > {
    let claims;
    try {
      claims = await verifyMfaChallenge(token, {
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE_STAFF,
      });
    } catch (cause) {
      if (cause instanceof TokenVerificationError) {
        return { ok: false };
      }
      throw cause;
    }

    if (claims.stage !== expectedStage) {
      return { ok: false };
    }

    const staff = await app.prisma.staffUser.findUnique({
      where: { id: claims.staffUserId },
      select: {
        id: true,
        role: true,
        email: true,
        outletId: true,
        tokenVersion: true,
        status: true,
        mfaSecret: true,
        mfaEnrolledAt: true,
        mfaLastUsedEpoch: true,
      },
    });

    // Suspended between password and second factor: no tokens. §3's "instant
    // revocation from the dashboard" has to hold inside this window too.
    if (!staff || staff.status !== 'ACTIVE' || !roleRequiresMfa(staff.role)) {
      return { ok: false };
    }

    return { ok: true, staff };
  }

  /** One shape for every MFA rejection — never "wrong code" versus "expired". */
  function rejectMfa(reply: FastifyReply): void {
    reply.code(401).send({ error: 'mfa_failed', message: 'That code was not accepted.' });
  }

  // ── POST /auth/staff/mfa/enroll ───────────────────────────────────────
  // Issues a secret and the URI an authenticator app scans. Nothing is
  // considered enrolled until /confirm proves the member of staff can produce a
  // code from it, so calling this repeatedly is harmless and simply supersedes
  // the previous unconfirmed secret.
  app.post('/auth/staff/mfa/enroll', PUBLIC_ROUTE, async (request, reply) => {
    const body = mfaEnrollStartSchema.parse(request.body);

    const resolved = await resolveChallenge(body.challengeToken, 'enroll');
    if (!resolved.ok) {
      return rejectMfa(reply);
    }

    const secret = generateMfaSecret();
    await app.prisma.staffUser.update({
      where: { id: resolved.staff.id },
      // mfaEnrolledAt deliberately untouched: a secret without a confirmation
      // is not enrollment.
      data: { mfaSecret: encryptMfaSecret(secret) },
    });

    return reply.code(200).send({
      // Both forms: the URI for a QR, the secret for manual entry on a device
      // that cannot scan.
      otpauthUri: mfaEnrollmentUri({
        email: resolved.staff.email,
        secret,
        issuerLabel: env.MFA_ISSUER_LABEL,
      }),
      secret,
    });
  });

  // ── POST /auth/staff/mfa/enroll/confirm ───────────────────────────────
  app.post('/auth/staff/mfa/enroll/confirm', PUBLIC_ROUTE, async (request, reply) => {
    const body = mfaEnrollConfirmSchema.parse(request.body);

    const resolved = await resolveChallenge(body.challengeToken, 'enroll');
    if (!resolved.ok || !resolved.staff.mfaSecret) {
      return rejectMfa(reply);
    }

    const limit = checkRateLimit(`mfa:enroll:${resolved.staff.id}`, {
      windowSeconds: env.RATE_LIMIT_MFA_VERIFY_WINDOW_SECONDS,
      max: env.RATE_LIMIT_MFA_VERIFY_PER_USER_MAX,
    });
    if (!limit.allowed) {
      return sendTooManyRequests(reply, limit.retryAfterSeconds);
    }

    const enrollCheck = await verifyTotp({
      token: body.code,
      secret: decryptMfaSecret(resolved.staff.mfaSecret),
      afterEpoch: resolved.staff.mfaLastUsedEpoch,
    });
    if (!enrollCheck.valid) {
      await writeAudit(app.prisma, {
        action: 'auth.mfa.failure',
        subjectType: 'StaffUser',
        subjectId: resolved.staff.id,
        ipAddress: request.ip,
      });
      return rejectMfa(reply);
    }

    // Recovery codes are shown exactly once, here. Only their hashes are kept,
    // so a lost printout cannot be recovered — it has to be regenerated.
    const recoveryCodes = generateRecoveryCodes();
    const hashes = await Promise.all(recoveryCodes.map((code) => hashRecoveryCode(code)));

    await app.prisma.$transaction([
      app.prisma.staffUser.update({
        where: { id: resolved.staff.id },
        // The confirming code is spent too — it must not also work as a login.
        data: { mfaEnrolledAt: new Date(), mfaLastUsedEpoch: enrollCheck.epoch },
      }),
      app.prisma.mfaRecoveryCode.createMany({
        data: hashes.map((codeHash) => ({ staffUserId: resolved.staff.id, codeHash })),
      }),
    ]);

    await writeAudit(app.prisma, {
      action: 'auth.mfa.enrolled',
      principal: { subjectId: resolved.staff.id, subjectType: 'STAFF', role: resolved.staff.role },
      subjectType: 'StaffUser',
      subjectId: resolved.staff.id,
      ipAddress: request.ip,
    });

    const tokens = await completeStaffSignIn(app, env, resolved.staff, request.ip);
    return reply.code(200).send({ ...tokens, recoveryCodes });
  });

  // ── POST /auth/staff/mfa/verify ───────────────────────────────────────
  app.post('/auth/staff/mfa/verify', PUBLIC_ROUTE, async (request, reply) => {
    const body = mfaVerifySchema.parse(request.body);

    const resolved = await resolveChallenge(body.challengeToken, 'verify');
    if (!resolved.ok || !resolved.staff.mfaSecret || resolved.staff.mfaEnrolledAt === null) {
      return rejectMfa(reply);
    }

    // Per account rather than per IP: the challenge already names the account,
    // and an attacker rotating IPs must not get a fresh budget of guesses
    // against six digits.
    const limit = checkRateLimit(`mfa:verify:${resolved.staff.id}`, {
      windowSeconds: env.RATE_LIMIT_MFA_VERIFY_WINDOW_SECONDS,
      max: env.RATE_LIMIT_MFA_VERIFY_PER_USER_MAX,
    });
    if (!limit.allowed) {
      return sendTooManyRequests(reply, limit.retryAfterSeconds);
    }

    let usedRecovery = false;

    if (body.recoveryCode !== undefined) {
      const candidates = await app.prisma.mfaRecoveryCode.findMany({
        where: { staffUserId: resolved.staff.id, usedAt: null },
        select: { id: true, codeHash: true },
      });

      // Argon2 verify against each unused hash. Ten of them, once in a while,
      // by a member of staff who has lost their phone — the cost is acceptable
      // and there is no way to index a hash by its plaintext.
      let matchedId: string | null = null;
      for (const candidate of candidates) {
        if (await verifyRecoveryCode(body.recoveryCode, candidate.codeHash)) {
          matchedId = candidate.id;
          break;
        }
      }

      if (matchedId === null) {
        await writeAudit(app.prisma, {
          action: 'auth.mfa.failure',
          subjectType: 'StaffUser',
          subjectId: resolved.staff.id,
          ipAddress: request.ip,
        });
        return rejectMfa(reply);
      }

      // Consumed atomically: `usedAt: null` in the where clause means two
      // concurrent requests presenting the same code cannot both succeed.
      const consumed = await app.prisma.mfaRecoveryCode.updateMany({
        where: { id: matchedId, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (consumed.count === 0) {
        return rejectMfa(reply);
      }

      usedRecovery = true;
    } else {
      const check = await verifyTotp({
        token: body.code!,
        secret: decryptMfaSecret(resolved.staff.mfaSecret),
        // Refuses a code from a period already spent, so one read over a
        // shoulder cannot be reused inside its ~90-second validity window.
        afterEpoch: resolved.staff.mfaLastUsedEpoch,
      });
      if (!check.valid) {
        await writeAudit(app.prisma, {
          action: 'auth.mfa.failure',
          subjectType: 'StaffUser',
          subjectId: resolved.staff.id,
          ipAddress: request.ip,
        });
        return rejectMfa(reply);
      }

      // Marked spent before any token is issued: a concurrent request
      // presenting the same code must lose the race, not double-succeed.
      const spent = await app.prisma.staffUser.updateMany({
        where: {
          id: resolved.staff.id,
          OR: [{ mfaLastUsedEpoch: null }, { mfaLastUsedEpoch: { lt: check.epoch } }],
        },
        data: { mfaLastUsedEpoch: check.epoch },
      });
      if (spent.count === 0) {
        return rejectMfa(reply);
      }
    }

    await writeAudit(app.prisma, {
      action: usedRecovery ? 'auth.mfa.recovery_used' : 'auth.mfa.success',
      principal: { subjectId: resolved.staff.id, subjectType: 'STAFF', role: resolved.staff.role },
      subjectType: 'StaffUser',
      subjectId: resolved.staff.id,
      ipAddress: request.ip,
    });

    const tokens = await completeStaffSignIn(app, env, resolved.staff, request.ip);
    const remaining = await app.prisma.mfaRecoveryCode.count({
      where: { staffUserId: resolved.staff.id, usedAt: null },
    });

    return reply.code(200).send({
      ...tokens,
      ...(usedRecovery ? { recoveryCodesRemaining: remaining } : {}),
    });
  });

  // ── POST /auth/member/request-otp ─────────────────────────────────────
  app.post('/auth/member/request-otp', PUBLIC_ROUTE, async (request, reply) => {
    const body = requestOtpSchema.parse(request.body);

    const ipLimit = checkRateLimit(`otp-request:ip:${request.ip}`, {
      windowSeconds: env.RATE_LIMIT_OTP_WINDOW_SECONDS,
      max: env.RATE_LIMIT_OTP_REQUEST_PER_IP_MAX,
    });
    if (!ipLimit.allowed) {
      return sendTooManyRequests(reply, ipLimit.retryAfterSeconds);
    }
    const identifierLimit = checkRateLimit(`otp-request:id:${body.phone}`, {
      windowSeconds: env.RATE_LIMIT_OTP_WINDOW_SECONDS,
      max: env.RATE_LIMIT_OTP_REQUEST_PER_IDENTIFIER_MAX,
    });
    if (!identifierLimit.allowed) {
      return sendTooManyRequests(reply, identifierLimit.retryAfterSeconds);
    }

    // Accepts 55550003, +974 5555 0003, 0097455550003 — all the same member.
    const phone = normalizePhone(body.phone, {
      defaultCountryCode: env.DEFAULT_PHONE_COUNTRY_CODE,
    });

    // Only a claimed, active member can sign back in this way — an unclaimed
    // member goes through /member/claim (Stage 4), not this endpoint.
    const member = phone
      ? await app.prisma.member.findUnique({ where: { phone } })
      : null;

    if (phone && member && member.claimedAt !== null && member.status === 'ACTIVE') {
      const issued = await issueOtp(app.prisma, phone);
      echoOtpForDevelopment(app.log, env, phone, issued.code);

      // Stage 18 (Q6). Delivered to the member's email, because the chosen
      // provider is SMTP — see notifications/code-sender.ts. The outcome is
      // logged and then deliberately discarded: §3 requires the response below
      // to be identical whether or not the number belongs to a member, and a
      // delivery failure that changed it would leak exactly that.
      const delivery = {
        email: member.email,
        phone,
        code: issued.code,
        purpose: 'sign-in' as const,
      };
      const outcome = await app.codeSender.send(delivery);
      logDeliveryOutcome(app.log, app.codeSender, delivery, outcome);
    } else {
      // The HTTP response below is identical either way; this line exists so
      // the terminal is never silent when a code was asked for.
      echoNoOtpForDevelopment(
        env,
        phone ?? body.phone,
        !phone
          ? 'that is not a usable phone number'
          : !member
            ? 'no member has that number'
            : member.claimedAt === null
              ? 'membership not activated yet - use the invitation code'
              : 'membership is suspended',
      );
    }

    // Identical response whether or not the number is registered — on a
    // membership this exclusive, confirming a phone number belongs to a
    // member is itself a disclosure (§3).
    return reply
      .code(200)
      .send({ message: 'If this number is registered, a verification code has been sent.' });
  });

  // ── POST /auth/member/verify-otp ──────────────────────────────────────
  app.post('/auth/member/verify-otp', PUBLIC_ROUTE, async (request, reply) => {
    const body = verifyOtpSchema.parse(request.body);

    const ipLimit = checkRateLimit(`otp-verify:ip:${request.ip}`, {
      windowSeconds: env.RATE_LIMIT_OTP_WINDOW_SECONDS,
      max: env.RATE_LIMIT_OTP_VERIFY_PER_IP_MAX,
    });
    if (!ipLimit.allowed) {
      return sendTooManyRequests(reply, ipLimit.retryAfterSeconds);
    }

    const phone =
      normalizePhone(body.phone, { defaultCountryCode: env.DEFAULT_PHONE_COUNTRY_CODE }) ??
      body.phone;

    const result = await verifyOtp(app.prisma, phone, body.code);

    if (!result.ok) {
      return reply.code(401).send({ error: 'invalid_code', message: 'Invalid or expired code.' });
    }

    const member = await app.prisma.member.findUnique({ where: { phone } });

    if (!member || member.status !== 'ACTIVE') {
      return reply.code(401).send({ error: 'invalid_code', message: 'Invalid or expired code.' });
    }

    const accessToken = await issueAccessToken({
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE_MEMBER,
      subject: member.id,
      subjectType: 'MEMBER',
      tokenVersion: member.tokenVersion,
      ttlSeconds: env.ACCESS_TOKEN_TTL_MEMBER_SECONDS,
    });

    const refresh = await issueRefreshToken(app.prisma, {
      subjectId: member.id,
      subjectType: 'MEMBER',
      ttlSeconds: env.REFRESH_TOKEN_TTL_MEMBER_SECONDS,
    });

    return reply.code(200).send({
      accessToken,
      accessTokenExpiresIn: env.ACCESS_TOKEN_TTL_MEMBER_SECONDS,
      refreshToken: refresh.token,
    });
  });

  // ── POST /auth/refresh ─────────────────────────────────────────────────
  app.post('/auth/refresh', PUBLIC_ROUTE, async (request, reply) => {
    const body = refreshSchema.parse(request.body);

    const identity = await identifyRefreshToken(app.prisma, body.refreshToken);
    if (!identity) {
      return reply.code(401).send({ error: 'invalid_refresh_token', message: 'Session expired.' });
    }

    let subjectRole: string | undefined;
    let subjectOutletId: string | undefined;
    let currentTokenVersion: number;
    let ttlSeconds: number;
    let accessTtlSeconds: number;
    let audience: string;

    if (identity.subjectType === 'STAFF') {
      const staff = await app.prisma.staffUser.findUnique({ where: { id: identity.subjectId } });
      if (!staff || staff.status !== 'ACTIVE') {
        await revokeAllForSubject(app.prisma, identity.subjectId, identity.subjectType);
        return reply.code(401).send({ error: 'invalid_refresh_token', message: 'Session expired.' });
      }
      subjectRole = staff.role;
      if (staff.outletId) {
        subjectOutletId = staff.outletId;
      }
      currentTokenVersion = staff.tokenVersion;
      ttlSeconds = env.REFRESH_TOKEN_TTL_STAFF_SECONDS;
      accessTtlSeconds = staffAccessTokenTtlSeconds(staff.role, env);
      audience = env.JWT_AUDIENCE_STAFF;
    } else {
      const member = await app.prisma.member.findUnique({ where: { id: identity.subjectId } });
      if (!member || member.status !== 'ACTIVE') {
        await revokeAllForSubject(app.prisma, identity.subjectId, identity.subjectType);
        return reply.code(401).send({ error: 'invalid_refresh_token', message: 'Session expired.' });
      }
      currentTokenVersion = member.tokenVersion;
      ttlSeconds = env.REFRESH_TOKEN_TTL_MEMBER_SECONDS;
      accessTtlSeconds = env.ACCESS_TOKEN_TTL_MEMBER_SECONDS;
      audience = env.JWT_AUDIENCE_MEMBER;
    }

    let rotated;
    try {
      rotated = await rotateRefreshToken(app.prisma, body.refreshToken, ttlSeconds);
    } catch (error) {
      if (error instanceof RefreshTokenError) {
        if (error.reason === 'reuse_detected') {
          // §9 alerts on this: a replayed refresh token means the chain was
          // compromised, and the whole family has just been revoked.
          await writeAudit(app.prisma, {
            action: 'auth.refresh.reuse_detected',
            subjectType: identity.subjectType,
            subjectId: identity.subjectId,
            metadata: { familyId: identity.familyId },
            ipAddress: request.ip,
          });
        }
        // Every rejection reason — not found, already revoked, expired, or a
        // detected replay — returns the same response and forces the client
        // back through login/OTP. Reuse detection has already revoked the
        // family inside rotateRefreshToken by this point.
        return reply.code(401).send({ error: 'invalid_refresh_token', message: 'Session expired.' });
      }
      throw error;
    }

    const accessToken = await issueAccessToken({
      issuer: env.JWT_ISSUER,
      audience,
      subject: identity.subjectId,
      subjectType: identity.subjectType,
      tokenVersion: currentTokenVersion,
      ttlSeconds: accessTtlSeconds,
      ...(subjectRole !== undefined ? { role: subjectRole } : {}),
      ...(subjectOutletId !== undefined ? { outletId: subjectOutletId } : {}),
    });

    return reply.code(200).send({
      accessToken,
      accessTokenExpiresIn: accessTtlSeconds,
      refreshToken: rotated.token,
    });
  });

  // ── POST /auth/logout ──────────────────────────────────────────────────
  app.post('/auth/logout', PUBLIC_ROUTE, async (request, reply) => {
    const body = logoutSchema.parse(request.body);
    // Always 200, whether or not the token was valid — its validity is not
    // something this endpoint discloses.
    await revokeToken(app.prisma, body.refreshToken);
    await writeAudit(app.prisma, { action: 'auth.logout', ipAddress: request.ip });
    return reply.code(200).send({ success: true });
  });

  // ── POST /auth/logout-all ──────────────────────────────────────────────
  app.post('/auth/logout-all', PUBLIC_ROUTE, async (request, reply) => {
    const body = logoutSchema.parse(request.body);

    const identity = await identifyRefreshToken(app.prisma, body.refreshToken);

    if (identity) {
      await revokeAllForSubject(app.prisma, identity.subjectId, identity.subjectType);

      // Bumping tokenVersion is what invalidates access tokens already
      // issued, not only future refreshes — the mechanism behind
      // logout-everywhere (security-implementation.md §4).
      if (identity.subjectType === 'STAFF') {
        await app.prisma.staffUser.update({
          where: { id: identity.subjectId },
          data: { tokenVersion: { increment: 1 } },
        });
      } else {
        await app.prisma.member.update({
          where: { id: identity.subjectId },
          data: { tokenVersion: { increment: 1 } },
        });
      }

      await writeAudit(app.prisma, {
        action: 'auth.logout_all',
        subjectType: identity.subjectType,
        subjectId: identity.subjectId,
        ipAddress: request.ip,
      });
    }

    return reply.code(200).send({ success: true });
  });
};

export default authRoutes;
