import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { ForbiddenError, NotFoundError } from '../errors.js';
import { writeAudit } from '../security/audit.js';
import { MINIMUM_PASSWORD_LENGTH, screenPassword } from '../security/breached-passwords.js';
import { hashPassword, verifyPassword } from '../security/password.js';
import { revokeAllForSubject } from '../security/refresh-tokens.js';

/**
 * Administrator accounts.
 *
 * Until now every staff account came from `prisma/seed.ts`. That meant three
 * things, and the first is the serious one:
 *
 *   1. §3's "instant revocation from the dashboard" could not be performed.
 *      `StaffUser.tokenVersion` and `status` were both wired up and working,
 *      and no endpoint reached them — so offboarding somebody was a manual
 *      `UPDATE` against production. For a system whose threat model is a leaked
 *      membership list, an administrator unable to cut off a departed employee
 *      was the most serious thing in the repository.
 *   2. §3's "screened against a breached-password list" could not be
 *      implemented, because nothing ever set a password.
 *   3. There was no way back for a staff member who lost their authenticator
 *      *and* their recovery codes.
 *
 * Multiple named administrators are still supported for attribution,
 * offboarding and MFA recovery. There are no limited staff account types.
 * Historical non-administrator rows remain in the database as foreign-key
 * targets, but every query in this module deliberately excludes them.
 */

/**
 * Not `.uuid()`. Staff ids are uuids for accounts this route creates, and
 * readable slugs for the seeded ones (`seed-staff-administrator`) — so a uuid
 * constraint here rejects the founding administrator with a 400 and makes the
 * first account unmanageable. The value is only ever compared, never parsed.
 */
const idParamSchema = z.object({ id: z.string().trim().min(1).max(64) }).strict();

const createStaffSchema = z
  .object({
    fullName: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(320),
    password: z.string().min(MINIMUM_PASSWORD_LENGTH).max(200),
  })
  .strict();

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(MINIMUM_PASSWORD_LENGTH).max(200),
  })
  .strict();

const setPasswordSchema = z
  .object({ password: z.string().min(MINIMUM_PASSWORD_LENGTH).max(200) })
  .strict();

/** Never the hash, never the MFA secret. */
const STAFF_VIEW = {
  id: true,
  fullName: true,
  email: true,
  role: true,
  status: true,
  createdAt: true,
  // Whether a second factor is set up, never anything about what it is.
  mfaEnrolledAt: true,
} as const;

const adminStaffRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Screens a password and turns a refusal into a response.
   *
   * Returns `null` when the password is acceptable. A screening that could not
   * reach HIBP is allowed through and logged — see the note in
   * `breached-passwords.ts` for why an outage must not block a password change.
   */
  async function refusePassword(
    password: string,
    log: typeof app.log,
  ): Promise<{ error: string; message: string } | null> {
    const result = await screenPassword(password);

    if (!result.screened) {
      log.warn(
        { reason: result.ok ? 'unreachable' : 'too_short' },
        'password was not screened against the breach list',
      );
    }

    if (result.ok) {
      return null;
    }

    if (result.reason === 'too_short') {
      return {
        error: 'password_too_short',
        message: `Use at least ${MINIMUM_PASSWORD_LENGTH} characters. Length matters more than symbols.`,
      };
    }

    return {
      error: 'password_breached',
      message:
        'That password appears in a known data breach and cannot be used. ' +
        'It is not about this system — the password itself is public.',
    };
  }

  // ── GET /admin/staff ──────────────────────────────────────────────────
  app.get('/admin/staff', { config: { permission: 'staff:manage' } }, async () => {
    const staff = await app.prisma.staffUser.findMany({
      where: { role: 'ADMINISTRATOR' },
      orderBy: [{ status: 'asc' }, { fullName: 'asc' }],
      select: STAFF_VIEW,
    });
    return { staff };
  });

  // ── POST /admin/staff ─────────────────────────────────────────────────
  app.post('/admin/staff', { config: { permission: 'staff:manage' } }, async (request, reply) => {
    const body = createStaffSchema.parse(request.body);
    const principal = request.principal;
    if (!principal) {
      throw new ForbiddenError();
    }

    const refusal = await refusePassword(body.password, app.log);
    if (refusal) {
      return reply.code(400).send(refusal);
    }

    const existing = await app.prisma.staffUser.findUnique({
      where: { email: body.email },
      select: { id: true },
    });
    if (existing) {
      return reply.code(409).send({
        error: 'email_already_used',
        message: 'A staff account already uses that email address.',
      });
    }

    const created = await app.prisma.staffUser.create({
      data: {
        fullName: body.fullName,
        email: body.email,
        role: 'ADMINISTRATOR',
        outletId: null,
        passwordHash: await hashPassword(body.password),
      },
      select: STAFF_VIEW,
    });

    await writeAudit(app.prisma, {
      action: 'staff.created',
      principal,
      subjectType: 'StaffUser',
      subjectId: created.id,
      // The role, because who was granted what is the question this log exists
      // to answer. Never the name or the address (§9).
      metadata: { role: created.role },
      ipAddress: request.ip,
    });

    // MFA enrollment is forced on first sign-in for every dashboard role, so
    // this account cannot reach anything until a second factor exists.
    return reply.code(201).send(created);
  });

  // ── POST /admin/staff/:id/suspend ─────────────────────────────────────
  // ── POST /admin/staff/:id/reinstate ───────────────────────────────────
  for (const action of ['suspend', 'reinstate'] as const) {
    const nextStatus = action === 'suspend' ? 'SUSPENDED' : 'ACTIVE';

    app.post(
      `/admin/staff/:id/${action}`,
      { config: { permission: 'staff:manage' } },
      async (request, reply) => {
        const { id } = idParamSchema.parse(request.params);
        const principal = request.principal;
        if (!principal) {
          throw new ForbiddenError();
        }

        // An administrator suspending themselves locks the dashboard if they
        // are the only one. Refused rather than warned about.
        if (action === 'suspend' && id === principal.subjectId) {
          return reply.code(409).send({
            error: 'cannot_suspend_self',
            message: 'You cannot suspend your own account.',
          });
        }

        const existing = await app.prisma.staffUser.findFirst({
          where: { id, role: 'ADMINISTRATOR' },
          select: { id: true, status: true, role: true },
        });
        if (!existing) {
          throw new NotFoundError();
        }

        // Suspending the last active administrator leaves nobody who can
        // reinstate anyone. The database cannot express "at least one", so it
        // is checked here.
        if (action === 'suspend') {
          const remaining = await app.prisma.staffUser.count({
            where: { role: 'ADMINISTRATOR', status: 'ACTIVE', id: { not: id } },
          });
          if (remaining === 0) {
            return reply.code(409).send({
              error: 'last_administrator',
              message: 'This is the last active administrator. Create another one first.',
            });
          }
        }

        const updated = await app.prisma.$transaction(async (tx) => {
          const staff = await tx.staffUser.update({
            where: { id },
            data: {
              status: nextStatus,
              // §4 "forced re-authentication": incrementing this invalidates
              // every access token already issued to them. Without it a
              // suspended account keeps working until its token expires —
              // which is the whole ten minutes somebody needs.
              ...(action === 'suspend' ? { tokenVersion: { increment: 1 } } : {}),
            },
            select: STAFF_VIEW,
          });

          if (action === 'suspend') {
            // And the refresh tokens, or they mint a replacement immediately.
            await revokeAllForSubject(tx as never, id, 'STAFF');
          }

          return staff;
        });

        await writeAudit(app.prisma, {
          action: action === 'suspend' ? 'staff.suspended' : 'staff.reinstated',
          principal,
          subjectType: 'StaffUser',
          subjectId: id,
          metadata: { role: existing.role },
          ipAddress: request.ip,
        });

        return reply.code(200).send(updated);
      },
    );
  }

  // ── POST /admin/staff/:id/reset-mfa ───────────────────────────────────
  app.post(
    '/admin/staff/:id/reset-mfa',
    { config: { permission: 'staff:manage' } },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const principal = request.principal;
      if (!principal) {
        throw new ForbiddenError();
      }

      /**
       * Never your own.
       *
       * PROGRESS.md proposed "requires more than one administrator", which at a
       * hotel with a single administrator means permanent lockout — the exact
       * situation recovery codes exist for. This is the enforceable half of the
       * same intent: a stolen dashboard session cannot clear the second factor
       * protecting it, because clearing one always requires a *different*
       * account. An administrator who has lost everything uses a recovery code;
       * if those are gone too, another administrator resets them.
       */
      if (id === principal.subjectId) {
        return reply.code(409).send({
          error: 'cannot_reset_own_mfa',
          message:
            'You cannot reset your own second factor. Use a recovery code, ' +
            'or ask another administrator to reset it for you.',
        });
      }

      const existing = await app.prisma.staffUser.findFirst({
        where: { id, role: 'ADMINISTRATOR' },
        select: { id: true, role: true },
      });
      if (!existing) {
        throw new NotFoundError();
      }

      await app.prisma.$transaction(async (tx) => {
        await tx.staffUser.update({
          where: { id },
          data: {
            mfaSecret: null,
            mfaEnrolledAt: null,
            mfaLastUsedEpoch: null,
            // Everything they hold stops working. Between clearing the factor
            // and them enrolling again, a password alone would otherwise be
            // enough — and any live session would survive the reset.
            tokenVersion: { increment: 1 },
          },
        });

        // The old recovery codes belong to the old secret.
        await tx.mfaRecoveryCode.deleteMany({ where: { staffUserId: id } });
        await revokeAllForSubject(tx as never, id, 'STAFF');
      });

      await writeAudit(app.prisma, {
        action: 'staff.mfa_reset',
        principal,
        subjectType: 'StaffUser',
        subjectId: id,
        metadata: { role: existing.role },
        ipAddress: request.ip,
      });

      return reply.code(200).send({
        id,
        message: 'Second factor cleared. They will enrol again at their next sign-in.',
      });
    },
  );

  // ── POST /admin/staff/:id/set-password ────────────────────────────────
  // For a staff member who has forgotten theirs. Screened like any other.
  app.post(
    '/admin/staff/:id/set-password',
    { config: { permission: 'staff:manage' } },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const body = setPasswordSchema.parse(request.body);
      const principal = request.principal;
      if (!principal) {
        throw new ForbiddenError();
      }

      const refusal = await refusePassword(body.password, app.log);
      if (refusal) {
        return reply.code(400).send(refusal);
      }

      const existing = await app.prisma.staffUser.findFirst({
        where: { id, role: 'ADMINISTRATOR' },
        select: { id: true, role: true },
      });
      if (!existing) {
        throw new NotFoundError();
      }

      await app.prisma.$transaction(async (tx) => {
        await tx.staffUser.update({
          where: { id },
          data: {
            passwordHash: await hashPassword(body.password),
            // §4 lists a password change as an event that must invalidate
            // outstanding tokens.
            tokenVersion: { increment: 1 },
          },
        });
        await revokeAllForSubject(tx as never, id, 'STAFF');
      });

      await writeAudit(app.prisma, {
        action: 'staff.password_set',
        principal,
        subjectType: 'StaffUser',
        subjectId: id,
        metadata: { role: existing.role },
        ipAddress: request.ip,
      });

      return reply.code(200).send({ id });
    },
  );

  // ── POST /auth/staff/password ─────────────────────────────────────────
  // A staff member changing their own, which needs the current one.
  app.post(
    '/auth/staff/password',
    { config: { permission: 'staff:self' } },
    async (request, reply) => {
      const body = changePasswordSchema.parse(request.body);
      const principal = request.principal;
      if (!principal) {
        throw new ForbiddenError();
      }

      const self = await app.prisma.staffUser.findUnique({
        where: { id: principal.subjectId },
        select: { id: true, passwordHash: true, role: true },
      });
      if (!self) {
        throw new NotFoundError();
      }

      // Proving they are the person sitting there, not just that a session is
      // open — an unattended dashboard should not be a password change.
      if (!(await verifyPassword(body.currentPassword, self.passwordHash))) {
        return reply.code(401).send({
          error: 'invalid_credentials',
          message: 'That is not your current password.',
        });
      }

      const refusal = await refusePassword(body.newPassword, app.log);
      if (refusal) {
        return reply.code(400).send(refusal);
      }

      await app.prisma.$transaction(async (tx) => {
        await tx.staffUser.update({
          where: { id: self.id },
          data: {
            passwordHash: await hashPassword(body.newPassword),
            tokenVersion: { increment: 1 },
          },
        });
        await revokeAllForSubject(tx as never, self.id, 'STAFF');
      });

      await writeAudit(app.prisma, {
        action: 'staff.password_changed',
        principal,
        subjectType: 'StaffUser',
        subjectId: self.id,
        metadata: { role: self.role },
        ipAddress: request.ip,
      });

      // Their own tokens are now invalid too, which is correct and worth
      // saying, or the next click looks like a bug.
      return reply.code(200).send({
        id: self.id,
        message: 'Password changed. Sign in again on every device.',
      });
    },
  );
};

export default adminStaffRoutes;
