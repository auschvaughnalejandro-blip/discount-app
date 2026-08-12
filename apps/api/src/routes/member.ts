import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { NotFoundError, RateLimitedError } from '../errors.js';
import { writeAudit } from '../security/audit.js';
import { hashClaimCode } from '../security/claim-codes.js';
import { issueCardCode } from '../security/identity-codes.js';
import { normalizePhone } from '../security/phone.js';
import { checkRateLimit } from '../security/rate-limit.js';
import { issueRefreshToken } from '../security/refresh-tokens.js';
import { scopeForMember, scopedWhere } from '../security/scope.js';
import { issueAccessToken } from '../security/tokens.js';
import { currentConsent } from './admin-members.js';

/**
 * Activation, per product-definition.md §8 and wireframes screens 1–2:
 *
 *   claim code + phone  →  OTP  →  consent capture  →  membership claimed
 *
 * That is two screens, so two calls, but BUILD-PLAN.md lists a single
 * `POST /member/claim`. Rather than invent a second endpoint, the one endpoint
 * has two phases, told apart by whether an OTP is present:
 *
 *   phase 1  { claimCode, phone }                    → validates, sends an OTP
 *   phase 2  { claimCode, phone, otp, consent, … }   → completes the claim
 *
 * ## One step, and why there is no second code
 *
 * The invitation code is emailed to the member. Receiving it is already proof
 * that they control that mailbox — so sending a second code to the same mailbox
 * proves the same fact twice, and two factors drawn from one channel are one
 * factor wearing a disguise.
 *
 * What this gives up, stated plainly: a member can forward their invitation
 * email to someone else, who can then activate the membership. The second code
 * used to prevent that, because the reply went to the member's address rather
 * than the friend's. That was judged not worth the friction at this stage — see
 * DECISIONS.md. If membership sharing ever becomes a real problem, reinstating
 * it is this file and one screen.
 *
 * The claim code is consumed only on success, so a mistyped phone number does
 * not burn the member's invitation.
 */
const claimSchema = z
  .object({
    claimCode: z.string().trim().min(1).max(64),
    phone: z.string().trim().min(1).max(32),
    // §10 and wireframes screen 2 note 2: per channel, unticked by default.
    // Both are required so an omission is never silently read as consent.
    consent: z
      .object({
        email: z.boolean(),
        sms: z.boolean(),
      })
      .strict(),
  })
  .strict();

const consentUpdateSchema = z
  .object({
    email: z.boolean().optional(),
    sms: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.email !== undefined || value.sms !== undefined, {
    message: 'At least one channel must be supplied.',
  });

const memberRoutes: FastifyPluginAsync = async (app) => {
  const env = app.env;

  // ── POST /member/claim ────────────────────────────────────────────────
  app.post('/member/claim', { config: { permission: 'public' } }, async (request, reply) => {
    // §3: "Strict rate limiting on the activation endpoint, since a guessable
    // claim code grants a genuine membership."
    const limit = checkRateLimit(`claim:ip:${request.ip}`, {
      windowSeconds: env.RATE_LIMIT_CLAIM_WINDOW_SECONDS,
      max: env.RATE_LIMIT_CLAIM_PER_IP_MAX,
    });
    if (!limit.allowed) {
      throw new RateLimitedError(limit.retryAfterSeconds);
    }

    const parsed = claimSchema.parse(request.body);

    // Normalised before anything compares it, so 55550003 and +97455550003
    // are the same member rather than two.
    const normalizedPhone = normalizePhone(parsed.phone, {
      defaultCountryCode: env.DEFAULT_PHONE_COUNTRY_CODE,
    });
    const body = { ...parsed, phone: normalizedPhone ?? parsed.phone };

    // Every failure below returns this same response. Which part was wrong —
    // unknown code, expired code, already used, wrong phone — is exactly what
    // an attacker holding a discarded letter would want to learn.
    const invalid = () => {
      return reply.code(400).send({
        error: 'invalid_claim',
        message: 'That invitation code is not valid.',
      });
    };

    const claimCode = await app.prisma.claimCode.findUnique({
      where: { codeHash: hashClaimCode(body.claimCode) },
      select: {
        id: true,
        memberId: true,
        expiresAt: true,
        usedAt: true,
        member: {
          // `email` is needed by Stage 18's delivery. See the note at phase 1
          // below for why it may well be null at exactly this moment.
          select: {
            id: true,
            phone: true,
            email: true,
            status: true,
            claimedAt: true,
            tokenVersion: true,
          },
        },
      },
    });

    if (!claimCode) {
      return invalid();
    }
    if (claimCode.usedAt !== null) {
      return invalid();
    }
    if (claimCode.expiresAt.getTime() <= Date.now()) {
      return invalid();
    }
    if (claimCode.member.status !== 'ACTIVE') {
      return invalid();
    }
    if (claimCode.member.claimedAt !== null) {
      return invalid();
    }

    // Where the hotel already recorded a phone number, the one supplied must
    // match it. Where it did not, the member supplies it here and it becomes
    // their sign-in credential (wireframes screen 1 note 3).
    if (claimCode.member.phone !== null && claimCode.member.phone !== body.phone) {
      return invalid();
    }
    if (claimCode.member.phone === null) {
      const takenBy = await app.prisma.member.findUnique({
        where: { phone: body.phone },
        select: { id: true },
      });
      if (takenBy && takenBy.id !== claimCode.memberId) {
        return invalid();
      }
    }

    const claimed = await app.prisma.$transaction(async (tx) => {
      // R1 — atomic consumption. The WHERE clause carries `usedAt: null`, so
      // two concurrent activations with the same code cannot both match: the
      // loser updates zero rows and is rejected below. A read-then-write
      // would let both through.
      const consumed = await tx.claimCode.updateMany({
        where: { id: claimCode.id, usedAt: null },
        data: { usedAt: new Date() },
      });

      if (consumed.count !== 1) {
        return null;
      }

      const member = await tx.member.update({
        where: { id: claimCode.memberId },
        data: {
          claimedAt: new Date(),
          phone: body.phone,
          // Email is not taken from this request. The administrator recorded it
          // when creating the member, it is where the invitation was just sent,
          // and letting the activation payload change it would mean a forwarded
          // invitation could also redirect every future passcode.
        },
        select: { id: true, memberNumber: true, fullName: true, tokenVersion: true },
      });

      // R15: recorded per channel with the wording version, including a
      // declined channel — an absent row and a declined one must not look
      // the same later.
      await tx.consentRecord.createMany({
        data: [
          {
            memberId: member.id,
            channel: 'EMAIL',
            granted: body.consent.email,
            wordingVersion: env.CONSENT_WORDING_VERSION,
          },
          {
            memberId: member.id,
            channel: 'SMS',
            granted: body.consent.sms,
            wordingVersion: env.CONSENT_WORDING_VERSION,
          },
        ],
      });

      return member;
    });

    if (!claimed) {
      return invalid();
    }

    const accessToken = await issueAccessToken({
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE_MEMBER,
      subject: claimed.id,
      subjectType: 'MEMBER',
      tokenVersion: claimed.tokenVersion,
      ttlSeconds: env.ACCESS_TOKEN_TTL_MEMBER_SECONDS,
    });

    const refresh = await issueRefreshToken(app.prisma, {
      subjectId: claimed.id,
      subjectType: 'MEMBER',
      ttlSeconds: env.REFRESH_TOKEN_TTL_MEMBER_SECONDS,
    });

    await writeAudit(app.prisma, {
      action: 'member.claimed',
      principal: { subjectId: claimed.id, subjectType: 'MEMBER' },
      subjectType: 'Member',
      subjectId: claimed.id,
      metadata: { memberNumber: claimed.memberNumber },
      ipAddress: request.ip,
    });

    return reply.code(200).send({
      memberNumber: claimed.memberNumber,
      accessToken,
      accessTokenExpiresIn: env.ACCESS_TOKEN_TTL_MEMBER_SECONDS,
      refreshToken: refresh.token,
    });
  });

  // ── GET /member/me ────────────────────────────────────────────────────
  app.get('/member/me', { config: { permission: 'member:self' } }, async (request) => {
    const principal = request.principal;
    if (!principal) {
      throw new NotFoundError();
    }

    const member = await app.prisma.member.findFirst({
      where: scopedWhere({}, scopeForMember(principal)),
      select: {
        id: true,
        memberNumber: true,
        fullName: true,
        phone: true,
        email: true,
        status: true,
        joinedAt: true,
        claimedAt: true,
        consents: {
          orderBy: { recordedAt: 'desc' },
          select: { channel: true, granted: true, wordingVersion: true, recordedAt: true },
        },
      },
    });

    if (!member) {
      throw new NotFoundError();
    }

    const { consents, ...rest } = member;
    return {
      ...rest,
      consent: currentConsent(consents),
      // The code on the card. Derived from the opaque internal id and signed —
      // never from the sequential membership number, which a member could use to
      // generate a neighbour's payload (R3).
      //
      // The same value is printed on the back of the physical card, so this is
      // what the app shows and what a scanner reads either way. It identifies and
      // grants nothing; see security/identity-codes.ts.
      cardCode: issueCardCode(member.id),
    };
  });

  // ── PATCH /member/me/consent ──────────────────────────────────────────
  // R15: withdrawal takes effect immediately. Because consent rows are
  // append-only, "immediately" means the newest row per channel is what
  // anything sending a message must read — there is no cache to invalidate
  // and no earlier row to edit.
  app.patch('/member/me/consent', { config: { permission: 'member:self' } }, async (request) => {
    const body = consentUpdateSchema.parse(request.body);
    const principal = request.principal;
    if (!principal) {
      throw new NotFoundError();
    }

    const member = await app.prisma.member.findFirst({
      where: scopedWhere({}, scopeForMember(principal)),
      select: { id: true },
    });
    if (!member) {
      throw new NotFoundError();
    }

    const rows = [
      ...(body.email !== undefined
        ? [
            {
              memberId: member.id,
              channel: 'EMAIL' as const,
              granted: body.email,
              wordingVersion: env.CONSENT_WORDING_VERSION,
            },
          ]
        : []),
      ...(body.sms !== undefined
        ? [
            {
              memberId: member.id,
              channel: 'SMS' as const,
              granted: body.sms,
              wordingVersion: env.CONSENT_WORDING_VERSION,
            },
          ]
        : []),
    ];

    await app.prisma.consentRecord.createMany({ data: rows });

    // Re-read through the scoped member rather than querying ConsentRecord by
    // memberId. Reading the child table directly would be safe here — the id
    // came from the scoped query above — but only transitively, which is
    // precisely the shape that stops being safe when someone later changes
    // where the id comes from. The nested read inherits the parent's scope.
    const updated = await app.prisma.member.findFirst({
      where: scopedWhere({}, scopeForMember(principal)),
      select: {
        consents: {
          orderBy: { recordedAt: 'desc' },
          select: { channel: true, granted: true, wordingVersion: true, recordedAt: true },
        },
      },
    });

    if (!updated) {
      throw new NotFoundError();
    }

    await writeAudit(app.prisma, {
      action: 'member.consent_changed',
      principal,
      subjectType: 'Member',
      subjectId: member.id,
      metadata: { channels: Object.keys(body) },
      ipAddress: request.ip,
    });

    return { consent: currentConsent(updated.consents) };
  });
};

export default memberRoutes;
