import type { Prisma } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { NotFoundError } from '../errors.js';
import { writeAudit } from '../security/audit.js';
import { generateClaimCode } from '../security/claim-codes.js';
import { normalizePhone } from '../security/phone.js';
import { revokeAllForSubject } from '../security/refresh-tokens.js';
import { scopeForMember, scopedWhere } from '../security/scope.js';

const createMemberSchema = z
  .object({
    fullName: z.string().trim().min(1).max(200),
    // Optional at creation: §8 has the member supply their phone when they
    // activate. Where the hotel already knows it, setting it here makes the
    // claim flow require a match rather than accept whatever is typed.
    phone: z.string().trim().min(1).max(32).optional(),
    email: z.string().trim().email().max(320).optional(),
  })
  .strict();

const updateMemberSchema = z
  .object({
    fullName: z.string().trim().min(1).max(200).optional(),
    phone: z.string().trim().min(1).max(32).nullable().optional(),
    email: z.string().trim().email().max(320).nullable().optional(),
  })
  .strict();

const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().optional(),
    offset: z.coerce.number().int().min(0).default(0),
    status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
    // "Members issued a card but never claimed the app" is a distinct,
    // reportable state — wireframes D3 note 3.
    claimed: z.enum(['true', 'false']).optional(),
  })
  .strict();

const idParamSchema = z.object({ id: z.string().uuid() }).strict();

/**
 * The administrator sees a claim code exactly once, at the moment it is
 * issued, to print on the invitation letter. Only its hash is stored, so it
 * cannot be shown again — losing it means issuing a new one via
 * `/resend-claim`, which is also what a member who lost their letter needs
 * (wireframes D4 note 5).
 */
function issueClaimCodeData(memberId: string, ttlHours: number) {
  const { plaintext, hash } = generateClaimCode();
  return {
    plaintext,
    row: {
      memberId,
      codeHash: hash,
      expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
    },
  };
}

const adminMemberRoutes: FastifyPluginAsync = async (app) => {
  const env = app.env;

  // ── POST /admin/members ───────────────────────────────────────────────
  // "New member" replaces public signup: an administrator creates the record
  // and issues a code (wireframes screen 11 note 1).
  app.post('/admin/members', { config: { permission: 'members:create' } }, async (request, reply) => {
    const body = createMemberSchema.parse(request.body);

    const created = await app.prisma.$transaction(async (tx) => {
      // R3: the membership number comes from a database sequence, so two
      // concurrent creates cannot collide on it.
      const [row] = await tx.$queryRaw<{ next_member_number: string }[]>`
        SELECT next_member_number()
      `;
      const memberNumber = row?.next_member_number;
      if (!memberNumber) {
        throw new Error('next_member_number() returned nothing.');
      }

      const member = await tx.member.create({
        data: {
          memberNumber,
          fullName: body.fullName,
          // Normalised on the way in, or one member is created as
          // +97455550003 and another as 55550003 and the unique index does not
          // notice they are the same person.
          phone: body.phone
            ? (normalizePhone(body.phone, {
                defaultCountryCode: env.DEFAULT_PHONE_COUNTRY_CODE,
              }) ?? body.phone)
            : null,
          email: body.email ?? null,
          status: 'ACTIVE',
          joinedAt: new Date(),
          createdByUserId: request.principal?.subjectId ?? '',
        },
      });

      const claim = issueClaimCodeData(member.id, env.CLAIM_CODE_TTL_HOURS);
      const claimCode = await tx.claimCode.create({ data: claim.row });

      return { member, claimCodePlaintext: claim.plaintext, expiresAt: claimCode.expiresAt };
    });

    await writeAudit(app.prisma, {
      action: 'member.created',
      principal: request.principal,
      subjectType: 'Member',
      subjectId: created.member.id,
      // Membership number, never the name (§9).
      metadata: { memberNumber: created.member.memberNumber },
      ipAddress: request.ip,
    });

    return reply.code(201).send({
      id: created.member.id,
      memberNumber: created.member.memberNumber,
      fullName: created.member.fullName,
      status: created.member.status,
      joinedAt: created.member.joinedAt,
      claimCode: {
        // Shown once. Not retrievable afterwards.
        code: created.claimCodePlaintext,
        expiresAt: created.expiresAt,
      },
    });
  });

  // ── GET /admin/members ────────────────────────────────────────────────
  // R11: this route exists only for roles holding `members:list`.
  // `outlet_staff` does not, so it is refused before any query is built.
  app.get('/admin/members', { config: { permission: 'members:list' } }, async (request) => {
    const query = listQuerySchema.parse(request.query);
    const principal = request.principal;
    if (!principal) {
      throw new NotFoundError();
    }

    // §8: pagination caps, so the endpoint cannot be coerced into returning
    // the full membership in one call.
    const limit = Math.min(query.limit ?? 25, env.MEMBER_LIST_MAX_PAGE_SIZE);

    const filters: Prisma.MemberWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.claimed === 'true' ? { claimedAt: { not: null } } : {}),
      ...(query.claimed === 'false' ? { claimedAt: null } : {}),
    };

    const where = scopedWhere(filters, scopeForMember(principal));

    const [total, members] = await Promise.all([
      app.prisma.member.count({ where }),
      app.prisma.member.findMany({
        where,
        orderBy: { memberNumber: 'asc' },
        skip: query.offset,
        take: limit,
        select: {
          id: true,
          memberNumber: true,
          fullName: true,
          // The contact number, so the dashboard can show who to actually ring.
          // Every role holding `members:list` — ADMINISTRATOR and MANAGER, and
          // no others — also holds `members:read`, whose detail route has
          // always returned `phone`. So this discloses nothing a caller could
          // not already retrieve one member at a time; it saves them a click per
          // member, which is the whole point of a list.
          //
          // It stops at the dashboard. The export path deliberately carries
          // membership numbers and no contact details at all (§12, asserted by
          // `reporting.test.ts`), because a spreadsheet leaves the building and
          // a screen behind an admin login does not.
          phone: true,
          status: true,
          joinedAt: true,
          claimedAt: true,
          _count: { select: { redemptions: true } },
          redemptions: {
            orderBy: { occurredAt: 'desc' },
            take: 1,
            select: { occurredAt: true },
          },
        },
      }),
    ]);

    await writeAudit(app.prisma, {
      action: 'member.listed',
      principal,
      subjectType: 'Member',
      metadata: { returned: members.length, total, filters: Object.keys(filters) },
      ipAddress: request.ip,
    });

    return {
      total,
      limit,
      offset: query.offset,
      members: members.map((member) => ({
        id: member.id,
        memberNumber: member.memberNumber,
        fullName: member.fullName,
        // Nullable in the schema: a member issued a card at the desk may not
        // have given a number yet, and that is a real state rather than missing
        // data. The dashboard says so rather than rendering an empty cell.
        phone: member.phone,
        status: member.status,
        joinedAt: member.joinedAt,
        // "Not claimed" is its own signal, distinct from "claimed but never
        // redeemed" — the two need different follow-up (wireframes D3 note 3).
        appClaimed: member.claimedAt !== null,
        totalUses: member._count.redemptions,
        lastUsedAt: member.redemptions[0]?.occurredAt ?? null,
      })),
    };
  });

  // ── GET /admin/members/:id ────────────────────────────────────────────
  app.get('/admin/members/:id', { config: { permission: 'members:read' } }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const principal = request.principal;
    if (!principal) {
      throw new NotFoundError();
    }

    const member = await app.prisma.member.findFirst({
      where: scopedWhere({ id }, scopeForMember(principal)),
      select: {
        id: true,
        memberNumber: true,
        fullName: true,
        phone: true,
        email: true,
        status: true,
        joinedAt: true,
        claimedAt: true,
        createdAt: true,
        consents: {
          orderBy: { recordedAt: 'desc' },
          select: { channel: true, granted: true, wordingVersion: true, recordedAt: true },
        },
        _count: { select: { redemptions: true } },
      },
    });

    if (!member) {
      throw new NotFoundError();
    }

    // §9: "Every member record viewed, and by whom." Wireframes D4 note 4
    // puts the notice on the screen too, because telling staff their viewing
    // is logged is a stronger control than the log alone.
    await writeAudit(app.prisma, {
      action: 'member.viewed',
      principal,
      subjectType: 'Member',
      subjectId: member.id,
      metadata: { memberNumber: member.memberNumber },
      ipAddress: request.ip,
    });

    const { consents, _count, ...fields } = member;

    return {
      ...fields,
      appClaimed: member.claimedAt !== null,
      totalUses: _count.redemptions,
      // Latest record per channel is the current state; the full history is
      // returned alongside it because consent rows are append-only and are
      // the evidence of what was agreed and when (§10, wireframes D4 note 3).
      consent: currentConsent(consents),
      consentHistory: consents,
    };
  });

  // ── PATCH /admin/members/:id ──────────────────────────────────────────
  app.patch('/admin/members/:id', { config: { permission: 'members:update' } }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const body = updateMemberSchema.parse(request.body);
    const principal = request.principal;
    if (!principal) {
      throw new NotFoundError();
    }

    // Scoped read first so an out-of-scope id is a 404 and never an update.
    const existing = await app.prisma.member.findFirst({
      where: scopedWhere({ id }, scopeForMember(principal)),
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundError();
    }

    const updated = await app.prisma.member.update({
      where: { id: existing.id },
      data: {
        ...(body.fullName !== undefined ? { fullName: body.fullName } : {}),
        ...(body.phone !== undefined
          ? {
              phone: body.phone
                ? (normalizePhone(body.phone, {
                    defaultCountryCode: env.DEFAULT_PHONE_COUNTRY_CODE,
                  }) ?? body.phone)
                : null,
            }
          : {}),
        ...(body.email !== undefined ? { email: body.email } : {}),
      },
      select: {
        id: true,
        memberNumber: true,
        fullName: true,
        phone: true,
        email: true,
        status: true,
      },
    });

    await writeAudit(app.prisma, {
      action: 'member.updated',
      principal,
      subjectType: 'Member',
      subjectId: updated.id,
      metadata: { memberNumber: updated.memberNumber, changed: Object.keys(body) },
      ipAddress: request.ip,
    });

    return updated;
  });

  // ── POST /admin/members/:id/suspend ───────────────────────────────────
  // R16: suspend, never delete. Deleting a member destroys the redemption
  // history the reporting depends on (wireframes D4 note 6).
  app.post(
    '/admin/members/:id/suspend',
    { config: { permission: 'members:suspend' } },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const principal = request.principal;
      if (!principal) {
        throw new NotFoundError();
      }

      const existing = await app.prisma.member.findFirst({
        where: scopedWhere({ id }, scopeForMember(principal)),
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundError();
      }

      const member = await app.prisma.$transaction(async (tx) => {
        const suspended = await tx.member.update({
          where: { id: existing.id },
          // §4 "Forced re-authentication" lists membership suspension among
          // the events that must invalidate outstanding access tokens.
          // Incrementing tokenVersion is that mechanism: a token issued
          // before this moment stops resolving even though it is still
          // correctly signed and unexpired.
          data: { status: 'SUSPENDED', tokenVersion: { increment: 1 } },
          select: { id: true, memberNumber: true, status: true },
        });

        return suspended;
      });

      // Access tokens die with the version bump above; refresh tokens are
      // server-side state and have to be revoked explicitly, or the member
      // could mint a fresh access token moments later.
      await revokeAllForSubject(app.prisma, existing.id, 'MEMBER');

      await writeAudit(app.prisma, {
        action: 'member.suspended',
        principal,
        subjectType: 'Member',
        subjectId: member.id,
        metadata: { memberNumber: member.memberNumber },
        ipAddress: request.ip,
      });

      return member;
    },
  );

  // ── POST /admin/members/:id/reinstate ─────────────────────────────────
  app.post(
    '/admin/members/:id/reinstate',
    { config: { permission: 'members:suspend' } },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const principal = request.principal;
      if (!principal) {
        throw new NotFoundError();
      }

      const existing = await app.prisma.member.findFirst({
        where: scopedWhere({ id }, scopeForMember(principal)),
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundError();
      }

      const reinstated = await app.prisma.member.update({
        where: { id: existing.id },
        data: { status: 'ACTIVE' },
        select: { id: true, memberNumber: true, status: true },
      });

      await writeAudit(app.prisma, {
        action: 'member.reinstated',
        principal,
        subjectType: 'Member',
        subjectId: reinstated.id,
        metadata: { memberNumber: reinstated.memberNumber },
        ipAddress: request.ip,
      });

      return reinstated;
    },
  );

  // ── POST /admin/members/:id/resend-claim ──────────────────────────────
  app.post(
    '/admin/members/:id/resend-claim',
    { config: { permission: 'members:issue-claim' } },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const principal = request.principal;
      if (!principal) {
        throw new NotFoundError();
      }

      const existing = await app.prisma.member.findFirst({
        where: scopedWhere({ id }, scopeForMember(principal)),
        select: { id: true, claimedAt: true },
      });
      if (!existing) {
        throw new NotFoundError();
      }

      if (existing.claimedAt !== null) {
        return reply
          .code(409)
          .send({ error: 'already_claimed', message: 'This membership has already been activated.' });
      }

      const claim = issueClaimCodeData(existing.id, env.CLAIM_CODE_TTL_HOURS);

      const issued = await app.prisma.$transaction(async (tx) => {
        // Supersede any outstanding code. Two live codes for one member would
        // mean a discarded first letter stayed usable after a replacement was
        // sent — precisely what single-use is meant to prevent.
        await tx.claimCode.updateMany({
          where: { memberId: existing.id, usedAt: null },
          data: { usedAt: new Date() },
        });

        return tx.claimCode.create({ data: claim.row });
      });

      await writeAudit(app.prisma, {
        action: 'member.claim_code_issued',
        principal,
        subjectType: 'Member',
        subjectId: existing.id,
        // Never the code itself, not even hashed.
        metadata: { expiresAt: issued.expiresAt.toISOString() },
        ipAddress: request.ip,
      });

      return reply.code(201).send({
        claimCode: { code: claim.plaintext, expiresAt: issued.expiresAt },
      });
    },
  );
};

interface ConsentRow {
  channel: 'EMAIL' | 'SMS';
  granted: boolean;
  wordingVersion: string;
  recordedAt: Date;
}

/**
 * Consent rows are append-only, so the current state is the most recent row
 * per channel. A withdrawal is a new row with `granted: false`, not an edit —
 * the history is the evidence (§10).
 */
export function currentConsent(rows: readonly ConsentRow[]): Record<string, ConsentRow | null> {
  const byChannel: Record<string, ConsentRow | null> = { EMAIL: null, SMS: null };

  for (const row of rows) {
    const current = byChannel[row.channel];
    if (!current || row.recordedAt > current.recordedAt) {
      byChannel[row.channel] = row;
    }
  }

  return byChannel;
}

export default adminMemberRoutes;
