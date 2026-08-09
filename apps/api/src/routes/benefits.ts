import { Prisma } from '@prisma/client';
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

const percentageSchema = z
  .string()
  .trim()
  .regex(/^(?:\d{1,2}(?:\.\d{1,2})?|100(?:\.0{1,2})?)$/);

const outletKindSchema = z.enum(['DINING', 'SPA', 'ROOMS', 'EVENTS', 'OTHER']).nullable();

const benefitFields = {
  title: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100),
  // Decimal as a string all the way to the database: parsing a percentage
  // through a float is how 25 becomes 24.999999999999996.
  discountPct: percentageSchema,
  secondaryLabel: z.string().trim().min(1).max(200).nullable(),
  secondaryPct: percentageSchema.nullable(),
  childRules: z
    .record(
      z.string().trim().min(1).max(50),
      z.number().min(0).max(100).multipleOf(0.01),
    )
    .nullable(),
  maxGuests: z.number().int().positive().nullable(),
  minGuests: z.number().int().positive().nullable(),
  reservationPhone: z.string().trim().min(1).max(50).nullable(),
  terms: z.string().trim().min(1).max(5000),
  sortOrder: z.number().int().min(0).max(10_000),
};

const createBenefitSchema = z
  .object({
    key: z.string().trim().min(1).max(50).regex(/^[a-z0-9-]+$/),
    ...benefitFields,
    outletKind: outletKindSchema.optional().default(null),
    published: z.boolean().default(false),
  })
  .strict()
  .superRefine((benefit, context) => {
    if ((benefit.secondaryLabel === null) !== (benefit.secondaryPct === null)) {
      context.addIssue({
        code: 'custom',
        path: ['secondaryPct'],
        message: 'A secondary label and percentage must be supplied together.',
      });
    }
    if (
      benefit.minGuests !== null &&
      benefit.maxGuests !== null &&
      benefit.minGuests > benefit.maxGuests
    ) {
      context.addIssue({
        code: 'custom',
        path: ['minGuests'],
        message: 'Minimum guests cannot exceed maximum guests.',
      });
    }
  });

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
    outletKind: outletKindSchema.optional(),
    // Optional for compatibility with existing clients. Supplying it turns the
    // PATCH into a compare-and-swap: an intervening edit returns 409 instead of
    // silently overwriting the newer values.
    expectedVersion: z.number().int().positive().optional(),
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
        outletKind: benefit.outletKind,
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
        outletKind: body.outletKind,
        published: body.published,
        updatedByUserId: principal?.subjectId ?? null,
      },
      include: { updatedBy: { select: { id: true, fullName: true } } },
    });

    await writeAudit(app.prisma, {
      action: 'benefit.created',
      principal,
      subjectType: 'Benefit',
      subjectId: created.id,
      metadata: { key: created.key, version: created.version },
      ipAddress: request.ip,
    });

    return reply.code(201).send({
      id: created.id,
      ...toMemberView(created),
      published: created.published,
      outletKind: created.outletKind,
      version: created.version,
      updatedAt: created.updatedAt,
      updatedBy: created.updatedBy,
    });
  });

  // ── PATCH /admin/benefits/:id ─────────────────────────────────────────
  // The headline of the whole project: this is how 25% becomes 20%.
  app.patch('/admin/benefits/:id', { config: { permission: 'benefits:manage' } }, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const body = updateBenefitSchema.parse(request.body);
    const principal = request.principal;
    if (!principal) {
      throw new NotFoundError();
    }

    const existing = await app.prisma.benefit.findFirst({
      where: scopedWhere({ id }, scopeForBenefit(principal)),
      select: {
        id: true,
        key: true,
        version: true,
        discountPct: true,
        secondaryLabel: true,
        secondaryPct: true,
        minGuests: true,
        maxGuests: true,
      },
    });
    if (!existing) {
      throw new NotFoundError();
    }

    if (body.expectedVersion !== undefined && body.expectedVersion !== existing.version) {
      return reply.code(409).send({
        error: 'version_conflict',
        message: 'This benefit was changed by someone else. Refresh and try again.',
      });
    }

    const nextSecondaryLabel =
      body.secondaryLabel === undefined ? existing.secondaryLabel : body.secondaryLabel;
    const nextSecondaryPct =
      body.secondaryPct === undefined
        ? existing.secondaryPct === null
          ? null
          : String(existing.secondaryPct)
        : body.secondaryPct;
    z.object({
      secondaryLabel: benefitFields.secondaryLabel,
      secondaryPct: benefitFields.secondaryPct,
    })
      .refine(
        ({ secondaryLabel, secondaryPct }) =>
          (secondaryLabel === null) === (secondaryPct === null),
        {
          path: ['secondaryPct'],
          message: 'A secondary label and percentage must be supplied together.',
        },
      )
      .parse({ secondaryLabel: nextSecondaryLabel, secondaryPct: nextSecondaryPct });

    const nextMinGuests =
      body.minGuests === undefined ? existing.minGuests : body.minGuests;
    const nextMaxGuests =
      body.maxGuests === undefined ? existing.maxGuests : body.maxGuests;
    z.object({
      minGuests: benefitFields.minGuests,
      maxGuests: benefitFields.maxGuests,
    })
      .refine(
        ({ minGuests, maxGuests }) =>
          minGuests === null || maxGuests === null || minGuests <= maxGuests,
        { path: ['minGuests'], message: 'Minimum guests cannot exceed maximum guests.' },
      )
      .parse({ minGuests: nextMinGuests, maxGuests: nextMaxGuests });

    let updated;
    try {
      updated = await app.prisma.benefit.update({
        // Prisma's extended unique WHERE adds the version predicate to the
        // UPDATE itself. A read-then-compare here would still lose a race
        // between the comparison and the write.
        where: {
          id: existing.id,
          ...(body.expectedVersion !== undefined ? { version: body.expectedVersion } : {}),
        },
        data: {
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.category !== undefined ? { category: body.category } : {}),
          ...(body.discountPct !== undefined ? { discountPct: body.discountPct } : {}),
          ...(body.secondaryLabel !== undefined ? { secondaryLabel: body.secondaryLabel } : {}),
          ...(body.secondaryPct !== undefined ? { secondaryPct: body.secondaryPct } : {}),
          ...(body.childRules !== undefined
            ? { childRules: body.childRules === null ? Prisma.DbNull : body.childRules }
            : {}),
          ...(body.maxGuests !== undefined ? { maxGuests: body.maxGuests } : {}),
          ...(body.minGuests !== undefined ? { minGuests: body.minGuests } : {}),
          ...(body.reservationPhone !== undefined ? { reservationPhone: body.reservationPhone } : {}),
          ...(body.terms !== undefined ? { terms: body.terms } : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
          ...(body.outletKind !== undefined ? { outletKind: body.outletKind } : {}),
          // "Who changed the spa discount, and when" is a question that will be
          // asked (wireframes screen 14 note 3).
          version: { increment: 1 },
          updatedByUserId: principal.subjectId,
        },
        include: { updatedBy: { select: { id: true, fullName: true } } },
      });
    } catch (error) {
      if (
        body.expectedVersion !== undefined &&
        (error as { code?: unknown }).code === 'P2025'
      ) {
        return reply.code(409).send({
          error: 'version_conflict',
          message: 'This benefit was changed by someone else. Refresh and try again.',
        });
      }
      throw error;
    }

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
        // `expectedVersion` controls the write; it is not benefit content and
        // must not appear in the list of fields the administrator changed.
        changed: Object.keys(body).filter((field) => field !== 'expectedVersion'),
        ...(body.discountPct !== undefined
          ? { discountPctFrom: String(existing.discountPct), discountPctTo: body.discountPct }
          : {}),
      },
      ipAddress: request.ip,
    });

    return {
      id: updated.id,
      ...toMemberView(updated),
      published: updated.published,
      outletKind: updated.outletKind,
      version: updated.version,
      updatedAt: updated.updatedAt,
      updatedBy: updated.updatedBy,
    };
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
        include: { updatedBy: { select: { id: true, fullName: true } } },
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

      return {
        id: updated.id,
        ...toMemberView(updated),
        published: updated.published,
        outletKind: updated.outletKind,
        version: updated.version,
        updatedAt: updated.updatedAt,
        updatedBy: updated.updatedBy,
      };
    },
  );
};

export default benefitRoutes;
