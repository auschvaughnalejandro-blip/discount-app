import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';

import type { Env } from '../config/env.js';
import { writeAudit } from '../security/audit.js';
import { checkRateLimit } from '../security/rate-limit.js';
import { verifyAgainstDummy, verifyPassword } from '../security/password.js';
import { issueOtp, verifyOtp } from '../security/otp.js';
import { issueAccessToken } from '../security/tokens.js';
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

    // TODO(open-question): security-implementation.md §3 makes MFA mandatory
    // on every dashboard account "without exception". The Stage 2 endpoint
    // list in BUILD-PLAN.md has no MFA challenge endpoint, and no MFA
    // library, enrollment flow or challenge shape is specified anywhere.
    // `StaffUser.mfaSecret` exists as the extension point; login does not yet
    // gate on it. Recorded in PROGRESS.md open questions — flagged to the
    // user directly, since this is a real gap against an authoritative
    // security document, not a minor omission.

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
      ipAddress: request.ip,
    });

    return reply.code(200).send({
      accessToken,
      accessTokenExpiresIn: ttlSeconds,
      refreshToken: refresh.token,
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

    // Only a claimed, active member can sign back in this way — an unclaimed
    // member goes through /member/claim (Stage 4), not this endpoint.
    const member = await app.prisma.member.findUnique({ where: { phone: body.phone } });

    if (member && member.claimedAt !== null && member.status === 'ACTIVE') {
      // TODO(open-question): no SMS provider is named anywhere in the
      // reference documents. `issueOtp` stores the hashed code; nothing
      // sends it. This is an unimplemented integration point, not a
      // silently-decided one — see PROGRESS.md.
      await issueOtp(app.prisma, body.phone);
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

    const result = await verifyOtp(app.prisma, body.phone, body.code);

    if (!result.ok) {
      return reply.code(401).send({ error: 'invalid_code', message: 'Invalid or expired code.' });
    }

    const member = await app.prisma.member.findUnique({ where: { phone: body.phone } });

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
