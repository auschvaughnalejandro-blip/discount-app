import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { ForbiddenError, NotFoundError, RateLimitedError } from '../errors.js';
import { logDeliveryOutcome } from '../notifications/code-sender.js';
import { writeAudit } from '../security/audit.js';
import {
  scopeForBenefitRequest,
  scopeForBenefit,
  scopeForMember,
  scopedWhere,
} from '../security/scope.js';

/**
 * Benefit requests — the guest saying "I'm coming", and nothing more.
 *
 * ## What changed, and why the word "request" is now slightly wrong
 *
 * This used to be a petition: a member asked, an administrator approved or
 * declined, and only then could an outlet honour it. The client removed that
 * step. A Privilege Guest is entitled to every published benefit the moment they
 * join, so asking permission was asking for something they already had — and it
 * put a person in the middle of every single visit.
 *
 * So a row here is a **notice**. It is created already usable, addressed to one
 * outlet, and the only remaining question is whether the guest turns up. The
 * outlet answers that: `POST /outlet/requests/:id/confirm` records the visit,
 * `/not-used` records that it did not happen. Neither is permission.
 *
 * Nothing in this file applies a discount. Confirmation writes a `Redemption`,
 * and that is still the only record of a benefit having been given.
 *
 * Two audiences read these rows:
 *
 *   member        announces, and sees what happened
 *   administrator watches — read-only, because there is nothing left to decide
 *
 * The outlet's own view lives in `routes/outlet.ts`.
 */

const createSchema = z
  .object({
    // The public key ("spa"), not the internal id. `GET /benefits` deliberately
    // never sends a member an id, and asking them to quote one back would mean
    // starting to.
    benefitKey: z.string().trim().min(1).max(64),
    // Which outlet they are going to. Optional in the schema and required in
    // practice whenever more than one outlet honours the benefit — the handler
    // decides, because only it knows how many there are. A benefit is attached
    // to a *kind* of outlet and a hotel has several restaurants, so without this
    // "the outlet that was told" would be undefined.
    outletId: z.string().trim().min(1).max(64).optional(),
    // Advisory only. "Friday evening, four of us" helps whoever is on the door;
    // no rule reads it, and nothing downstream parses it.
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const queueQuerySchema = z
  .object({
    status: z.enum(['SENT', 'FULFILLED', 'NOT_USED', 'PENDING', 'APPROVED', 'DECLINED']).optional(),
    limit: z.coerce.number().int().positive().optional(),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

/** What a member is shown about their own notices. Never another member's. */
const MEMBER_VIEW = {
  id: true,
  status: true,
  requestedAt: true,
  note: true,
  closedAt: true,
  closedReason: true,
  fulfilledAt: true,
  benefit: { select: { key: true, title: true, discountPct: true } },
  outlet: { select: { id: true, name: true } },
} as const;

function serializeForMember<T extends { benefit: { discountPct: unknown } }>(row: T) {
  return { ...row, benefit: { ...row.benefit, discountPct: String(row.benefit.discountPct) } };
}

/**
 * Outlets that honour a given benefit.
 *
 * `Benefit.outletKind` is a kind, not an outlet, and null means "every outlet" —
 * the honest default for a benefit nobody has assigned, since a notice nobody can
 * see is worse than one visible too widely.
 */
export function outletsForBenefit(
  prisma: import('@prisma/client').PrismaClient,
  outletKind: import('@prisma/client').OutletKind | null,
) {
  return prisma.outlet.findMany({
    where: { active: true, ...(outletKind === null ? {} : { kind: outletKind }) },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, kind: true, notifyEmail: true },
  });
}

/**
 * Closes out notices nobody ever confirmed.
 *
 * Without this an outlet screen accumulates every guest who ever announced
 * themselves, and a member is left indefinitely looking at "we told them" for a
 * dinner four nights ago. `NOT_USED` is the honest ending: the entitlement was
 * never spent, so it remains available.
 *
 * Exported and called from a timer rather than a request handler, so no guest
 * ever waits on it. Returns the count so the caller can log something true.
 */
export async function expireStaleRequests(
  prisma: import('@prisma/client').PrismaClient,
  expiryHours: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - expiryHours * 60 * 60 * 1000);

  const { count } = await prisma.benefitRequest.updateMany({
    where: { status: 'SENT', requestedAt: { lt: cutoff } },
    data: {
      status: 'NOT_USED',
      closedAt: now,
      // No `closedByUserId`: nobody closed this, a clock did. Attributing it to
      // an account would put a person's name against an action they never took.
      closedReason: 'Not confirmed by the outlet within the expected window.',
    },
  });

  return count;
}

const requestRoutes: FastifyPluginAsync = async (app) => {
  const env = app.env;

  // ── POST /member/me/requests ──────────────────────────────────────────
  // The guest announces themselves. This grants nothing — it does not have to,
  // because they are already entitled.
  app.post(
    '/member/me/requests',
    { config: { permission: 'requests:create' } },
    async (request, reply) => {
      const body = createSchema.parse(request.body);
      const principal = request.principal;
      if (!principal) {
        throw new ForbiddenError();
      }

      // The anti-spam rule, as a database count rather than an in-memory bucket.
      //
      // `rate-limit.ts` would be one line, and would also reset on every deploy
      // and hold a separate allowance per process. Counting rows survives both,
      // and the index it needs — (memberId, requestedAt) — is already on the
      // table for the member's own history query.
      const throttleSince = new Date(Date.now() - env.REQUEST_THROTTLE_SECONDS * 1000);
      const recent = await app.prisma.benefitRequest.count({
        where: { memberId: principal.subjectId, requestedAt: { gte: throttleSince } },
      });
      if (recent > 0) {
        throw new RateLimitedError(env.REQUEST_THROTTLE_SECONDS);
      }

      // Published only, and through the scope rather than a `published: true`
      // written here — a member must not be able to announce something that was
      // withdrawn, and the rule for what they can see already exists.
      const benefit = await app.prisma.benefit.findFirst({
        where: scopedWhere({ key: body.benefitKey }, scopeForBenefit(principal)),
        select: { id: true, key: true, title: true, discountPct: true, outletKind: true },
      });
      if (!benefit) {
        throw new NotFoundError();
      }

      const candidates = await outletsForBenefit(app.prisma, benefit.outletKind);
      if (candidates.length === 0) {
        // Nothing to tell. Reported plainly rather than recorded against no
        // outlet, because a notice nobody receives is worse than a refusal the
        // guest can act on by asking at reception.
        return reply.code(422).send({
          error: 'no_outlet_available',
          message: 'No outlet is currently taking this benefit. Please ask at reception.',
        });
      }

      // One outlet: no need to ask. Several: the guest must say, or the notice
      // has no destination.
      let outlet = candidates.length === 1 ? candidates[0] : undefined;
      if (outlet === undefined) {
        if (body.outletId === undefined) {
          return reply.code(422).send({
            error: 'outlet_required',
            message: 'Choose where you are going.',
            outlets: candidates.map(({ id, name, kind }) => ({ id, name, kind })),
          });
        }
        outlet = candidates.find((row) => row.id === body.outletId);
        if (outlet === undefined) {
          // Chosen from a stale list, or an outlet that does not honour this
          // benefit. Same message either way — the guest's fix is identical.
          return reply.code(422).send({
            error: 'outlet_not_valid',
            message: 'That outlet is not taking this benefit.',
            outlets: candidates.map(({ id, name, kind }) => ({ id, name, kind })),
          });
        }
      } else if (body.outletId !== undefined && body.outletId !== outlet.id) {
        return reply.code(422).send({
          error: 'outlet_not_valid',
          message: 'That outlet is not taking this benefit.',
          outlets: candidates.map(({ id, name, kind }) => ({ id, name, kind })),
        });
      }

      // One open notice per benefit *per outlet*. Two identical rows would put
      // the same guest on one outlet's screen twice, and somebody would honour
      // both. Scoped to the outlet on purpose: announcing at the steakhouse and
      // then at the other restaurant is a different evening, not a duplicate.
      const open = await app.prisma.benefitRequest.findFirst({
        where: scopedWhere(
          { benefitId: benefit.id, outletId: outlet.id, status: 'SENT' },
          scopeForBenefitRequest(principal),
        ),
        select: { id: true },
      });
      if (open) {
        return reply.code(409).send({
          error: 'request_already_open',
          message: `${outlet.name} already knows you are coming. Just present your card.`,
          requestId: open.id,
        });
      }

      const created = await app.prisma.benefitRequest.create({
        data: {
          memberId: principal.subjectId,
          benefitId: benefit.id,
          outletId: outlet.id,
          note: body.note ?? null,
        },
        select: MEMBER_VIEW,
      });

      const member = await app.prisma.member.findFirstOrThrow({
        where: scopedWhere({ id: principal.subjectId }, scopeForMember(principal)),
        select: { email: true, phone: true, memberNumber: true },
      });

      await writeAudit(app.prisma, {
        action: 'request.created',
        principal,
        subjectType: 'BenefitRequest',
        subjectId: created.id,
        metadata: { benefitKey: benefit.key, outletId: outlet.id },
        ipAddress: request.ip,
      });

      // Tell the outlet. Best-effort by construction: the row already exists and
      // is already on the outlet's screen, so a mail failure costs a convenience
      // and not the visit. Recorded on the row so "we never heard" is answerable.
      const outletDelivery = {
        email: outlet.notifyEmail,
        purpose: 'outlet-request' as const,
        outletName: outlet.name,
        memberNumber: member.memberNumber,
        benefitTitle: benefit.title,
        discountPct: String(benefit.discountPct),
        ...(created.note ? { note: created.note } : {}),
        includeNote: env.OUTLET_NOTIFY_INCLUDE_NOTE,
      };
      const outletOutcome = await app.codeSender.send(outletDelivery);
      logDeliveryOutcome(app.log, app.codeSender, outletDelivery, outletOutcome);

      await app.prisma.benefitRequest.update({
        where: { id: created.id },
        data: {
          notifiedAt: new Date(),
          notifyStatus: outletOutcome.delivered ? 'delivered' : outletOutcome.reason,
        },
      });

      // And tell the guest there is nothing to wait for.
      const memberDelivery = {
        email: member.email,
        phone: member.phone ?? '',
        purpose: 'request-submitted' as const,
        benefitTitle: benefit.title,
        outletName: outlet.name,
      };
      logDeliveryOutcome(
        app.log,
        app.codeSender,
        memberDelivery,
        await app.codeSender.send(memberDelivery),
      );

      return reply.code(201).send(serializeForMember(created));
    },
  );

  // ── GET /member/me/requests ───────────────────────────────────────────
  app.get('/member/me/requests', { config: { permission: 'requests:create' } }, async (request) => {
    const principal = request.principal;
    if (!principal) {
      throw new NotFoundError();
    }

    const rows = await app.prisma.benefitRequest.findMany({
      where: scopedWhere({}, scopeForBenefitRequest(principal)),
      orderBy: { requestedAt: 'desc' },
      take: 50,
      select: MEMBER_VIEW,
    });

    return { requests: rows.map(serializeForMember) };
  });

  // ── GET /member/me/benefits/:key/outlets ──────────────────────────────
  // Where the guest can go for a benefit — the picker behind `outletId` above.
  // Guarded by the same permission as announcing, because that is the only thing
  // it exists to serve.
  app.get(
    '/member/me/benefits/:key/outlets',
    { config: { permission: 'requests:create' } },
    async (request) => {
      const { key } = z.object({ key: z.string().trim().min(1).max(64) }).strict().parse(request.params);
      const principal = request.principal;
      if (!principal) {
        throw new NotFoundError();
      }

      const benefit = await app.prisma.benefit.findFirst({
        where: scopedWhere({ key }, scopeForBenefit(principal)),
        select: { outletKind: true },
      });
      if (!benefit) {
        throw new NotFoundError();
      }

      const outlets = await outletsForBenefit(app.prisma, benefit.outletKind);
      // `notifyEmail` is an operational address and none of a member's business.
      return { outlets: outlets.map(({ id, name, kind }) => ({ id, name, kind })) };
    },
  );

  // ── GET /admin/requests ───────────────────────────────────────────────
  //
  // A monitor, not a queue. There is no approve or decline route any more: the
  // outlets close their own notices out, and an administrator watching this
  // screen is watching, not working. Defaults to SENT because that is what is
  // still in flight.
  app.get('/admin/requests', { config: { permission: 'requests:read' } }, async (request) => {
    const query = queueQuerySchema.parse(request.query);
    const principal = request.principal;
    if (!principal) {
      throw new NotFoundError();
    }

    const limit = Math.min(query.limit ?? 50, env.MEMBER_LIST_MAX_PAGE_SIZE);
    const where = scopedWhere(
      { status: query.status ?? 'SENT' },
      scopeForBenefitRequest(principal),
    );

    const [total, rows] = await Promise.all([
      app.prisma.benefitRequest.count({ where }),
      app.prisma.benefitRequest.findMany({
        where,
        // Oldest first: a list worked newest-first leaves someone waiting
        // forever on a busy day.
        orderBy: { requestedAt: 'asc' },
        skip: query.offset,
        take: limit,
        select: {
          id: true,
          status: true,
          requestedAt: true,
          note: true,
          seenAt: true,
          notifiedAt: true,
          notifyStatus: true,
          closedAt: true,
          closedReason: true,
          fulfilledAt: true,
          member: { select: { id: true, memberNumber: true, fullName: true, status: true } },
          benefit: { select: { id: true, key: true, title: true, discountPct: true } },
          outlet: { select: { id: true, name: true } },
          closedBy: { select: { fullName: true } },
        },
      }),
    ]);

    return {
      total,
      limit,
      offset: query.offset,
      requests: rows.map((row) => ({
        ...row,
        benefit: { ...row.benefit, discountPct: String(row.benefit.discountPct) },
      })),
    };
  });
};

export default requestRoutes;
