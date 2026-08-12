import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { ForbiddenError, NotFoundError } from '../errors.js';
import { logDeliveryOutcome } from '../notifications/code-sender.js';
import {
  recordRedemption,
  savedMinor,
  serializeRecorded,
  type RecordRedemptionFailure,
} from '../redemptions/record.js';
import { writeAudit } from '../security/audit.js';
import { scopeForRedemption, scopedWhere } from '../security/scope.js';

/**
 * Redemptions — the record that a benefit was given, from the dashboard.
 *
 * Outlets record their own now (`routes/outlet.ts`), which is the normal path.
 * This one remains for the cases an outlet cannot cover: a visit somebody forgot
 * to confirm on the night, a correction, or a benefit given somewhere with no
 * screen. Both call the same `recordRedemption`, so the rules cannot drift.
 *
 * Reversal lives only here. An outlet may record what happened; unwinding it is
 * an administrator's decision (R7).
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
    // The notice this redemption closes out, where the guest announced in
    // advance. Optional: someone who simply turned up is still served, and that
    // path records a redemption with no notice behind it.
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

  /**
   * Maps a recording failure onto the HTTP shape this route has always returned.
   *
   * The status codes are the contract: 404 for a member that is not there, 409
   * for a reused idempotency key, 422 for everything the caller could fix.
   */
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

      // Administrators explicitly select the outlet. Unlike an outlet account,
      // whoever records this is at a desk rather than standing in the outlet, so
      // nothing else could infer it.
      const result = await recordRedemption(app.prisma, principal, {
        memberId: body.memberId,
        benefitId: body.benefitId,
        outletId: body.outletId,
        partySize: body.partySize,
        billAmountMinor: body.billAmountMinor,
        requestId: body.requestId,
        idempotencyKey: body.idempotencyKey,
      });

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
        return reply
          .code(200)
          .send({ ...serializeRecorded(result.redemption), idempotent: true });
      }

      await writeAudit(app.prisma, {
        action: 'redemption.recorded',
        principal,
        subjectType: 'Redemption',
        subjectId: result.redemption.id,
        metadata: {
          benefitKey: result.benefit.key,
          outletId: result.redemption.outletId,
          partySize: result.redemption.partySize,
          fulfilledRequestId: body.requestId ?? null,
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

      return reply
        .code(201)
        .send({ ...serializeRecorded(result.redemption), idempotent: false });
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
