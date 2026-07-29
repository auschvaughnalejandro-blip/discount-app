import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { NotFoundError } from '../errors.js';
import { writeAudit } from '../security/audit.js';
import { scopeForBenefit, scopedWhere } from '../security/scope.js';

/**
 * R14 — every value a member sees is a database row, never a constant here.
 *
 * There is deliberately no default, no fallback and no seed value anywhere in
 * this file. Changing the dining discount from 25% to 20% is a PATCH against
 * the row and nothing else: no deployment, no code change, no restart. If a
 * percentage, guest cap, reservation number or terms string ever appears as a
 * literal in application code, the build has failed regardless of what else
 * works — which is why `benefits-are-data.test.ts` scans for exactly that.
 */

const benefitFields = {
  title: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100),
  // Decimal as a string all the way to the database: parsing a percentage
  // through a float is how 25 becomes 24.999999999999996.
  discountPct: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/),
  secondaryLabel: z.string().trim().max(200).nullable(),
  secondaryPct: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).nullable(),
  childRules: z.record(z.string(), z.number()).nullable(),
  maxGuests: z.number().int().positive().nullable(),
  minGuests: z.number().int().positive().nullable(),
  reservationPhone: z.string().trim().max(50).nullable(),
  terms: z.string().trim().max(5000),
  sortOrder: z.number().int(),
};

const createBenefitSchema = z
  .object({
    key: z.string().trim().min(1).max(50).regex(/^[a-z0-9-]+$/),
    ...benefitFields,
    published: z.boolean().default(false),
  })
  .strict();

const updateBenefitSchema = z
  .object({
    title: benefitFields.title.optional(),
    category: benefitFields.category.optional(),
    discountPct: benefitFields.discountPct.optional(),
    secondaryLabel: benefitFields.secondaryLabel.optional(),
    secondaryPct: benefitFields.secondaryPct.optional(),
    childRules: benefitFields.childRules.optional(),
    maxGuests: benefitFields.maxGuests.optional(),
    minGuests: benefitFields.minGuests.optional(),
    reservationPhone: benefitFields.reservationPhone.optional(),
    terms: benefitFields.terms.optional(),
    sortOrder: benefitFields.sortOrder.optional(),
  })
  .strict();

const publishSchema = z.object({ published: z.boolean() }).strict();
const idParamSchema = z.object({ id: z.string().uuid() }).strict();

/** Shape sent to a member. Internal bookkeeping stays internal. */
function toMemberView(benefit: {
  key: string;
  title: string;
  category: string;
  discountPct: unknown;
  secondaryLabel: string | null;
  secondaryPct: unknown;
  childRules: unknown;
  maxGuests: number | null;
  minGuests: number | null;
  reservationPhone: string | null;
  terms: string;
  sortOrder: number;
}) {
  return {
    key: benefit.key,
    title: benefit.title,
    category: benefit.category,
    discountPct: String(benefit.discountPct),
    secondaryLabel: benefit.secondaryLabel,
    secondaryPct: benefit.secondaryPct === null ? null : String(benefit.secondaryPct),
    childRules: benefit.childRules ?? null,
    maxGuests: benefit.maxGuests,
    minGuests: benefit.minGuests,
    reservationPhone: benefit.reservationPhone,
    terms: benefit.terms,
    sortOrder: benefit.sortOrder,
  };
}

const benefitRoutes: FastifyPluginAsync = async (app) => {
  // ── GET /benefits ─────────────────────────────────────────────────────
  // Member-facing. Published only — an unpublished benefit is invisible here,
  // enforced in the WHERE clause rather than by filtering afterwards.
  app.get('/benefits', { config: { permission: 'benefits:read-published' } }, async (request) => {
    const principal = request.principal;
    if (!principal) {
      throw new NotFoundError();
    }

    const benefits = await app.prisma.benefit.findMany({
      where: scopedWhere({}, scopeForBenefit(principal)),
      orderBy: { sortOrder: 'asc' },
    });

    return { benefits: benefits.map(toMemberView) };
  });

  // ── GET /admin/benefits ───────────────────────────────────────────────
  app.get('/admin/benefits', { config: { permission: 'benefits:read-all' } }, async (request) => {
    const principal = request.principal;
    if (!principal) {
      throw new NotFoundError();
    }

    const benefits = await app.prisma.benefit.findMany({
      where: scopedWhere({}, scopeForBenefit(principal)),
      orderBy: { sortOrder: 'asc' },
      include: { updatedBy: { select: { id: true, fullName: true } } },
    });

    return {
      benefits: benefits.map((benefit) => ({
        id: benefit.id,
        ...toMemberView(benefit),
        published: benefit.published,
        version: benefit.version,
        updatedAt: benefit.updatedAt,
        updatedBy: benefit.updatedBy,
      })),
    };
  });

  // ── POST /admin/benefits ──────────────────────────────────────────────
  app.post('/admin/benefits', { config: { permission: 'benefits:manage' } }, async (request, reply) => {
    const body = createBenefitSchema.parse(request.body);
    const principal = request.principal;

    const created = await app.prisma.benefit.create({
      data: {
        key: body.key,
        title: body.title,
        category: body.category,
        discountPct: body.discountPct,
        secondaryLabel: body.secondaryLabel,
        secondaryPct: body.secondaryPct,
        ...(body.childRules === null ? {} : { childRules: body.childRules }),
        maxGuests: body.maxGuests,
        minGuests: body.minGuests,
        reservationPhone: body.reservationPhone,
        terms: body.terms,
        sortOrder: body.sortOrder,
        published: body.published,
        updatedByUserId: principal?.subjectId ?? null,
      },
    });

    await writeAudit(app.prisma, {
      action: 'benefit.created',
      principal,
      subjectType: 'Benefit',
      subjectId: created.id,
      metadata: { key: created.key, version: created.version },
      ipAddress: request.ip,
    });

    return reply.code(201).send({ id: created.id, ...toMemberView(created), version: created.version });
  });

  // ── PATCH /admin/benefits/:id ─────────────────────────────────────────
  // The headline of the whole project: this is how 25% becomes 20%.
  app.patch('/admin/benefits/:id', { config: { permission: 'benefits:manage' } }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const body = updateBenefitSchema.parse(request.body);
    const principal = request.principal;
    if (!principal) {
      throw new NotFoundError();
    }

    const existing = await app.prisma.benefit.findFirst({
      where: scopedWhere({ id }, scopeForBenefit(principal)),
      select: { id: true, key: true, version: true, discountPct: true },
    });
    if (!existing) {
      throw new NotFoundError();
    }

    const updated = await app.prisma.benefit.update({
      where: { id: existing.id },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.category !== undefined ? { category: body.category } : {}),
        ...(body.discountPct !== undefined ? { discountPct: body.discountPct } : {}),
        ...(body.secondaryLabel !== undefined ? { secondaryLabel: body.secondaryLabel } : {}),
        ...(body.secondaryPct !== undefined ? { secondaryPct: body.secondaryPct } : {}),
        ...(body.childRules !== undefined && body.childRules !== null
          ? { childRules: body.childRules }
          : {}),
        ...(body.maxGuests !== undefined ? { maxGuests: body.maxGuests } : {}),
        ...(body.minGuests !== undefined ? { minGuests: body.minGuests } : {}),
        ...(body.reservationPhone !== undefined ? { reservationPhone: body.reservationPhone } : {}),
        ...(body.terms !== undefined ? { terms: body.terms } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
        // "Who changed the spa discount, and when" is a question that will be
        // asked (wireframes screen 14 note 3).
        version: { increment: 1 },
        updatedByUserId: principal.subjectId,
      },
    });

    await writeAudit(app.prisma, {
      action: 'benefit.updated',
      principal,
      subjectType: 'Benefit',
      subjectId: updated.id,
      // Records what changed, including the before/after of the value most
      // likely to be disputed. No member data is involved.
      metadata: {
        key: updated.key,
        version: updated.version,
        changed: Object.keys(body),
        ...(body.discountPct !== undefined
          ? { discountPctFrom: String(existing.discountPct), discountPctTo: body.discountPct }
          : {}),
      },
      ipAddress: request.ip,
    });

    return { id: updated.id, ...toMemberView(updated), published: updated.published, version: updated.version };
  });

  // ── POST /admin/benefits/:id/publish ──────────────────────────────────
  app.post(
    '/admin/benefits/:id/publish',
    { config: { permission: 'benefits:manage' } },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const body = publishSchema.parse(request.body);
      const principal = request.principal;
      if (!principal) {
        throw new NotFoundError();
      }

      const existing = await app.prisma.benefit.findFirst({
        where: scopedWhere({ id }, scopeForBenefit(principal)),
        select: { id: true, key: true },
      });
      if (!existing) {
        throw new NotFoundError();
      }

      const updated = await app.prisma.benefit.update({
        where: { id: existing.id },
        data: {
          published: body.published,
          version: { increment: 1 },
          updatedByUserId: principal.subjectId,
        },
      });

      await writeAudit(app.prisma, {
        action: body.published ? 'benefit.published' : 'benefit.unpublished',
        principal,
        subjectType: 'Benefit',
        subjectId: updated.id,
        metadata: { key: updated.key, version: updated.version },
        ipAddress: request.ip,
      });

      // TODO(open-question): wireframes screen 14 note 4 says publishing
      // triggers member notification, "and only to members who consented to
      // that channel". No email or SMS provider is specified anywhere in the
      // reference documents — the same gap as PROGRESS.md Q6. Consent state
      // is already recorded per channel and ready to be read when one exists.

      return { id: updated.id, published: updated.published, version: updated.version };
    },
  );
};

export default benefitRoutes;
