import { Prisma, type PrismaClient } from '@prisma/client';

import type { Principal } from './principal.js';

/**
 * Audit writes.
 *
 * Stage 9 owns the full treatment — the complete action list from
 * security-implementation.md §9, the logger redaction layer, and alerting.
 * This is the write helper those paths call, introduced here because Stage 5's
 * acceptance criteria require that "every change writes an audit entry naming
 * the user".
 *
 * The table is insert-only: UPDATE and DELETE were revoked from the
 * application role in the Stage 1 migration, so a caller cannot rewrite its
 * own trail.
 */
/**
 * The actions security-implementation.md §9 requires:
 *
 *   every member record viewed, and by whom; every verification lookup,
 *   successful or not; every export; every benefit change; every membership
 *   created, suspended or reinstated; every authentication event and
 *   permission change; and every authorization denial.
 */
export type AuditAction =
  | 'benefit.created'
  | 'benefit.updated'
  | 'benefit.published'
  | 'benefit.unpublished'
  // §9: "Every verification lookup, successful or not." A run of failures
  // against non-existent numbers is someone probing the sequence.
  | 'verification.lookup.success'
  | 'verification.lookup.failure'
  | 'redemption.recorded'
  // Where a redemption came from. Split three ways because the questions asked
  // after an incident are different for each: a dashboard entry was typed by an
  // administrator, an outlet confirmation was somebody at a counter closing out a
  // notice, and a scan means a card was physically presented. Rolling them into
  // one action would leave "was the card actually there?" unanswerable.
  | 'redemption.recorded.outlet'
  | 'redemption.recorded.scan'
  | 'redemption.reversed'
  // A notice and how it ended. `request.approved` and `request.declined` are
  // gone: nothing approves a notice, because the guest is already entitled.
  // Historical rows keep those action strings — the column is free text and this
  // union constrains only what is written from now on.
  | 'request.created'
  | 'request.not_used'
  | 'report.viewed'
  | 'report.exported'
  | 'report.export.throttled'
  // §9: "Who viewed which member's history is itself sensitive information,
  // and the hotel should be able to answer that question."
  | 'member.viewed'
  | 'member.listed'
  | 'member.created'
  | 'member.updated'
  | 'member.suspended'
  | 'member.reinstated'
  | 'member.claim_code_issued'
  // The card-print export, kept distinct from `report.exported` because it is a
  // different disclosure answering a different question: that file is a list of
  // membership numbers, this one is every member's name and card code together.
  // "Who took the membership list, and when" has to be answerable on its own
  // rather than inferred from an action name shared with finance's monthly CSV.
  | 'member.cards.exported'
  | 'member.cards.export.throttled'
  | 'member.claimed'
  | 'member.consent_changed'
  // Stage 25. Who was granted an account, who lost one, and who cleared
  // somebody else's second factor — the three questions asked after an
  // incident, and none of them answerable before these routes existed.
  | 'staff.created'
  | 'staff.suspended'
  | 'staff.reinstated'
  | 'staff.mfa_reset'
  | 'staff.password_set'
  | 'staff.password_changed'
  // Outlet configuration and historical Google-account lifecycle events. The
  // account actions remain in the type because immutable audit rows may already
  // contain them; no live route emits them now.
  | 'outlet.updated'
  | 'outlet.account_created'
  | 'outlet.account_suspended'
  | 'outlet.account_reinstated'
  // The sole live outlet sign-in credentials. Creation and rotation are the only
  // times plaintext exists; revocation destroys the stored digest and every
  // session belonging to that one device.
  | 'outlet.device_created'
  | 'outlet.device_rotated'
  | 'outlet.device_revoked'
  | 'auth.login.success'
  | 'auth.login.failure'
  // Outlet sign-in, kept distinct from the dashboard's. TOKEN attempts identify
  // the method in metadata and have a narrower blast radius than an administrator
  // session. The names also remain compatible with historical Google audit rows.
  | 'auth.outlet.login.success'
  | 'auth.outlet.login.failure'
  // Stage 19. A password accepted but a second factor still outstanding is not
  // a successful login, and recording it as one would misreport who was in the
  // dashboard. §9 wants "every authentication event", and these are events.
  | 'auth.mfa.challenged'
  | 'auth.mfa.success'
  | 'auth.mfa.failure'
  | 'auth.mfa.enrolled'
  // A recovery code spends a credential and should stand out in the trail.
  | 'auth.mfa.recovery_used'
  // A password that completed sign-in on its own, under `STAFF_MFA_REQUIRED=false`.
  // Impossible in production — env.ts refuses to boot in that combination — so any
  // row carrying this action is either local development or evidence that
  // something started with a configuration nothing should have accepted. Kept
  // distinct from `auth.login.success` for exactly that reason.
  | 'auth.mfa.skipped'
  | 'auth.logout'
  | 'auth.logout_all'
  | 'auth.refresh.reuse_detected'
  // Every authorization denial, so a spike in them is visible.
  | 'authorization.denied';

export interface AuditEntry {
  action: AuditAction;
  principal?: Principal | undefined;
  subjectType?: string;
  subjectId?: string;
  /** Never put a name, phone number or email address in here (§9). */
  metadata?: Record<string, unknown>;
  ipAddress?: string | undefined;
}

export async function writeAudit(prisma: PrismaClient, entry: AuditEntry): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorType: entry.principal?.subjectType ?? 'ANONYMOUS',
      actorId: entry.principal?.subjectId ?? null,
      action: entry.action,
      subjectType: entry.subjectType ?? null,
      subjectId: entry.subjectId ?? null,
      // DbNull writes a SQL NULL; a bare `null` would be ambiguous with a
      // JSON `null` value for a nullable Json column.
      metadata: entry.metadata ? (entry.metadata as Prisma.InputJsonValue) : Prisma.DbNull,
      ipAddress: entry.ipAddress ?? null,
    },
  });
}
