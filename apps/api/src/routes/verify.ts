import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { ForbiddenError, NotFoundError, RateLimitedError } from '../errors.js';
import { writeAudit } from '../security/audit.js';
import { verifyIdentityCode } from '../security/identity-codes.js';
import { checkRateLimit } from '../security/rate-limit.js';
import {
  issueVerificationSession,
  verifyVerificationSession,
} from '../security/verification-session.js';
import { scopeForRedemption, scopedWhere } from '../security/scope.js';

/**
 * The staff verification page (wireframes screens 9, 10, D6).
 *
 * The system records that a benefit was used. It does not process the
 * discount — that stays on the hotel's existing till (product-definition.md
 * §6). Nothing here computes or applies money.
 */

const resolveSchema = z
  .object({
    // R12: an exact membership number or a scanned payload. Never a name,
    // never a partial match, never a wildcard — the membership must not be
    // enumerable or searchable (§5).
    payload: z.string().trim().min(1).max(500).optional(),
    membershipNumber: z.string().trim().min(1).max(32).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.payload) !== Boolean(value.membershipNumber), {
    message: 'Supply exactly one of payload or membershipNumber.',
  });

const recordSchema = z
  .object({
    // §5: the redemption must be bound to a verification session, so staff can
    // only act on a member they have just resolved at this outlet. Issued by
    // POST /verify/resolve.
    verificationSession: z.string().trim().min(1).max(500),
    memberId: z.string().uuid(),
    benefitId: z.string().uuid(),
    partySize: z.number().int().positive().optional(),
    // Minor units, integer. Never a float, and never computed here.
    billAmountMinor: z.number().int().min(0).optional(),
    // R8 — supplied by the client so a retried submission does not
    // double-record.
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

const reverseSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

const idParamSchema = z.object({ id: z.string().uuid() }).strict();

const verifyRoutes: FastifyPluginAsync = async (app) => {
  const env = app.env;

  // ── POST /verify/resolve ──────────────────────────────────────────────
  app.post('/verify/resolve', { config: { permission: 'verify:resolve' } }, async (request, reply) => {
    const body = resolveSchema.parse(request.body);
    const principal = request.principal;
    if (!principal) {
      throw new ForbiddenError();
    }

    // §5: "Rate limited hard: a handful of lookups per staff member per hour.
    // Membership numbers are sequential and printed on cards, so an unlimited
    // lookup endpoint is an enumeration tool."
    const limit = checkRateLimit(`verify:staff:${principal.subjectId}`, {
      windowSeconds: env.RATE_LIMIT_VERIFY_WINDOW_SECONDS,
      max: env.RATE_LIMIT_VERIFY_PER_STAFF_MAX,
    });
    if (!limit.allowed) {
      throw new RateLimitedError(limit.retryAfterSeconds);
    }

    let memberId: string | undefined;
    let lookupMethod: 'payload' | 'membership_number';

    if (body.payload) {
      lookupMethod = 'payload';
      const result = verifyIdentityCode(body.payload, {
        windowHours: env.IDENTITY_CODE_WINDOW_HOURS,
      });
      if (result.ok) {
        memberId = result.memberRef;
      }
    } else {
      lookupMethod = 'membership_number';
    }

    // Exact match only. No `contains`, no `startsWith`, no case-insensitive
    // fuzzy matching — each of those turns this into a search endpoint.
    const member =
      memberId !== undefined
        ? await app.prisma.member.findUnique({ where: { id: memberId } })
        : await app.prisma.member.findUnique({
            where: { memberNumber: body.membershipNumber ?? '' },
          });

    if (!member) {
      // §5: failed lookups against non-existent numbers are logged and
      // alerted — that pattern is someone probing.
      await writeAudit(app.prisma, {
        action: 'verification.lookup.failure',
        principal,
        subjectType: 'Member',
        metadata: { method: lookupMethod, outletId: principal.outletId ?? null },
        ipAddress: request.ip,
      });

      return reply.code(404).send({ error: 'not_found', message: 'No matching member.' });
    }

    await writeAudit(app.prisma, {
      action: 'verification.lookup.success',
      principal,
      subjectType: 'Member',
      subjectId: member.id,
      // Membership number only — never the name (§9).
      metadata: { method: lookupMethod, outletId: principal.outletId ?? null },
      ipAddress: request.ip,
    });

    // R10: this returns who the member is and what they are entitled to. It
    // applies nothing and changes nothing about the member.
    const benefits = await app.prisma.benefit.findMany({
      where: { published: true },
      orderBy: { sortOrder: 'asc' },
    });

    // Recent use at *this* outlet, so a member exceeding a reasonable pattern
    // is visible at the counter (wireframes screen 10 note 5). Scoped to the
    // staff member's own outlet — this is not a window onto every outlet.
    const recent = await app.prisma.redemption.findMany({
      where: scopedWhere({ memberId: member.id }, scopeForRedemption(principal)),
      orderBy: { occurredAt: 'desc' },
      take: 5,
      select: {
        id: true,
        partySize: true,
        occurredAt: true,
        benefit: { select: { key: true, title: true } },
        outlet: { select: { name: true } },
      },
    });

    return {
      // §5 — binds the next call to this member, at this outlet, for a few
      // minutes. POST /verify/redemptions will not accept a member id without
      // one, so staff cannot record against a member they never resolved.
      verificationSession: issueVerificationSession(principal.subjectId, member.id),
      verificationSessionExpiresIn: env.VERIFICATION_SESSION_TTL_SECONDS,
      member: {
        id: member.id,
        memberNumber: member.memberNumber,
        fullName: member.fullName,
        status: member.status,
        joinedAt: member.joinedAt,
        // Validity stated before anything else: a suspended membership must
        // be obvious at a glance, before staff begin applying a discount
        // (wireframes screen 10 note 1).
        valid: member.status === 'ACTIVE' && member.claimedAt !== null,
      },
      entitlements: benefits.map((benefit) => ({
        id: benefit.id,
        key: benefit.key,
        title: benefit.title,
        discountPct: String(benefit.discountPct),
        secondaryLabel: benefit.secondaryLabel,
        secondaryPct: benefit.secondaryPct === null ? null : String(benefit.secondaryPct),
        maxGuests: benefit.maxGuests,
        minGuests: benefit.minGuests,
        terms: benefit.terms,
      })),
      recentUse: recent,
    };
  });

  // ── POST /verify/redemptions ──────────────────────────────────────────
  app.post(
    '/verify/redemptions',
    { config: { permission: 'redemptions:record' } },
    async (request, reply) => {
      const body = recordSchema.parse(request.body);
      const principal = request.principal;
      if (!principal) {
        throw new ForbiddenError();
      }

      const outletId = principal.outletId;
      if (!outletId) {
        // An unattributed redemption record is worthless for both audit and
        // deterrence (§3). The Stage 1 CHECK constraint guarantees an
        // outlet_staff account has an outlet; an administrator recording
        // directly does not, and has no outlet to attribute it to.
        return reply.code(400).send({
          error: 'no_outlet',
          message: 'This account is not bound to an outlet.',
        });
      }

      // §5 — the session binds this call to a member this staff account
      // resolved moments ago at this outlet. Checked before anything is read,
      // so an unbound caller learns nothing about whether the ids exist.
      const session = verifyVerificationSession(body.verificationSession, {
        staffUserId: principal.subjectId,
        memberId: body.memberId,
        ttlSeconds: env.VERIFICATION_SESSION_TTL_SECONDS,
      });
      if (!session.ok) {
        return reply.code(403).send({
          error: 'verification_session_invalid',
          message: 'Resolve the member again before recording a benefit.',
        });
      }

      // R8 first for a *repeat* of a completed call: returning the original
      // is the correct answer to a retry, and must not depend on the rest of
      // the validation still passing. A benefit unpublished between the
      // original call and the retry must not turn a success into an error.
      //
      // Scoped to the caller's own outlet: the key is client-supplied, so an
      // unscoped lookup would let a guessed key disclose another outlet's
      // redemption.
      const existing = await app.prisma.redemption.findFirst({
        where: scopedWhere(
          { idempotencyKey: body.idempotencyKey },
          scopeForRedemption(principal),
        ),
        select: {
          id: true,
          memberId: true,
          benefitId: true,
          outletId: true,
          partySize: true,
          billAmountMinor: true,
          occurredAt: true,
        },
      });

      if (existing) {
        // Same key, different content is a client bug, not a retry — and
        // silently returning the original would hide it.
        if (existing.memberId !== body.memberId || existing.benefitId !== body.benefitId) {
          return reply.code(409).send({
            error: 'idempotency_key_reused',
            message: 'That idempotency key was used for a different redemption.',
          });
        }
        return reply.code(200).send({ ...existing, idempotent: true });
      }

      // Validation in the order BUILD-PLAN §Stage 7 specifies.

      // 1. Member exists and is ACTIVE (R4).
      const member = await app.prisma.member.findUnique({
        where: { id: body.memberId },
        select: { id: true, status: true, claimedAt: true },
      });
      if (!member) {
        throw new NotFoundError();
      }
      if (member.status !== 'ACTIVE') {
        return reply.code(422).send({
          error: 'member_not_active',
          message: 'This membership is not active.',
        });
      }

      // 2. Benefit exists and is published.
      const benefit = await app.prisma.benefit.findUnique({
        where: { id: body.benefitId },
        select: { id: true, key: true, published: true, maxGuests: true, minGuests: true },
      });
      if (!benefit || !benefit.published) {
        return reply.code(422).send({
          error: 'benefit_unavailable',
          message: 'That benefit is not available.',
        });
      }

      // 3. partySize <= maxGuests where set (R5).
      if (benefit.maxGuests !== null) {
        if (body.partySize === undefined) {
          return reply.code(422).send({
            error: 'party_size_required',
            message: 'Number of guests is required for this benefit.',
            maxGuests: benefit.maxGuests,
          });
        }
        if (body.partySize > benefit.maxGuests) {
          return reply.code(422).send({
            error: 'party_size_above_maximum',
            message: `This benefit allows a maximum of ${benefit.maxGuests} guests.`,
            maxGuests: benefit.maxGuests,
          });
        }
      }

      // 4. partySize >= minGuests where set (R6).
      if (benefit.minGuests !== null) {
        if (body.partySize === undefined) {
          return reply.code(422).send({
            error: 'party_size_required',
            message: 'Number of guests is required for this benefit.',
            minGuests: benefit.minGuests,
          });
        }
        if (body.partySize < benefit.minGuests) {
          return reply.code(422).send({
            error: 'party_size_below_minimum',
            message: `This benefit requires at least ${benefit.minGuests} guests.`,
            minGuests: benefit.minGuests,
          });
        }
      }

      // 5. Idempotency key unused — enforced by the unique index rather than
      //    by the check above, which can lose a race.
      let created;
      try {
        created = await app.prisma.redemption.create({
          data: {
            memberId: member.id,
            benefitId: benefit.id,
            outletId,
            staffUserId: principal.subjectId,
            partySize: body.partySize ?? null,
            billAmountMinor: body.billAmountMinor ?? null,
            idempotencyKey: body.idempotencyKey,
          },
          select: {
            id: true,
            memberId: true,
            benefitId: true,
            outletId: true,
            partySize: true,
            billAmountMinor: true,
            occurredAt: true,
          },
        });
      } catch (error) {
        // Two identical submissions in flight at once: the loser reads the
        // winner's row and returns it, which is what a retry should see.
        const raced = await app.prisma.redemption.findFirst({
          where: scopedWhere(
            { idempotencyKey: body.idempotencyKey },
            scopeForRedemption(principal),
          ),
          select: {
            id: true,
            memberId: true,
            benefitId: true,
            outletId: true,
            partySize: true,
            billAmountMinor: true,
            occurredAt: true,
          },
        });
        if (raced) {
          return reply.code(200).send({ ...raced, idempotent: true });
        }
        throw error;
      }

      await writeAudit(app.prisma, {
        action: 'redemption.recorded',
        principal,
        subjectType: 'Redemption',
        subjectId: created.id,
        metadata: {
          benefitKey: benefit.key,
          outletId,
          partySize: created.partySize,
        },
        ipAddress: request.ip,
      });

      return reply.code(201).send({ ...created, idempotent: false });
    },
  );

  // ── POST /admin/redemptions/:id/reverse ───────────────────────────────
  // R7: the original is never touched. A correction is a new row pointing at
  // it, attributed to whoever authorised it (wireframes D4 note 2).
  app.post(
    '/admin/redemptions/:id/reverse',
    { config: { permission: 'redemptions:reverse' } },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const body = reverseSchema.parse(request.body);
      const principal = request.principal;
      if (!principal) {
        throw new ForbiddenError();
      }

      const original = await app.prisma.redemption.findFirst({
        where: scopedWhere({ id }, scopeForRedemption(principal)),
        select: {
          id: true,
          memberId: true,
          benefitId: true,
          outletId: true,
          partySize: true,
          billAmountMinor: true,
          reversesId: true,
        },
      });
      if (!original) {
        throw new NotFoundError();
      }

      if (original.reversesId !== null) {
        return reply.code(409).send({
          error: 'already_a_reversal',
          message: 'A reversing entry cannot itself be reversed.',
        });
      }

      const alreadyReversed = await app.prisma.redemption.findUnique({
        where: { reversesId: original.id },
        select: { id: true },
      });
      if (alreadyReversed) {
        return reply.code(409).send({
          error: 'already_reversed',
          message: 'This redemption has already been reversed.',
        });
      }

      const reversal = await app.prisma.redemption.create({
        data: {
          memberId: original.memberId,
          benefitId: original.benefitId,
          outletId: original.outletId,
          staffUserId: principal.subjectId,
          partySize: original.partySize,
          // Negated so totals sum correctly without special-casing reversals
          // in every query. The Stage 1 CHECK constraint requires a reversal's
          // amount to be <= 0.
          billAmountMinor:
            original.billAmountMinor === null ? null : -original.billAmountMinor,
          idempotencyKey: body.idempotencyKey,
          reversesId: original.id,
        },
        select: {
          id: true,
          reversesId: true,
          billAmountMinor: true,
          occurredAt: true,
        },
      });

      await writeAudit(app.prisma, {
        action: 'redemption.reversed',
        principal,
        subjectType: 'Redemption',
        subjectId: original.id,
        metadata: { reversalId: reversal.id, reason: body.reason },
        ipAddress: request.ip,
      });

      return reply.code(201).send(reversal);
    },
  );

  // ── GET /admin/redemptions ────────────────────────────────────────────
  app.get('/admin/redemptions', { config: { permission: 'redemptions:list' } }, async (request) => {
    const query = z
      .object({
        limit: z.coerce.number().int().positive().optional(),
        offset: z.coerce.number().int().min(0).default(0),
        memberId: z.string().uuid().optional(),
        benefitId: z.string().uuid().optional(),
        outletId: z.string().uuid().optional(),
      })
      .strict()
      .parse(request.query);

    const principal = request.principal;
    if (!principal) {
      throw new NotFoundError();
    }

    const limit = Math.min(query.limit ?? 50, env.MEMBER_LIST_MAX_PAGE_SIZE);

    const where = scopedWhere(
      {
        ...(query.memberId ? { memberId: query.memberId } : {}),
        ...(query.benefitId ? { benefitId: query.benefitId } : {}),
        ...(query.outletId ? { outletId: query.outletId } : {}),
      },
      scopeForRedemption(principal),
    );

    const [total, redemptions] = await Promise.all([
      app.prisma.redemption.count({ where }),
      app.prisma.redemption.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: query.offset,
        take: limit,
        select: {
          id: true,
          partySize: true,
          billAmountMinor: true,
          occurredAt: true,
          reversesId: true,
          member: { select: { id: true, memberNumber: true, fullName: true } },
          benefit: { select: { key: true, title: true, discountPct: true } },
          outlet: { select: { id: true, name: true } },
          // Every entry names the staff member who recorded it — attribution
          // is the main deterrent against misuse (wireframes D4 note 2).
          staffUser: { select: { id: true, fullName: true } },
        },
      }),
    ]);

    return {
      total,
      limit,
      offset: query.offset,
      redemptions: redemptions.map((row) => ({
        ...row,
        benefit: { ...row.benefit, discountPct: String(row.benefit.discountPct) },
      })),
    };
  });

  // ── GET /member/me/redemptions ────────────────────────────────────────
  app.get(
    '/member/me/redemptions',
    { config: { permission: 'member:self' } },
    async (request) => {
      const principal = request.principal;
      if (!principal) {
        throw new NotFoundError();
      }

      // Scoped to the member's own history and nobody else's — the scope is
      // in the WHERE clause, not a filter applied afterwards.
      const redemptions = await app.prisma.redemption.findMany({
        where: scopedWhere({}, scopeForRedemption(principal)),
        orderBy: { occurredAt: 'desc' },
        take: 100,
        select: {
          id: true,
          partySize: true,
          occurredAt: true,
          reversesId: true,
          benefit: { select: { key: true, title: true, discountPct: true } },
          outlet: { select: { name: true } },
        },
      });

      return {
        redemptions: redemptions.map((row) => ({
          ...row,
          benefit: { ...row.benefit, discountPct: String(row.benefit.discountPct) },
        })),
      };
    },
  );
};

export default verifyRoutes;
