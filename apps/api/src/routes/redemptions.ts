import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { ForbiddenError, NotFoundError } from '../errors.js';
import { logDeliveryOutcome } from '../notifications/code-sender.js';
import { writeAudit } from '../security/audit.js';
import { scopeForBenefitRequest, scopeForRedemption, scopedWhere } from '../security/scope.js';

/**
 * Redemptions — the record that a benefit was given.
 *
 * There is no counter application. An administrator marks a benefit used from
 * the dashboard, either against an approval the member asked for or directly
 * for someone who simply turned up.
 *
 * The system records; it does not discount. The money stays on the hotel's own
 * till (product-definition.md §6), and nothing here computes or applies any.
 */

const recordSchema = z
  .object({
    memberId: z.string().uuid(),
    benefitId: z.string().uuid(),
    partySize: z.number().int().positive().optional(),
    // Minor units, integer. Never a float, and never computed here.
    billAmountMinor: z.number().int().min(0).optional(),
    // Which outlet gave it. Required, because an unattributed redemption is
    // worthless for both audit and deterrence (§3) — and whoever records this
    // is at a desk rather than standing in the outlet, so nothing else can
    // infer it. Not a uuid: outlet ids are readable slugs.
    outletId: z.string().trim().min(1).max(64),
    // The approval this redemption spends, where the member asked in advance.
    // Optional: someone who simply turned up is still served, and that path
    // records a redemption with no request behind it.
    requestId: z.string().uuid().optional(),
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

/**
 * What a recorded redemption returns.
 *
 * Written once because three call sites read it — the idempotent replay, the
 * creation, and the loser of a race — and a returned row that differs by which
 * path produced it is the kind of difference nothing catches.
 */
const RECORDED_SELECT = {
  id: true,
  memberId: true,
  benefitId: true,
  outletId: true,
  partySize: true,
  billAmountMinor: true,
  discountPctApplied: true,
  benefitVersion: true,
  occurredAt: true,
} as const;

/**
 * `Decimal` serialises as an object through JSON, so every percentage crossing
 * the wire is a string — the same shape the benefit endpoints already use.
 */
function serializeRecorded<T extends { discountPctApplied: unknown }>(
  row: T,
): Omit<T, 'discountPctApplied'> & { discountPctApplied: string } {
  return { ...row, discountPctApplied: String(row.discountPctApplied) };
}

/**
 * What a visit actually saved the member, in fils.
 *
 * The same arithmetic `reporting/metrics.ts` runs for the dashboard —
 * `billAmountMinor * discountPctApplied / 100`, rounded, in integer minor units
 * throughout, because money does not survive binary floating point. Stated
 * twice rather than shared because the dashboard's version is SQL executing
 * inside Postgres and this one is per row; the arithmetic is the contract and
 * a test holds them to it.
 *
 * Null when the bill was not captured. That is an ordinary outcome — recording
 * a redemption never required an amount — and it must stay distinguishable from
 * a genuine zero, so the member's screen can say "no amount recorded" rather
 * than claim they saved nothing.
 *
 * A reversal carries a negated bill, so its saving is negative and a total that
 * sums this column nets correctly without special-casing.
 *
 * `billAmountMinor` itself does not cross to the member. What they spent is the
 * hotel's record of a transaction; what they saved is theirs.
 */
function savedMinor(row: {
  billAmountMinor: number | null;
  discountPctApplied: unknown;
}): number | null {
  if (row.billAmountMinor === null) {
    return null;
  }

  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(String(row.discountPctApplied));
  if (!match) {
    throw new Error('Stored redemption percentage is invalid.');
  }

  // Convert the decimal percentage to integer basis points before touching
  // money. Besides avoiding binary floating-point drift (19.99 is not exactly
  // representable), this rounds negative reversal rows symmetrically with
  // PostgreSQL's numeric `round`: halves go away from zero in both directions.
  const basisPoints = BigInt(Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')));
  const signedMinor = BigInt(row.billAmountMinor);
  const magnitude = signedMinor < 0n ? -signedMinor : signedMinor;
  const rounded = (magnitude * basisPoints + 5_000n) / 10_000n;
  return Number(signedMinor < 0n ? -rounded : rounded);
}

const redemptionRoutes: FastifyPluginAsync = async (app) => {
  const env = app.env;

  // ── GET /admin/outlets ────────────────────────────────────────────────
  // The list to attribute a redemption to. Guarded by the recording permission
  // rather than a new one: this exists to serve that form and nothing else.
  app.get('/admin/outlets', { config: { permission: 'redemptions:record' } }, async () => {
    const outlets = await app.prisma.outlet.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, kind: true },
    });
    return { outlets };
  });

  // ── POST /admin/redemptions ───────────────────────────────────────────
  app.post(
    '/admin/redemptions',
    { config: { permission: 'redemptions:record' } },
    async (request, reply) => {
      const body = recordSchema.parse(request.body);
      const principal = request.principal;
      if (!principal) {
        throw new ForbiddenError();
      }

      // Administrators explicitly select the outlet. There is no counter or
      // outlet-bound account from which this could be inferred.
      const outletId = body.outletId;

      // R8 first for a *repeat* of a completed call: returning the original
      // is the correct answer to a retry, and must not depend on the rest of
      // the validation still passing. A benefit unpublished between the
      // original call and the retry must not turn a success into an error.
      //
      // Scoped: the key is client-supplied, so an unscoped lookup would let a
      // guessed key disclose a redemption the caller may not see.
      const existing = await app.prisma.redemption.findFirst({
        where: scopedWhere(
          { idempotencyKey: body.idempotencyKey },
          scopeForRedemption(principal),
        ),
        select: RECORDED_SELECT,
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
        return reply.code(200).send({ ...serializeRecorded(existing), idempotent: true });
      }

      // Validation in the order BUILD-PLAN §Stage 7 specifies.

      // 1. Member exists and is ACTIVE (R4).
      const member = await app.prisma.member.findUnique({
        where: { id: body.memberId },
        select: { id: true, status: true, claimedAt: true, email: true, phone: true },
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

      // 2. The outlet exists and is open. A redemption attributed to a closed
      //    or invented outlet corrupts every report grouped by outlet, and the
      //    foreign key alone would only catch the invented case.
      const outlet = await app.prisma.outlet.findUnique({
        where: { id: outletId },
        select: { id: true, active: true, name: true },
      });
      if (!outlet || !outlet.active) {
        return reply.code(422).send({
          error: 'outlet_unavailable',
          message: 'That outlet is not available.',
        });
      }

      // 3. Benefit exists and is published.
      const benefit = await app.prisma.benefit.findUnique({
        where: { id: body.benefitId },
        select: {
          id: true,
          key: true,
          title: true,
          published: true,
          maxGuests: true,
          minGuests: true,
          // Snapshotted onto the redemption below. Read here, inside the same
          // handler that writes the row, so the rate stored is the rate the
          // caps were checked against.
          discountPct: true,
          version: true,
        },
      });
      if (!benefit || !benefit.published) {
        return reply.code(422).send({
          error: 'benefit_unavailable',
          message: 'That benefit is not available.',
        });
      }

      // 4. partySize <= maxGuests where set (R5).
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

      // 5. partySize >= minGuests where set (R6).
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

      // 6. If this redemption spends an approval, the approval must be real,
      //    still unspent, and belong to this member and this benefit. Checked
      //    before the write so a bad reference never leaves a redemption
      //    recorded against nothing.
      if (body.requestId !== undefined) {
        const approval = await app.prisma.benefitRequest.findFirst({
          where: scopedWhere({ id: body.requestId }, scopeForBenefitRequest(principal)),
          select: { id: true, memberId: true, benefitId: true, status: true },
        });

        // A spent approval fails on status; a wrong one fails on the member or
        // benefit not matching. One message covers all three, so a guessed id
        // learns nothing about which requests exist.
        if (
          !approval ||
          approval.status !== 'APPROVED' ||
          approval.memberId !== member.id ||
          approval.benefitId !== benefit.id
        ) {
          return reply.code(422).send({
            error: 'approval_not_valid',
            message: 'That approval is not available for this member and benefit.',
          });
        }
      }

      // 7. Idempotency key unused — enforced by the unique index rather than
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
            // The rate this member was given, fixed here. Every figure derived
            // from this visit reads it back from this row and never from the
            // benefit, so an administrator exercising R14 tomorrow changes what
            // members are offered next — not what this one was given today.
            discountPctApplied: benefit.discountPct,
            benefitVersion: benefit.version,
            idempotencyKey: body.idempotencyKey,
          },
          select: RECORDED_SELECT,
        });
      } catch (error) {
        // Two identical submissions in flight at once: the loser reads the
        // winner's row and returns it, which is what a retry should see.
        const raced = await app.prisma.redemption.findFirst({
          where: scopedWhere(
            { idempotencyKey: body.idempotencyKey },
            scopeForRedemption(principal),
          ),
          select: RECORDED_SELECT,
        });
        if (raced) {
          return reply.code(200).send({ ...serializeRecorded(raced), idempotent: true });
        }
        throw error;
      }

      // Spend the approval. Conditional on it still being APPROVED, so two
      // administrators fulfilling the same one at the same moment cannot both
      // succeed — and the unique index on `redemptionId` is the backstop if
      // this check is ever removed.
      //
      // Deliberately after the redemption exists rather than before: a failure
      // here leaves an approval that looks unspent, which is recoverable from
      // the member's history. The reverse — an approval marked spent
      // with no redemption behind it — leaves the guest with no discount and no
      // way to ask for it again.
      if (body.requestId !== undefined) {
        await app.prisma.benefitRequest.updateMany({
          where: { id: body.requestId, status: 'APPROVED' },
          data: {
            status: 'FULFILLED',
            redemptionId: created.id,
            fulfilledAt: new Date(),
          },
        });
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
          fulfilledRequestId: body.requestId ?? null,
        },
        ipAddress: request.ip,
      });

      const delivery = {
        email: member.email,
        phone: member.phone ?? '',
        purpose: 'redemption-recorded' as const,
        benefitTitle: benefit.title,
        outletName: outlet.name,
        discountPct: String(created.discountPctApplied),
        savedMinor: savedMinor(created),
      };
      logDeliveryOutcome(app.log, app.codeSender, delivery, await app.codeSender.send(delivery));

      return reply.code(201).send({ ...serializeRecorded(created), idempotent: false });
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
          discountPctApplied: true,
          benefitVersion: true,
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
          // Copied from the row being reversed, never re-read from the benefit.
          // The negated amount only cancels the original if it is multiplied by
          // the same rate — re-reading a percentage that has changed since would
          // leave a residue behind in every total, and a reversal that does not
          // fully reverse is worse than none.
          discountPctApplied: original.discountPctApplied,
          benefitVersion: original.benefitVersion,
          idempotencyKey: body.idempotencyKey,
          reversesId: original.id,
        },
        select: {
          id: true,
          reversesId: true,
          billAmountMinor: true,
          discountPctApplied: true,
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

      return reply.code(201).send(serializeRecorded(reversal));
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
          // What this visit was given, not what the benefit offers today. The
          // benefit is still joined for its name; its percentage is not read.
          discountPctApplied: true,
          benefitVersion: true,
          occurredAt: true,
          reversesId: true,
          member: { select: { id: true, memberNumber: true, fullName: true } },
          benefit: { select: { key: true, title: true } },
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
      redemptions: redemptions.map(serializeRecorded),
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
          // The member's own record of what they were given. Reading the
          // benefit's current percentage here told them they had received 20%
          // on a visit where they received 25% — a number they can check
          // against a receipt, and the one place being wrong is least
          // forgivable.
          discountPctApplied: true,
          billAmountMinor: true,
          occurredAt: true,
          reversesId: true,
          benefit: { select: { key: true, title: true } },
          outlet: { select: { name: true } },
        },
      });

      return {
        redemptions: redemptions.map((row) => {
          const { billAmountMinor, ...rest } = row;
          return { ...serializeRecorded(rest), savedMinor: savedMinor(row) };
        }),
      };
    },
  );
};

export default redemptionRoutes;
