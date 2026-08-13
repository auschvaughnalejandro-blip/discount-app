import type { PrismaClient } from '@prisma/client';

import type { Principal } from '../security/principal.js';
import { scopeForBenefitRequest, scopeForRedemption, scopedWhere } from '../security/scope.js';

/**
 * Recording that a benefit was given — the one write both surfaces share.
 *
 * An administrator records from the dashboard; an outlet records by confirming a
 * notice or scanning a card. Same rules, same order, same immutable row. This
 * lives in one place because the alternative is two implementations of R5, R6 and
 * R8 that agree today and drift the first time one is edited.
 *
 * The system records; it does not discount. The money stays on the hotel's own
 * till (product-definition.md §6), and nothing here computes or applies any.
 *
 * Returns a result rather than sending a reply, so each route keeps its own HTTP
 * shape without this module knowing anything about Fastify.
 */

/** What a recorded redemption returns. One shape, three call paths. */
export const RECORDED_SELECT = {
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

export interface RecordedRedemption {
  id: string;
  memberId: string;
  benefitId: string;
  outletId: string;
  partySize: number | null;
  billAmountMinor: number | null;
  discountPctApplied: unknown;
  benefitVersion: number;
  occurredAt: Date;
}

export interface RecordRedemptionInput {
  memberId: string;
  benefitId: string;
  outletId: string;
  partySize?: number | undefined;
  billAmountMinor?: number | undefined;
  /** The notice this visit closes out, where the guest announced in advance. */
  requestId?: string | undefined;
  idempotencyKey: string;
}

export type RecordRedemptionFailure =
  | 'not_found'
  | 'idempotency_key_reused'
  | 'member_not_active'
  | 'outlet_unavailable'
  | 'benefit_unavailable'
  | 'party_size_required'
  | 'party_size_above_maximum'
  | 'party_size_below_minimum'
  | 'notice_not_valid';

export type RecordRedemptionResult =
  | {
      ok: true;
      redemption: RecordedRedemption;
      idempotent: boolean;
      /** For the audit entry and the member's notification. */
      benefit: { key: string; title: string };
      outlet: { name: string };
      member: { email: string | null; phone: string | null };
    }
  | {
      ok: false;
      failure: RecordRedemptionFailure;
      message: string;
      detail?: Record<string, number>;
    };

/**
 * What a visit actually saved the member, in fils.
 *
 * The same arithmetic `reporting/metrics.ts` runs for the dashboard —
 * `billAmountMinor * discountPctApplied / 100`, rounded, in integer minor units
 * throughout, because money does not survive binary floating point. Stated twice
 * rather than shared because the dashboard's version is SQL executing inside
 * Postgres and this one is per row; the arithmetic is the contract and a test
 * holds them to it.
 *
 * Null when the bill was not captured. That is an ordinary outcome — recording a
 * redemption never required an amount — and it must stay distinguishable from a
 * genuine zero, so the member's screen can say "no amount recorded" rather than
 * claim they saved nothing.
 *
 * A reversal carries a negated bill, so its saving is negative and a total that
 * sums this column nets correctly without special-casing.
 */
export function savedMinor(row: {
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

/**
 * `Decimal` serialises as an object through JSON, so every percentage crossing
 * the wire is a string — the same shape the benefit endpoints already use.
 */
export function serializeRecorded<T extends { discountPctApplied: unknown }>(
  row: T,
): Omit<T, 'discountPctApplied'> & { discountPctApplied: string } {
  return { ...row, discountPctApplied: String(row.discountPctApplied) };
}

export async function recordRedemption(
  prisma: PrismaClient,
  principal: Principal,
  input: RecordRedemptionInput,
): Promise<RecordRedemptionResult> {
  // R8 first for a *repeat* of a completed call: returning the original is the
  // correct answer to a retry, and must not depend on the rest of the validation
  // still passing. A benefit unpublished between the original call and the retry
  // must not turn a success into an error.
  //
  // Scoped: the key is client-supplied, so an unscoped lookup would let a guessed
  // key disclose a redemption the caller may not see.
  const existing = await prisma.redemption.findFirst({
    where: scopedWhere({ idempotencyKey: input.idempotencyKey }, scopeForRedemption(principal)),
    select: RECORDED_SELECT,
  });

  if (existing) {
    // Same key, different content is a client bug, not a retry — and silently
    // returning the original would hide it.
    if (existing.memberId !== input.memberId || existing.benefitId !== input.benefitId) {
      return {
        ok: false,
        failure: 'idempotency_key_reused',
        message: 'That idempotency key was used for a different redemption.',
      };
    }
    const context = await replayContext(prisma, existing);
    return { ok: true, redemption: existing, idempotent: true, ...context };
  }

  // Validation in the order BUILD-PLAN §Stage 7 specifies.

  // 1. Member exists and is ACTIVE (R4).
  const member = await prisma.member.findUnique({
    where: { id: input.memberId },
    select: { id: true, status: true, claimedAt: true, email: true, phone: true },
  });
  if (!member) {
    return { ok: false, failure: 'not_found', message: 'No matching member.' };
  }
  if (member.status !== 'ACTIVE') {
    return { ok: false, failure: 'member_not_active', message: 'This membership is not active.' };
  }

  // 2. The outlet exists and is open. A redemption attributed to a closed or
  //    invented outlet corrupts every report grouped by outlet, and the foreign
  //    key alone would only catch the invented case.
  const outlet = await prisma.outlet.findUnique({
    where: { id: input.outletId },
    select: { id: true, active: true, name: true },
  });
  if (!outlet || !outlet.active) {
    return { ok: false, failure: 'outlet_unavailable', message: 'That outlet is not available.' };
  }

  // 3. Benefit exists and is published.
  const benefit = await prisma.benefit.findUnique({
    where: { id: input.benefitId },
    select: {
      id: true,
      key: true,
      title: true,
      published: true,
      maxGuests: true,
      minGuests: true,
      // Snapshotted onto the redemption below. Read here, inside the same unit of
      // work that writes the row, so the rate stored is the rate the caps were
      // checked against.
      discountPct: true,
      version: true,
    },
  });
  if (!benefit || !benefit.published) {
    return {
      ok: false,
      failure: 'benefit_unavailable',
      message: 'That benefit is not available.',
    };
  }

  // 4. partySize <= maxGuests where set (R5).
  if (benefit.maxGuests !== null) {
    if (input.partySize === undefined) {
      return {
        ok: false,
        failure: 'party_size_required',
        message: 'Number of guests is required for this benefit.',
        detail: { maxGuests: benefit.maxGuests },
      };
    }
    if (input.partySize > benefit.maxGuests) {
      return {
        ok: false,
        failure: 'party_size_above_maximum',
        message: `This benefit allows a maximum of ${benefit.maxGuests} guests.`,
        detail: { maxGuests: benefit.maxGuests },
      };
    }
  }

  // 5. partySize >= minGuests where set (R6).
  if (benefit.minGuests !== null) {
    if (input.partySize === undefined) {
      return {
        ok: false,
        failure: 'party_size_required',
        message: 'Number of guests is required for this benefit.',
        detail: { minGuests: benefit.minGuests },
      };
    }
    if (input.partySize < benefit.minGuests) {
      return {
        ok: false,
        failure: 'party_size_below_minimum',
        message: `This benefit requires at least ${benefit.minGuests} guests.`,
        detail: { minGuests: benefit.minGuests },
      };
    }
  }

  // 6. If this closes out a notice, the notice must be real, still open, and
  //    belong to this member and this benefit. Checked before the write so a bad
  //    reference never leaves a redemption recorded against nothing.
  if (input.requestId !== undefined) {
    const notice = await prisma.benefitRequest.findFirst({
      where: scopedWhere({ id: input.requestId }, scopeForBenefitRequest(principal)),
      select: { id: true, memberId: true, benefitId: true, status: true },
    });

    // A spent notice fails on status; a wrong one fails on the member or benefit
    // not matching. One message covers all three, so a guessed id learns nothing
    // about which notices exist.
    if (
      !notice ||
      notice.status !== 'SENT' ||
      notice.memberId !== member.id ||
      notice.benefitId !== benefit.id
    ) {
      return {
        ok: false,
        failure: 'notice_not_valid',
        message: 'That request is not available for this member and benefit.',
      };
    }
  }

  // 7. Idempotency key unused — enforced by the unique index rather than by the
  //    check above, which can lose a race.
  let created;
  try {
    created = await prisma.redemption.create({
      data: {
        memberId: member.id,
        benefitId: benefit.id,
        outletId: outlet.id,
        staffUserId: principal.subjectId,
        partySize: input.partySize ?? null,
        billAmountMinor: input.billAmountMinor ?? null,
        // The rate this member was given, fixed here. Every figure derived from
        // this visit reads it back from this row and never from the benefit, so
        // an administrator exercising R14 tomorrow changes what members are
        // offered next — not what this one was given today.
        discountPctApplied: benefit.discountPct,
        benefitVersion: benefit.version,
        idempotencyKey: input.idempotencyKey,
      },
      select: RECORDED_SELECT,
    });
  } catch (error) {
    // Two identical submissions in flight at once: the loser reads the winner's
    // row and returns it, which is what a retry should see.
    const raced = await prisma.redemption.findFirst({
      where: scopedWhere({ idempotencyKey: input.idempotencyKey }, scopeForRedemption(principal)),
      select: RECORDED_SELECT,
    });
    if (raced) {
      const context = await replayContext(prisma, raced);
      return { ok: true, redemption: raced, idempotent: true, ...context };
    }
    throw error;
  }

  // Spend the notice. Conditional on it still being SENT, so two people
  // confirming the same one at the same moment cannot both succeed — and the
  // unique index on `redemptionId` is the backstop if this check is ever removed.
  //
  // Deliberately after the redemption exists rather than before: a failure here
  // leaves a notice that looks open, which is recoverable from the member's
  // history. The reverse — a notice marked spent with no redemption behind it —
  // leaves the guest with no discount and no way to ask again.
  if (input.requestId !== undefined) {
    await prisma.benefitRequest.updateMany({
      where: { id: input.requestId, status: 'SENT' },
      data: {
        status: 'FULFILLED',
        redemptionId: created.id,
        fulfilledAt: new Date(),
        closedAt: new Date(),
        closedByUserId: principal.subjectId,
      },
    });
  }

  return {
    ok: true,
    redemption: created,
    idempotent: false,
    benefit: { key: benefit.key, title: benefit.title },
    outlet: { name: outlet.name },
    member: { email: member.email, phone: member.phone },
  };
}

/**
 * The names and addresses an idempotent replay still has to return.
 *
 * A retry gets the same body as the original, which means the benefit title and
 * outlet name have to be read back even though nothing is being written. Kept
 * separate so the success path above is not re-reading rows it already has.
 */
async function replayContext(
  prisma: PrismaClient,
  row: { benefitId: string; outletId: string; memberId: string },
): Promise<{
  benefit: { key: string; title: string };
  outlet: { name: string };
  member: { email: string | null; phone: string | null };
}> {
  const [benefit, outlet, member] = await Promise.all([
    prisma.benefit.findUniqueOrThrow({
      where: { id: row.benefitId },
      select: { key: true, title: true },
    }),
    prisma.outlet.findUniqueOrThrow({ where: { id: row.outletId }, select: { name: true } }),
    prisma.member.findUniqueOrThrow({
      where: { id: row.memberId },
      select: { email: true, phone: true },
    }),
  ]);
  return { benefit, outlet, member };
}
