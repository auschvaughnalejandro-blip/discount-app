import type { Prisma } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { NotFoundError, RateLimitedError } from '../errors.js';
import { logDeliveryOutcome } from '../notifications/code-sender.js';
import { toCsv } from '../reporting/csv.js';
import { writeAudit } from '../security/audit.js';
import { generateClaimCode } from '../security/claim-codes.js';
import { issueCardCode } from '../security/identity-codes.js';
import { normalizePhone } from '../security/phone.js';
import { checkRateLimit } from '../security/rate-limit.js';
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

const cardExportQuerySchema = z
  .object({
    status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
    // A top-up print run: the members added since the last batch went to the
    // bureau, rather than re-exporting — and paying to reprint — the whole
    // membership every time.
    since: z.string().datetime().optional(),
  })
  .strict();

/**
 * A print run is not a report: truncating one silently means a member who never
 * receives a card, discovered weeks later at a counter. So the export refuses
 * past this rather than returning a partial file, and says how to narrow it.
 */
const CARD_EXPORT_MAX_ROWS = 5000;

/**
 * The invitation code exists in plaintext for exactly as long as it takes to
 * email it. Only its hash is stored, so it cannot be produced again — a member
 * who never received one needs `/resend-claim`, which supersedes the old code
 * so a stray copy stops working (wireframes D4 note 5).
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
    const principal = request.principal;
    if (!principal) {
      throw new NotFoundError();
    }

    /**
     * A membership nobody can activate is not a membership.
     *
     * Sign-in passcodes go out over the configured delivery channel, and the
     * member does not supply their own address until *after* the first one has
     * been sent — so where that channel is email, a record created without one
     * is permanently unactivatable. The failure would otherwise surface at the
     * guest's first attempt, days later, with nothing on the administrator's
     * screen having suggested a problem.
     *
     * Conditional on the channel rather than absolute: on 'none' (development,
     * where the terminal echo stands in) an email is genuinely optional, and
     * requiring one there would be a rule with no reason behind it.
     */
    if (env.OTP_DELIVERY_CHANNEL === 'smtp' && !body.email) {
      return reply.code(400).send({
        error: 'email_required',
        message:
          'An email address is required: sign-in passcodes are delivered by email, ' +
          'and this member could not otherwise activate the app.',
      });
    }

    /**
     * A phone number belongs to one membership. Checked here so the answer is
     * useful — the number, and which membership already holds it — rather than
     * arriving as an unmapped constraint violation and a 500.
     *
     * Naming the other membership is not a disclosure: the caller holds
     * `members:list` and can already see every one of them. It is the
     * difference between "that failed" and "you already created them".
     */
    const normalizedPhone = body.phone
      ? (normalizePhone(body.phone, { defaultCountryCode: env.DEFAULT_PHONE_COUNTRY_CODE }) ??
        body.phone)
      : null;

    if (normalizedPhone) {
      // `findFirst` with the scope rather than `findUnique`, which cannot take
      // a composed where. The scope is empty for both roles that hold
      // members:create, so this restricts nothing today — but it is written the
      // way every other read is, so a narrower role added later inherits the
      // restriction instead of quietly bypassing it.
      const taken = await app.prisma.member.findFirst({
        where: scopedWhere({ phone: normalizedPhone }, scopeForMember(principal)),
        select: { memberNumber: true, fullName: true },
      });
      if (taken) {
        return reply.code(409).send({
          error: 'phone_already_used',
          message: `${taken.memberNumber} (${taken.fullName}) already uses that mobile number.`,
          memberNumber: taken.memberNumber,
        });
      }
    }

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
          // Normalised above, or one member is created as +97455550003 and
          // another as 55550003 and the unique index does not notice they are
          // the same person.
          phone: normalizedPhone,
          email: body.email ?? null,
          status: 'ACTIVE',
          joinedAt: new Date(),
          createdByUserId: principal.subjectId,
        },
      });

      const claim = issueClaimCodeData(member.id, env.CLAIM_CODE_TTL_HOURS);
      const claimCode = await tx.claimCode.create({ data: claim.row });

      return { member, claimCodePlaintext: claim.plaintext, expiresAt: claimCode.expiresAt };
    });

    /**
     * Send the invitation, and hand the code back to the administrator only if
     * it did not go.
     *
     * In the normal case nobody at the hotel ever sees a credential belonging
     * to a member: the invitation lands in their inbox, and passcodes were
     * already going straight to them. Where delivery fails the code is returned
     * so the membership is not stranded — an administrator reading it off a
     * screen is a worse position than not, but a member who can never activate
     * is worse still.
     */
    const delivery = {
      email: created.member.email,
      phone: created.member.phone ?? '',
      code: created.claimCodePlaintext,
      purpose: 'invitation' as const,
      validFor: `${Math.round(env.CLAIM_CODE_TTL_HOURS / 24)} days`,
    };
    const outcome = await app.codeSender.send(delivery);
    logDeliveryOutcome(app.log, app.codeSender, delivery, outcome);

    await writeAudit(app.prisma, {
      action: 'member.created',
      principal,
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
        // Returned only when the member could not be reached. Stored as a hash
        // either way, so this is the one moment it exists in plaintext.
        ...(outcome.delivered ? {} : { code: created.claimCodePlaintext }),
        expiresAt: created.expiresAt,
      },
      invitation: outcome.delivered
        ? { sent: true, to: created.member.email }
        : { sent: false, reason: outcome.reason },
    });
  });

  // ── GET /admin/members ────────────────────────────────────────────────
  // This route exists only for the Administrator permission set. Retired
  // historical staff roles are refused before any query is built.
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
          // ADMINISTRATOR also holds `members:read`, whose detail route has
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

  /**
   * ── GET /admin/members/card-export ────────────────────────────────────
   *
   * The file the card bureau prints from: membership number, name, card code.
   *
   * Registered before `/admin/members/:id`, though it need not be — find-my-way
   * matches a static segment ahead of a parametric one regardless of order, and
   * `card-export` is not a UUID so it would 400 rather than leak. Stated here so
   * a later reorder is not mistaken for a fix.
   *
   * ## This file carries names, and the redemption export deliberately does not
   *
   * `reports.ts` exports membership numbers and no names at all — §12, asserted
   * by `reporting.test.ts`, on the reasoning that a spreadsheet leaves the
   * building and a screen behind an admin login does not. That rule is right and
   * it is not being relaxed: this is a second file that cannot obey it, because
   * **the name is the thing being printed**. A card export without names
   * produces blank cards.
   *
   * So the disclosure is narrowed everywhere else instead:
   *
   *   - Its own permission (`members:export-cards`), so holding `reports:export`
   *     never implies this and a future narrower role can be given one alone.
   *   - Three columns and no contact details. The bureau needs to print a card;
   *     it does not need a phone number or an email address, and §12's objection
   *     is to a ready-made contact list more than to a name.
   *   - The same rate limit bucket size as the report export — a handful a day,
   *     for an action that should never be routine.
   *   - Audited by row count, so "who took the membership list" is answerable.
   *
   * ## On putting card codes in a file
   *
   * `identity-codes.ts` argues a static code is acceptable because it identifies
   * and grants nothing — no weaker than the membership number already printed in
   * plain text on the front of the same card. That argument holds per-code and
   * it holds here, but a file of every code at once is still a bigger object
   * than any one of them, which is what the guards above are for. If the code
   * ever becomes worth something on its own, this route and that file have to be
   * revisited together.
   */
  app.get(
    '/admin/members/card-export',
    { config: { permission: 'members:export-cards' } },
    async (request, reply) => {
      const query = cardExportQuerySchema.parse(request.query);
      const principal = request.principal;
      if (!principal) {
        throw new NotFoundError();
      }

      const limit = checkRateLimit(`card-export:${principal.subjectId}`, {
        windowSeconds: env.RATE_LIMIT_EXPORT_WINDOW_SECONDS,
        max: env.RATE_LIMIT_EXPORT_PER_USER_MAX,
      });
      if (!limit.allowed) {
        // Logged before refusing: a burst of attempts is itself the signal.
        await writeAudit(app.prisma, {
          action: 'member.cards.export.throttled',
          principal,
          subjectType: 'Member',
          ipAddress: request.ip,
        });
        throw new RateLimitedError(limit.retryAfterSeconds);
      }

      const filters: Prisma.MemberWhereInput = {
        ...(query.status ? { status: query.status } : {}),
        ...(query.since ? { joinedAt: { gte: new Date(query.since) } } : {}),
      };

      const members = await app.prisma.member.findMany({
        where: scopedWhere(filters, scopeForMember(principal)),
        orderBy: { memberNumber: 'asc' },
        // One past the cap, so a full batch is distinguishable from an
        // overflowing one without a second count query.
        take: CARD_EXPORT_MAX_ROWS + 1,
        select: { id: true, memberNumber: true, fullName: true, status: true },
      });

      if (members.length > CARD_EXPORT_MAX_ROWS) {
        return reply.code(400).send({
          error: 'export_too_large',
          message:
            `More than ${CARD_EXPORT_MAX_ROWS} members match. Narrow the export with ` +
            '`since` or `status` — a truncated print run would leave members without a card.',
        });
      }

      await writeAudit(app.prisma, {
        action: 'member.cards.exported',
        principal,
        subjectType: 'Member',
        metadata: {
          rows: members.length,
          status: query.status ?? null,
          since: query.since ?? null,
        },
        ipAddress: request.ip,
      });

      const csv = toCsv(
        [
          'membership_number',
          'full_name',
          // What the QR encodes, byte for byte. It must reach the bureau's
          // artwork unmodified: the payload is base64url, so it is
          // case-sensitive and contains `-` and `_`. Software that uppercases
          // it — which some barcode tooling does by default, because
          // uppercase-only mode yields a physically smaller symbol — produces a
          // card that scans cleanly and then fails signature verification at the
          // counter.
          'card_code',
          // So a suspended member is not sent to print by accident. The filter
          // above is optional, matching `/admin/members`; this column is how the
          // caller sees what they are about to print either way.
          'status',
        ],
        members.map((member) => [
          member.memberNumber,
          member.fullName,
          // Derived, never stored — see `issueCardCode`. Regenerating this file
          // for a lost card yields the identical code, which is what makes a
          // replacement a straight reprint.
          issueCardCode(member.id),
          member.status,
        ]),
      );

      const filename = `privilege-guest-cards-${new Date().toISOString().slice(0, 10)}.csv`;

      return reply
        .type('text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(csv);
    },
  );

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
        select: { id: true, claimedAt: true, email: true, phone: true },
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

      // Emailed, like the original — but unlike creation, the plaintext is
      // returned to the administrator either way. This route exists precisely
      // because the normal path did not reach the member, so withholding the
      // code here would remove the only remaining way to activate them.
      const delivery = {
        email: existing.email,
        phone: existing.phone ?? '',
        code: claim.plaintext,
        purpose: 'invitation' as const,
        validFor: `${Math.round(env.CLAIM_CODE_TTL_HOURS / 24)} days`,
      };
      logDeliveryOutcome(app.log, app.codeSender, delivery, await app.codeSender.send(delivery));

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
