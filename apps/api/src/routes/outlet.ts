import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';

import { ForbiddenError, NotFoundError, RateLimitedError } from '../errors.js';
import { logDeliveryOutcome } from '../notifications/code-sender.js';
import {
  recordRedemption,
  savedMinor,
  serializeRecorded,
  type RecordRedemptionFailure,
  type RecordRedemptionResult,
} from '../redemptions/record.js';
import { writeAudit, type AuditAction } from '../security/audit.js';
import type { Principal } from '../security/principal.js';
import { verifyIdentityCode } from '../security/identity-codes.js';
import {
  hashOutletLoginToken,
  isOutletLoginToken,
} from '../security/outlet-login-token.js';
import { checkRateLimit } from '../security/rate-limit.js';
import { issueRefreshToken } from '../security/refresh-tokens.js';
import { setRefreshCookie } from '../security/session-cookie.js';
import { scopeForBenefitRequest, scopeForRedemption, scopedWhere } from '../security/scope.js';
import { issueAccessToken } from '../security/tokens.js';
import {
  issueVerificationSession,
  verifyVerificationSession,
} from '../security/verification-session.js';

/**
 * The outlet screen — one device, one outlet, the two things it has to do.
 *
 * ## The two paths in
 *
 *   **The guest announced in advance.** Their notice is already on this screen.
 *   Staff confirm it when they arrive, or mark it not used when they don't.
 *
 *   **The guest just walked up.** Staff scan the code on the back of the card (or
 *   type the membership number), see what the guest is entitled to, and record it.
 *   No notice was ever created and none is needed.
 *
 * Neither path grants anything. The guest is entitled to every published benefit
 * already; these routes record what was given, which is a different act.
 *
 * ## How the counter device authenticates
 *
 * The only outlet credential is one high-entropy standing token for each physical
 * tablet or counter. It is exchanged here for an ordinary short access token and rotating
 * refresh session, never sent on queue or redemption calls, and stored in the
 * database only as a SHA-256 digest. A lost device can therefore be revoked
 * without signing every other device at the outlet out.
 * The server still decides what it may do: only an active TOKEN/OUTLET_STAFF row
 * bound to an active outlet receives a session.
 */

const PUBLIC_ROUTE = { config: { permission: 'public' } } as const;

const tokenSignInSchema = z
  .object({
    // Kept as a string rather than a regex at the schema boundary so a typo,
    // revoked token and random input all take the same credential-failure path.
    // The upper bound prevents an oversized request becoming needless hashing
    // and database work.
    token: z.string().trim().max(200),
  })
  .strict();

const confirmSchema = z
  .object({
    partySize: z.number().int().positive().optional(),
    // Minor units, integer. Never a float, and never computed here.
    billAmountMinor: z.number().int().min(0).optional(),
    // R8 — supplied by the client so a retried submission does not double-record.
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

const notUsedSchema = z
  .object({
    // Shown to the member. "They didn't come" with no note reads as an error
    // rather than a fact, and the guest is left wondering what went wrong.
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const resolveSchema = z
  .object({
    // R12: an exact membership number or a scanned payload. Never a name, never
    // a partial match, never a wildcard — the membership must not be enumerable
    // or searchable (§5).
    payload: z.string().trim().min(1).max(500).optional(),
    membershipNumber: z.string().trim().min(1).max(32).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.payload) !== Boolean(value.membershipNumber), {
    message: 'Supply exactly one of payload or membershipNumber.',
  });

const scanRecordSchema = z
  .object({
    // §5: the redemption must be bound to a verification session, so staff can
    // only act on a member they have just resolved at this outlet. Issued by
    // POST /outlet/resolve.
    verificationSession: z.string().trim().min(1).max(500),
    memberId: z.string().uuid(),
    benefitId: z.string().uuid(),
    partySize: z.number().int().positive().optional(),
    billAmountMinor: z.number().int().min(0).optional(),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

const idParamSchema = z.object({ id: z.string().uuid() }).strict();

const FAILURE_STATUS: Record<RecordRedemptionFailure, number> = {
  not_found: 404,
  idempotency_key_reused: 409,
  member_not_active: 422,
  outlet_unavailable: 422,
  benefit_unavailable: 422,
  party_size_required: 422,
  party_size_above_maximum: 422,
  party_size_below_minimum: 422,
  notice_not_valid: 422,
};

const outletRoutes: FastifyPluginAsync = async (app) => {
  const env = app.env;

  /** A device token enters the ordinary short-lived staff-session machinery. */
  async function issueOutletSession(
    account: { id: string; tokenVersion: number },
    store: Parameters<typeof issueRefreshToken>[0] = app.prisma,
  ) {
    const accessToken = await issueAccessToken({
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE_STAFF,
      subject: account.id,
      subjectType: 'STAFF',
      role: 'OUTLET_STAFF',
      tokenVersion: account.tokenVersion,
      ttlSeconds: env.ACCESS_TOKEN_TTL_STAFF_DASHBOARD_SECONDS,
    });

    const refresh = await issueRefreshToken(store, {
      subjectId: account.id,
      subjectType: 'STAFF',
      ttlSeconds: env.REFRESH_TOKEN_TTL_STAFF_SECONDS,
    });

    return { accessToken, refresh };
  }

  // ── Per-device token sign-in ───────────────────────────────────────────
  // ── POST /outlet/auth/token ────────────────────────────────────────────
  // A standing, per-device credential is exchanged for a short access token and
  // rotating refresh session. The standing token is never
  // used as a bearer token on outlet routes and never leaves this handler.
  app.post('/outlet/auth/token', PUBLIC_ROUTE, async (request, reply) => {
    const body = tokenSignInSchema.parse(request.body);

    const ipLimit = checkRateLimit(`outlet-token-login:ip:${request.ip}`, {
      windowSeconds: env.RATE_LIMIT_LOGIN_WINDOW_SECONDS,
      max: env.RATE_LIMIT_LOGIN_PER_IP_MAX,
    });
    if (!ipLimit.allowed) {
      throw new RateLimitedError(ipLimit.retryAfterSeconds);
    }

    // SHA-256 is appropriate for a server-generated 256-bit value: unlike a
    // human password, there is no feasible dictionary to slow down. The unique
    // index makes this one lookup rather than a timing-sensitive scan.
    const tokenHash = isOutletLoginToken(body.token) ? hashOutletLoginToken(body.token) : null;
    const account =
      tokenHash === null
        ? null
        : await app.prisma.staffUser.findUnique({
            where: { outletTokenHash: tokenHash },
            select: {
              id: true,
              role: true,
              status: true,
              tokenVersion: true,
              authMethod: true,
              outlet: { select: { id: true, name: true, active: true } },
            },
          });

    const outlet =
      account !== null &&
      account.status === 'ACTIVE' &&
      account.role === 'OUTLET_STAFF' &&
      account.authMethod === 'TOKEN' &&
      account.outlet !== null &&
      account.outlet.active
        ? account.outlet
        : null;

    // Claim the device row before creating the refresh family. Rotation and
    // revocation update this same row, so PostgreSQL serializes them with this
    // exchange: either the lifecycle action wins and this condition no longer
    // matches, or this exchange wins and the lifecycle transaction subsequently
    // revokes the session it just created. Without the row lock, a refresh token
    // created just after a revocation sweep could survive a lost-device revoke.
    const session =
      account !== null && outlet !== null && tokenHash !== null
        ? await app.prisma.$transaction(async (tx) => {
            const claimed = await tx.staffUser.updateMany({
              where: {
                id: account.id,
                outletTokenHash: tokenHash,
                tokenVersion: account.tokenVersion,
                status: 'ACTIVE',
                role: 'OUTLET_STAFF',
                authMethod: 'TOKEN',
                outletId: outlet.id,
              },
              data: { outletTokenLastUsedAt: new Date() },
            });
            if (claimed.count !== 1) return null;
            return issueOutletSession(account, tx);
          })
        : null;

    if (account === null || outlet === null || session === null) {
      await writeAudit(app.prisma, {
        action: 'auth.outlet.login.failure',
        subjectType: 'StaffUser',
        ...(account ? { subjectId: account.id } : {}),
        // Never the token or its hash, and deliberately one reason for a typo,
        // revoked device, closed outlet and missing record.
        metadata: { authMethod: 'TOKEN', reason: 'invalid_credentials' },
        ipAddress: request.ip,
      });
      return reply.code(401).send({
        error: 'sign_in_rejected',
        message: 'That token cannot be used to sign in here.',
      });
    }

    const { accessToken, refresh } = session;

    setRefreshCookie(reply, env, refresh.token, env.REFRESH_TOKEN_TTL_STAFF_SECONDS);

    await writeAudit(app.prisma, {
      action: 'auth.outlet.login.success',
      principal: { subjectId: account.id, subjectType: 'STAFF', role: 'OUTLET_STAFF' },
      subjectType: 'StaffUser',
      subjectId: account.id,
      metadata: { authMethod: 'TOKEN', outletId: outlet.id },
      ipAddress: request.ip,
    });

    return reply.code(200).send({
      accessToken,
      accessTokenExpiresIn: env.ACCESS_TOKEN_TTL_STAFF_DASHBOARD_SECONDS,
      // Retained for a native shell with a keystore. The browser ignores this
      // copy and uses the httpOnly cookie above, so it can resume a reload
      // without retaining either the refresh token or standing device token.
      refreshToken: refresh.token,
      outlet: { id: outlet.id, name: outlet.name },
    });
  });

  /** The signed-in outlet, or a 403. Every route below starts here. */
  function requireOutlet(request: { principal?: { subjectId: string; outletId?: string } }): {
    accountId: string;
    outletId: string;
  } {
    const principal = request.principal;
    if (!principal?.outletId) {
      // Unreachable for a resolved OUTLET_STAFF principal — resolvePrincipal
      // refuses one without an outlet. Kept because failing closed means not
      // assuming that check ran.
      throw new ForbiddenError();
    }
    return { accountId: principal.subjectId, outletId: principal.outletId };
  }

  // ── GET /outlet/me ───────────────────────────────────────────────────
  // What the screen shows in its header, and the answer to "am I still signed in".
  app.get('/outlet/me', { config: { permission: 'outlet:queue' } }, async (request) => {
    const { outletId } = requireOutlet(request);
    const outlet = await app.prisma.outlet.findUniqueOrThrow({
      where: { id: outletId },
      select: { id: true, name: true, kind: true },
    });
    return { outlet };
  });

  // ── GET /outlet/requests ─────────────────────────────────────────────
  //
  // The screen, and the Messages tab — one list, because the notice *is* the
  // message. Loading it marks what is on it as seen, which is the unread count
  // and the closest thing to a delivery receipt that does not depend on email.
  app.get('/outlet/requests', { config: { permission: 'outlet:queue' } }, async (request) => {
    // Called for the guard, not the value: the outlet filter comes from the scope
    // below rather than from a `where` clause written here.
    requireOutlet(request);
    const principal = request.principal;
    if (!principal) {
      throw new ForbiddenError();
    }

    const query = z
      .object({
        status: z.enum(['SENT', 'FULFILLED', 'NOT_USED']).optional(),
        limit: z.coerce.number().int().positive().optional(),
      })
      .strict()
      .parse(request.query);

    const status = query.status ?? 'SENT';
    const rows = await app.prisma.benefitRequest.findMany({
      where: scopedWhere({ status }, scopeForBenefitRequest(principal)),
      // Oldest first for open work — a list worked newest-first leaves the guest
      // who has been waiting longest at the bottom. Closed work reads as history,
      // so newest first.
      orderBy: status === 'SENT' ? { requestedAt: 'asc' } : { closedAt: 'desc' },
      take: Math.min(query.limit ?? 100, env.MEMBER_LIST_MAX_PAGE_SIZE),
      select: {
        id: true,
        status: true,
        requestedAt: true,
        note: true,
        seenAt: true,
        closedAt: true,
        closedReason: true,
        fulfilledAt: true,
        // The membership number and never the name (§9). Staff match the guest
        // against the card in their hand, which carries the same number.
        member: { select: { memberNumber: true } },
        benefit: {
          select: {
            id: true,
            key: true,
            title: true,
            discountPct: true,
            maxGuests: true,
            minGuests: true,
            terms: true,
          },
        },
      },
    });

    const unseen = rows.filter((row) => row.seenAt === null).map((row) => row.id);
    if (unseen.length > 0) {
      // Fire-and-forget would be tempting, but the count the screen shows next
      // time depends on this having landed. It is one indexed update.
      await app.prisma.benefitRequest.updateMany({
        where: { id: { in: unseen } },
        data: { seenAt: new Date() },
      });
    }

    return {
      requests: rows.map((row) => ({
        ...row,
        // Reported as it was *before* this call marked it, so the screen can
        // highlight what just arrived rather than showing everything as read.
        isNew: row.seenAt === null,
        benefit: { ...row.benefit, discountPct: String(row.benefit.discountPct) },
      })),
    };
  });

  // ── POST /outlet/requests/:id/confirm ────────────────────────────────
  // The guest turned up and was given the benefit. This is the only place a
  // notice becomes a redemption.
  app.post(
    '/outlet/requests/:id/confirm',
    { config: { permission: 'outlet:fulfil' } },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const body = confirmSchema.parse(request.body);
      const { outletId } = requireOutlet(request);
      const principal = request.principal;
      if (!principal) {
        throw new ForbiddenError();
      }

      // Scoped, so one outlet cannot confirm another's notice even holding its id.
      const notice = await app.prisma.benefitRequest.findFirst({
        where: scopedWhere({ id }, scopeForBenefitRequest(principal)),
        select: { id: true, status: true, memberId: true, benefitId: true },
      });
      if (!notice) {
        throw new NotFoundError();
      }
      if (notice.status !== 'SENT') {
        return reply.code(409).send({
          error: 'already_closed',
          message: 'This has already been dealt with.',
          status: notice.status,
        });
      }

      const result = await recordRedemption(app.prisma, principal, {
        memberId: notice.memberId,
        benefitId: notice.benefitId,
        // Never from the body. The outlet is whatever this account is bound to,
        // so a device cannot record a visit against somebody else's outlet.
        outletId,
        partySize: body.partySize,
        billAmountMinor: body.billAmountMinor,
        requestId: notice.id,
        idempotencyKey: body.idempotencyKey,
      });

      return sendRecordingResult(reply, request, principal, result, {
        auditAction: 'redemption.recorded.outlet',
        requestId: notice.id,
      });
    },
  );

  // ── POST /outlet/requests/:id/not-used ───────────────────────────────
  // They never came. Not a refusal: the entitlement is untouched and the guest
  // can announce themselves again whenever they like.
  app.post(
    '/outlet/requests/:id/not-used',
    { config: { permission: 'outlet:fulfil' } },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const body = notUsedSchema.parse(request.body ?? {});
      requireOutlet(request);
      const principal = request.principal;
      if (!principal) {
        throw new ForbiddenError();
      }

      const notice = await app.prisma.benefitRequest.findFirst({
        where: scopedWhere({ id }, scopeForBenefitRequest(principal)),
        select: {
          id: true,
          status: true,
          member: { select: { memberNumber: true, email: true, phone: true } },
          benefit: { select: { key: true, title: true } },
        },
      });
      if (!notice) {
        throw new NotFoundError();
      }

      // Conditional on still being SENT, so two people closing the same notice at
      // the same moment cannot both succeed — the second updates nothing and is
      // told so.
      const { count } = await app.prisma.benefitRequest.updateMany({
        where: { id: notice.id, status: 'SENT' },
        data: {
          status: 'NOT_USED',
          closedAt: new Date(),
          closedByUserId: principal.subjectId,
          closedReason: body.reason ?? null,
        },
      });

      if (count === 0) {
        return reply.code(409).send({
          error: 'already_closed',
          message: 'This has already been dealt with.',
        });
      }

      await writeAudit(app.prisma, {
        action: 'request.not_used',
        principal,
        subjectType: 'BenefitRequest',
        subjectId: notice.id,
        // Membership number, never the name (§9).
        metadata: {
          memberNumber: notice.member.memberNumber,
          benefitKey: notice.benefit.key,
          reason: body.reason ?? null,
        },
        ipAddress: request.ip,
      });

      const delivery = {
        email: notice.member.email,
        phone: notice.member.phone ?? '',
        purpose: 'request-not-used' as const,
        benefitTitle: notice.benefit.title,
        ...(body.reason ? { reason: body.reason } : {}),
      };
      logDeliveryOutcome(app.log, app.codeSender, delivery, await app.codeSender.send(delivery));

      return reply.code(200).send({ id: notice.id, status: 'NOT_USED' });
    },
  );

  // ── POST /outlet/resolve ─────────────────────────────────────────────
  //
  // The scan. Returns who the guest is and what the programme offers them, and
  // grants nothing (R10) — possession of a card code is never itself a discount.
  app.post('/outlet/resolve', { config: { permission: 'outlet:resolve' } }, async (request, reply) => {
    const body = resolveSchema.parse(request.body);
    const { accountId, outletId } = requireOutlet(request);
    const principal = request.principal;
    if (!principal) {
      throw new ForbiddenError();
    }

    // §5: "Rate limited hard: a handful of lookups per staff member per hour.
    // Membership numbers are sequential and printed on cards, so an unlimited
    // lookup endpoint is an enumeration tool."
    const limit = checkRateLimit(`resolve:account:${accountId}`, {
      windowSeconds: env.RATE_LIMIT_RESOLVE_WINDOW_SECONDS,
      max: env.RATE_LIMIT_RESOLVE_PER_ACCOUNT_MAX,
    });
    if (!limit.allowed) {
      throw new RateLimitedError(limit.retryAfterSeconds);
    }

    let memberId: string | undefined;
    let method: 'card' | 'rotating' | 'membership_number';

    if (body.payload !== undefined) {
      const result = verifyIdentityCode(body.payload, {
        windowHours: env.IDENTITY_CODE_WINDOW_HOURS,
      });
      if (result.ok) {
        memberId = result.memberRef;
        method = result.form;
      } else {
        method = 'card';
      }
    } else {
      method = 'membership_number';
    }

    // Exact match only. No `contains`, no `startsWith`, no case-insensitive fuzzy
    // matching — each of those turns this into a search endpoint.
    const member =
      memberId !== undefined
        ? await app.prisma.member.findUnique({
            where: { id: memberId },
            select: { id: true, memberNumber: true, fullName: true, status: true },
          })
        : await app.prisma.member.findUnique({
            where: { memberNumber: body.membershipNumber ?? '' },
            select: { id: true, memberNumber: true, fullName: true, status: true },
          });

    if (!member) {
      // §5: failed lookups against non-existent numbers are logged and alerted —
      // that pattern is somebody probing.
      await writeAudit(app.prisma, {
        action: 'verification.lookup.failure',
        principal,
        subjectType: 'Member',
        metadata: { method, outletId },
        ipAddress: request.ip,
      });
      return reply.code(404).send({ error: 'not_found', message: 'No matching member.' });
    }

    await writeAudit(app.prisma, {
      action: 'verification.lookup.success',
      principal,
      subjectType: 'Member',
      subjectId: member.id,
      // Which form was scanned is worth keeping: it tells the hotel whether the
      // printed card or the app is actually being used, and a sudden run of card
      // scans for one member is the shape a copied card would make.
      metadata: { method, outletId },
      ipAddress: request.ip,
    });

    // R4 — a suspended membership reaches nothing. Reported plainly rather than
    // as "not found", because the guest is standing there and staff need to be
    // able to say something true.
    if (member.status !== 'ACTIVE') {
      return reply.code(422).send({
        error: 'member_not_active',
        message: 'This membership is not active.',
        member: { memberNumber: member.memberNumber },
      });
    }

    const [benefits, openNotices, recentHere] = await Promise.all([
      app.prisma.benefit.findMany({
        where: { published: true },
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          key: true,
          title: true,
          discountPct: true,
          maxGuests: true,
          minGuests: true,
          terms: true,
          outletKind: true,
        },
      }),
      // Anything they already announced here, so staff confirm that row rather
      // than recording a second, unlinked visit for the same evening.
      app.prisma.benefitRequest.findMany({
        where: scopedWhere({ status: 'SENT' }, scopeForBenefitRequest(principal)),
        select: { id: true, benefitId: true },
      }),
      // Recent use at *this* outlet, so a member well outside a reasonable
      // pattern is visible at the counter. Scoped to this outlet — it is not a
      // window onto every outlet's history.
      app.prisma.redemption.findMany({
        where: scopedWhere({ memberId: member.id }, scopeForRedemption(principal)),
        orderBy: { occurredAt: 'desc' },
        take: 5,
        select: {
          id: true,
          occurredAt: true,
          partySize: true,
          benefit: { select: { title: true } },
        },
      }),
    ]);

    const outlet = await app.prisma.outlet.findUniqueOrThrow({
      where: { id: outletId },
      select: { kind: true },
    });

    return reply.code(200).send({
      // Bound to this account and this member, for a few minutes. Recording a
      // redemption requires it, which is what stops a device sending any member
      // id it likes.
      verificationSession: issueVerificationSession(accountId, member.id),
      verificationSessionExpiresIn: env.VERIFICATION_SESSION_TTL_SECONDS,
      member: {
        id: member.id,
        memberNumber: member.memberNumber,
        // The name is here, and only here. Staff have to be able to tell that the
        // card belongs to the person holding it — that is the whole point of a
        // counter check, and it is why this route is rate limited rather than
        // simply forbidden.
        fullName: member.fullName,
      },
      benefits: benefits
        // Only what this outlet can actually honour. Showing the spa's discount
        // on a restaurant screen invites somebody to record it there.
        .filter((benefit) => benefit.outletKind === null || benefit.outletKind === outlet.kind)
        .map((benefit) => ({
          ...benefit,
          discountPct: String(benefit.discountPct),
          openRequestId: openNotices.find((row) => row.benefitId === benefit.id)?.id ?? null,
        })),
      recentAtThisOutlet: recentHere,
    });
  });

  // ── POST /outlet/redemptions ─────────────────────────────────────────
  // The walk-up path: record a visit for a member just resolved by scan.
  app.post(
    '/outlet/redemptions',
    { config: { permission: 'outlet:fulfil' } },
    async (request, reply) => {
      const body = scanRecordSchema.parse(request.body);
      const { accountId, outletId } = requireOutlet(request);
      const principal = request.principal;
      if (!principal) {
        throw new ForbiddenError();
      }

      const session = verifyVerificationSession(body.verificationSession, {
        staffUserId: accountId,
        memberId: body.memberId,
        ttlSeconds: env.VERIFICATION_SESSION_TTL_SECONDS,
      });
      if (!session.ok) {
        // One shape for every reason. "Expired" versus "not bound" would tell a
        // caller probing member ids which ones they had recently resolved.
        return reply.code(422).send({
          error: 'verification_session_invalid',
          message: 'Scan the card again before recording this.',
        });
      }

      const result = await recordRedemption(app.prisma, principal, {
        memberId: body.memberId,
        benefitId: body.benefitId,
        outletId,
        partySize: body.partySize,
        billAmountMinor: body.billAmountMinor,
        idempotencyKey: body.idempotencyKey,
      });

      return sendRecordingResult(reply, request, principal, result, {
        auditAction: 'redemption.recorded.scan',
        requestId: null,
      });
    },
  );

  /**
   * The tail shared by both recording routes: map a failure, or audit, notify and
   * return. Written once because the two paths differ only in how they found the
   * member, and a response that varied by which one would be a difference nothing
   * catches.
   */
  async function sendRecordingResult(
    reply: FastifyReply,
    request: { ip: string },
    principal: Principal,
    result: RecordRedemptionResult,
    context: { auditAction: AuditAction; requestId: string | null },
  ) {
    if (!result.ok) {
      if (result.failure === 'not_found') {
        throw new NotFoundError();
      }
      return reply.code(FAILURE_STATUS[result.failure]).send({
        error: result.failure,
        message: result.message,
        ...(result.detail ?? {}),
      });
    }

    if (result.idempotent) {
      return reply.code(200).send({ ...serializeRecorded(result.redemption), idempotent: true });
    }

    await writeAudit(app.prisma, {
      action: context.auditAction,
      principal,
      subjectType: 'Redemption',
      subjectId: result.redemption.id,
      metadata: {
        benefitKey: result.benefit.key,
        outletId: result.redemption.outletId,
        partySize: result.redemption.partySize,
        fulfilledRequestId: context.requestId,
      },
      ipAddress: request.ip,
    });

    const delivery = {
      email: result.member.email,
      phone: result.member.phone ?? '',
      purpose: 'redemption-recorded' as const,
      benefitTitle: result.benefit.title,
      outletName: result.outlet.name,
      discountPct: String(result.redemption.discountPctApplied),
      savedMinor: savedMinor(result.redemption),
    };
    logDeliveryOutcome(app.log, app.codeSender, delivery, await app.codeSender.send(delivery));

    return reply.code(201).send({ ...serializeRecorded(result.redemption), idempotent: false });
  }
};

export default outletRoutes;
