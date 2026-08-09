import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { ForbiddenError, NotFoundError } from '../errors.js';
import { logDeliveryOutcome } from '../notifications/code-sender.js';
import { writeAudit } from '../security/audit.js';
import {
  scopeForBenefitRequest,
  scopeForBenefit,
  scopeForMember,
  scopedWhere,
} from '../security/scope.js';

/**
 * Benefit requests — the step between "a member wants the spa discount" and
 * "staff gave it to them".
 *
 * Two audiences, two views of the same row:
 *
 *   member        asks, and watches for a decision
 *   administrator sees what is waiting, approves or declines
 *
 * Nothing here applies a discount or touches money. An approval is permission
 * for a discount to be given; `POST /admin/redemptions` is still the only
 * thing that records it was.
 */

const createSchema = z
  .object({
    // The public key ("spa"), not the internal id. `GET /benefits` deliberately
    // never sends a member an id, and asking them to quote one back would mean
    // starting to.
    benefitKey: z.string().trim().min(1).max(64),
    // Advisory only. "Friday evening, four of us" helps whoever decides; no
    // rule reads it, and nothing downstream parses it.
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const decideSchema = z
  .object({
    // Shown to the member. A decline with no reason reads as an error rather
    // than a decision, and the member asks staff at the counter instead.
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const idParamSchema = z.object({ id: z.string().uuid() }).strict();

const queueQuerySchema = z
  .object({
    status: z.enum(['PENDING', 'APPROVED', 'DECLINED', 'FULFILLED']).optional(),
    limit: z.coerce.number().int().positive().optional(),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

/** What a member is shown about their own request. Never another member's. */
const MEMBER_VIEW = {
  id: true,
  status: true,
  requestedAt: true,
  note: true,
  decidedAt: true,
  decisionReason: true,
  fulfilledAt: true,
  benefit: { select: { key: true, title: true, discountPct: true } },
} as const;

function serializeForMember<T extends { benefit: { discountPct: unknown } }>(row: T) {
  return { ...row, benefit: { ...row.benefit, discountPct: String(row.benefit.discountPct) } };
}

const requestRoutes: FastifyPluginAsync = async (app) => {
  const env = app.env;

  // ── POST /member/me/requests ──────────────────────────────────────────
  // The member asks. This grants nothing.
  app.post(
    '/member/me/requests',
    { config: { permission: 'requests:create' } },
    async (request, reply) => {
      const body = createSchema.parse(request.body);
      const principal = request.principal;
      if (!principal) {
        throw new ForbiddenError();
      }

      // Published only, and through the scope rather than a `published: true`
      // written here — a member must not be able to request something that was
      // withdrawn, and the rule for what they can see already exists.
      const benefit = await app.prisma.benefit.findFirst({
        where: scopedWhere({ key: body.benefitKey }, scopeForBenefit(principal)),
        select: { id: true, key: true, title: true },
      });
      if (!benefit) {
        throw new NotFoundError();
      }

      // One open request per benefit. Without this a member tapping twice puts
      // two identical rows in the queue, and whoever is working through it
      // approves the same thing twice — which is exactly the double-redemption
      // the approval step exists to prevent.
      const open = await app.prisma.benefitRequest.findFirst({
        where: scopedWhere(
          { benefitId: benefit.id, status: { in: ['PENDING', 'APPROVED'] } },
          scopeForBenefitRequest(principal),
        ),
        select: { id: true, status: true },
      });
      if (open) {
        return reply.code(409).send({
          error: 'request_already_open',
          message:
            open.status === 'PENDING'
              ? 'You have already asked for this. It is waiting to be approved.'
              : 'This is already approved — show your membership number at the outlet.',
          requestId: open.id,
        });
      }

      const created = await app.prisma.benefitRequest.create({
        data: {
          memberId: principal.subjectId,
          benefitId: benefit.id,
          note: body.note ?? null,
        },
        select: MEMBER_VIEW,
      });

      const member = await app.prisma.member.findFirstOrThrow({
        where: scopedWhere({ id: principal.subjectId }, scopeForMember(principal)),
        select: { email: true, phone: true },
      });

      await writeAudit(app.prisma, {
        action: 'request.created',
        principal,
        subjectType: 'BenefitRequest',
        subjectId: created.id,
        metadata: { benefitKey: benefit.key },
        ipAddress: request.ip,
      });

      const delivery = {
        email: member.email,
        phone: member.phone ?? '',
        purpose: 'request-submitted' as const,
        benefitTitle: benefit.title,
      };
      logDeliveryOutcome(app.log, app.codeSender, delivery, await app.codeSender.send(delivery));

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

  // ── GET /admin/requests ───────────────────────────────────────────────
  // The queue. Defaults to what is waiting, because that is the only state
  // anyone opens this screen to act on.
  app.get('/admin/requests', { config: { permission: 'requests:read' } }, async (request) => {
    const query = queueQuerySchema.parse(request.query);
    const principal = request.principal;
    if (!principal) {
      throw new NotFoundError();
    }

    const limit = Math.min(query.limit ?? 50, env.MEMBER_LIST_MAX_PAGE_SIZE);
    const where = scopedWhere(
      { status: query.status ?? 'PENDING' },
      scopeForBenefitRequest(principal),
    );

    const [total, rows] = await Promise.all([
      app.prisma.benefitRequest.count({ where }),
      app.prisma.benefitRequest.findMany({
        where,
        // Oldest first: a queue worked newest-first leaves someone waiting
        // forever on a busy day.
        orderBy: { requestedAt: 'asc' },
        skip: query.offset,
        take: limit,
        select: {
          id: true,
          status: true,
          requestedAt: true,
          note: true,
          decidedAt: true,
          decisionReason: true,
          member: { select: { id: true, memberNumber: true, fullName: true, status: true } },
          benefit: { select: { id: true, key: true, title: true, discountPct: true } },
          decidedBy: { select: { fullName: true } },
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

  // ── POST /admin/requests/:id/approve ──────────────────────────────────
  // ── POST /admin/requests/:id/decline ──────────────────────────────────
  for (const decision of ['approve', 'decline'] as const) {
    const nextStatus = decision === 'approve' ? 'APPROVED' : 'DECLINED';

    app.post(
      `/admin/requests/:id/${decision}`,
      { config: { permission: 'requests:decide' } },
      async (request, reply) => {
        const { id } = idParamSchema.parse(request.params);
        const body = decideSchema.parse(request.body ?? {});
        const principal = request.principal;
        if (!principal) {
          throw new ForbiddenError();
        }

        const existing = await app.prisma.benefitRequest.findFirst({
          where: scopedWhere({ id }, scopeForBenefitRequest(principal)),
          select: {
            id: true,
            status: true,
            member: { select: { memberNumber: true, status: true, email: true, phone: true } },
            benefit: { select: { key: true, title: true } },
          },
        });
        if (!existing) {
          throw new NotFoundError();
        }

        if (existing.status !== 'PENDING') {
          return reply.code(409).send({
            error: 'already_decided',
            message: 'This request has already been dealt with.',
            status: existing.status,
          });
        }

        // R4 — a suspended membership reaches nothing. Checked here as well as
        // at redemption, so a suspended member never sits in an outlet's list
        // looking like a valid approval.
        if (decision === 'approve' && existing.member.status !== 'ACTIVE') {
          return reply.code(422).send({
            error: 'member_not_active',
            message: 'This membership is not active.',
          });
        }

        // Conditional on still being PENDING, so two administrators working
        // the queue at the same moment cannot both decide the same row — the
        // second updates nothing and is told so.
        const { count } = await app.prisma.benefitRequest.updateMany({
          where: { id: existing.id, status: 'PENDING' },
          data: {
            status: nextStatus,
            decidedAt: new Date(),
            decidedByUserId: principal.subjectId,
            decisionReason: body.reason ?? null,
          },
        });

        if (count === 0) {
          return reply.code(409).send({
            error: 'already_decided',
            message: 'This request has already been dealt with.',
          });
        }

        await writeAudit(app.prisma, {
          action: `request.${decision}d`,
          principal,
          subjectType: 'BenefitRequest',
          subjectId: existing.id,
          // Membership number, never the name (§9).
          metadata: {
            memberNumber: existing.member.memberNumber,
            benefitKey: existing.benefit.key,
            reason: body.reason ?? null,
          },
          ipAddress: request.ip,
        });

        const delivery = {
          email: existing.member.email,
          phone: existing.member.phone ?? '',
          purpose: decision === 'approve' ? ('request-approved' as const) : ('request-declined' as const),
          benefitTitle: existing.benefit.title,
          ...(body.reason ? { reason: body.reason } : {}),
        };
        logDeliveryOutcome(app.log, app.codeSender, delivery, await app.codeSender.send(delivery));

        return reply.code(200).send({ id: existing.id, status: nextStatus });
      },
    );
  }

};

export default requestRoutes;
