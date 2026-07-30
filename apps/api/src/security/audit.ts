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
  | 'redemption.reversed'
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
  | 'member.claimed'
  | 'member.consent_changed'
  | 'auth.login.success'
  | 'auth.login.failure'
  // Stage 19. A password accepted but a second factor still outstanding is not
  // a successful login, and recording it as one would misreport who was in the
  // dashboard. §9 wants "every authentication event", and these are events.
  | 'auth.mfa.challenged'
  | 'auth.mfa.success'
  | 'auth.mfa.failure'
  | 'auth.mfa.enrolled'
  // A recovery code spends a credential and should stand out in the trail.
  | 'auth.mfa.recovery_used'
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
