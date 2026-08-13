import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { ForbiddenError, NotFoundError } from '../errors.js';
import { writeAudit } from '../security/audit.js';
import {
  generateOutletLoginToken,
  hashOutletLoginToken,
} from '../security/outlet-login-token.js';

/**
 * Outlets and the physical devices that sign in for them.
 *
 * Three things an administrator may manage now that outlets do their own recording:
 *
 *   1. **Counter devices.** This is the normal path: each device receives its own
 *      high-entropy token exactly once, while only a digest is stored. One device
 *      can then be rotated or revoked without interrupting another.
 *   2. **Where a notice is emailed.** Optional, and separate from every device
 *      token so a hotel can point notices at a shared distribution list without
 *      that list becoming a credential.
 * Notification email and device authentication are deliberately separate. No
 * outlet password or email-based sign-in is created here. A TOKEN device has
 * only an outlet-token digest, and the database refuses a row that mixes
 * credential shapes or activates historical Google outlet accounts.
 *
 * Suspension is the offboarding path and it is immediate: bumping `tokenVersion`
 * kills every outstanding access token, and revoking the refresh family stops the
 * screen quietly minting a new one. Deleting the row is deliberately not offered —
 * it is the actor on every redemption that account ever recorded.
 */

const idParamSchema = z.object({ id: z.string().trim().min(1).max(64) }).strict();
const uuidParamSchema = z.object({ id: z.string().uuid() }).strict();

const updateOutletSchema = z
  .object({
    // Null clears it, which is a real choice: the outlet then works from its own
    // screen and receives no mail. Distinguished from an absent key, which means
    // "leave it alone".
    notifyEmail: z.string().trim().email().max(320).nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.notifyEmail !== undefined || value.active !== undefined, {
    message: 'Supply notifyEmail or active.',
  });

const createOutletDeviceSchema = z
  .object({
    // This names the station in the immutable redemption history. It is a
    // physical device or counter, not a person whose shift may have ended.
    label: z.string().trim().min(1).max(200),
  })
  .strict();

/** Never select the token hash into an admin response. */
const DEVICE_VIEW = {
  id: true,
  fullName: true,
  status: true,
  createdAt: true,
  outletId: true,
  outletTokenIssuedAt: true,
  outletTokenLastUsedAt: true,
} as const;

const adminOutletRoutes: FastifyPluginAsync = async (app) => {
  // ── GET /admin/outlets/manage ─────────────────────────────────────────
  // Every outlet, its notification address, and its devices. Separate from
  // `GET /admin/outlets`, which exists only to fill a dropdown and deliberately
  // returns no operational detail.
  app.get('/admin/outlets/manage', { config: { permission: 'outlets:manage' } }, async () => {
    const outlets = await app.prisma.outlet.findMany({
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        kind: true,
        active: true,
        notifyEmail: true,
        staff: {
          where: { role: 'OUTLET_STAFF', authMethod: 'TOKEN' },
          orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
          select: DEVICE_VIEW,
        },
      },
    });

    return {
      outlets: outlets.map(({ staff, ...outlet }) => ({
        ...outlet,
        devices: staff,
      })),
    };
  });

  // ── PATCH /admin/outlets/:id ──────────────────────────────────────────
  app.patch('/admin/outlets/:id', { config: { permission: 'outlets:manage' } }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const body = updateOutletSchema.parse(request.body);
    const principal = request.principal;
    if (!principal) {
      throw new ForbiddenError();
    }

    const existing = await app.prisma.outlet.findUnique({
      where: { id },
      select: { id: true, active: true },
    });
    if (!existing) {
      throw new NotFoundError();
    }

    const updated = await app.prisma.$transaction(async (tx) => {
      const outlet = await tx.outlet.update({
        where: { id },
        data: {
          ...(body.notifyEmail !== undefined ? { notifyEmail: body.notifyEmail } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
        },
        select: { id: true, name: true, kind: true, active: true, notifyEmail: true },
      });

      // Closing an outlet ends every derived session. Keep standing device
      // hashes so reopening permits a fresh token exchange, but incrementing the
      // version makes pre-close access JWTs stay dead after the outlet reopens.
      if (existing.active && body.active === false) {
        const devices = await tx.staffUser.findMany({
          where: { outletId: id, role: 'OUTLET_STAFF', authMethod: 'TOKEN' },
          select: { id: true },
        });
        const deviceIds = devices.map((device) => device.id);
        if (deviceIds.length > 0) {
          await tx.staffUser.updateMany({
            where: { id: { in: deviceIds } },
            data: { tokenVersion: { increment: 1 } },
          });
          await tx.refreshToken.updateMany({
            where: {
              subjectId: { in: deviceIds },
              subjectType: 'STAFF',
              revokedAt: null,
            },
            data: { revokedAt: new Date() },
          });
        }
      }

      return outlet;
    });

    await writeAudit(app.prisma, {
      action: 'outlet.updated',
      principal,
      subjectType: 'Outlet',
      subjectId: id,
      // Whether an address is set, never the address itself — an outlet mailbox is
      // not member data, but §9's rule is "no addresses in the trail" and there is
      // no reason to make an exception for one.
      metadata: {
        notifyEmailSet: body.notifyEmail !== undefined ? body.notifyEmail !== null : null,
        active: body.active ?? null,
      },
      ipAddress: request.ip,
    });

    return updated;
  });

  // ── POST /admin/outlets/:id/devices ───────────────────────────────────
  // A device is one scoped StaffUser. That deliberately reuses tokenVersion,
  // refresh-family revocation, permissions, scoping and immutable attribution
  // instead of introducing a second kind of principal that could drift.
  // Provision one independently revocable token per counter device.
  app.post(
    '/admin/outlets/:id/devices',
    { config: { permission: 'outlets:manage' } },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const body = createOutletDeviceSchema.parse(request.body);
      const principal = request.principal;
      if (!principal) throw new ForbiddenError();

      const outlet = await app.prisma.outlet.findUnique({
        where: { id },
        select: { id: true, active: true },
      });
      if (!outlet) throw new NotFoundError();
      if (!outlet.active) {
        return reply.code(422).send({
          error: 'outlet_inactive',
          message: 'Reopen the outlet before giving a device access.',
        });
      }

      // The plaintext is returned once; only this digest is persisted.
      const token = generateOutletLoginToken();
      const created = await app.prisma.staffUser.create({
        data: {
          fullName: body.label,
          email: null,
          role: 'OUTLET_STAFF',
          outletId: outlet.id,
          authMethod: 'TOKEN',
          passwordHash: null,
          outletTokenHash: hashOutletLoginToken(token),
          outletTokenIssuedAt: new Date(),
        },
        select: DEVICE_VIEW,
      });

      await writeAudit(app.prisma, {
        action: 'outlet.device_created',
        principal,
        subjectType: 'StaffUser',
        subjectId: created.id,
        metadata: { outletId: outlet.id },
        ipAddress: request.ip,
      });

      return reply.code(201).send({ device: created, token });
    },
  );

  // Rotation replaces only this device's standing credential and sessions.
  app.post(
    '/admin/outlets/devices/:id/rotate',
    { config: { permission: 'outlets:manage' } },
    async (request, reply) => {
      const { id } = uuidParamSchema.parse(request.params);
      const principal = request.principal;
      if (!principal) throw new ForbiddenError();

      const existing = await app.prisma.staffUser.findFirst({
        where: { id, role: 'OUTLET_STAFF', authMethod: 'TOKEN' },
        select: {
          id: true,
          status: true,
          outletId: true,
          tokenVersion: true,
          outlet: { select: { active: true } },
        },
      });
      if (!existing) throw new NotFoundError();
      if (existing.status !== 'ACTIVE') {
        return reply.code(422).send({
          error: 'device_revoked',
          message: 'A revoked device cannot be rotated. Issue a new device token instead.',
        });
      }
      if (!existing.outlet?.active) {
        return reply.code(422).send({
          error: 'outlet_inactive',
          message: 'Reopen the outlet before rotating a device token.',
        });
      }

      const token = generateOutletLoginToken();
      const now = new Date();
      const updated = await app.prisma.$transaction(async (tx) => {
        // Optimistic version matching prevents two simultaneous rotations from
        // both reporting success while only the second token remains usable. It
        // also makes a concurrent revoke win instead of resurrecting its hash.
        const changed = await tx.staffUser.updateMany({
          where: {
            id,
            role: 'OUTLET_STAFF',
            authMethod: 'TOKEN',
            status: 'ACTIVE',
            tokenVersion: existing.tokenVersion,
          },
          data: {
            outletTokenHash: hashOutletLoginToken(token),
            outletTokenIssuedAt: now,
            outletTokenLastUsedAt: null,
            tokenVersion: { increment: 1 },
          },
        });
        if (changed.count !== 1) return null;

        await tx.refreshToken.updateMany({
          where: { subjectId: id, subjectType: 'STAFF', revokedAt: null },
          data: { revokedAt: now },
        });
        return tx.staffUser.findUniqueOrThrow({ where: { id }, select: DEVICE_VIEW });
      });

      if (updated === null) {
        return reply.code(409).send({
          error: 'device_changed',
          message: 'That device changed while its token was being rotated. Reload and try again.',
        });
      }

      await writeAudit(app.prisma, {
        action: 'outlet.device_rotated',
        principal,
        subjectType: 'StaffUser',
        subjectId: id,
        metadata: { outletId: existing.outletId },
        ipAddress: request.ip,
      });
      return reply.code(200).send({ device: updated, token });
    },
  );

  // Primary device revocation destroys the standing credential as well as every derived
  // session. A recovered tablet receives a fresh device entry; a possibly
  // copied token is never brought back to life.
  app.post(
    '/admin/outlets/devices/:id/revoke',
    { config: { permission: 'outlets:manage' } },
    async (request, reply) => {
      const { id } = uuidParamSchema.parse(request.params);
      const principal = request.principal;
      if (!principal) throw new ForbiddenError();

      const existing = await app.prisma.staffUser.findFirst({
        where: { id, role: 'OUTLET_STAFF', authMethod: 'TOKEN' },
        select: { id: true, status: true, outletId: true },
      });
      if (!existing) throw new NotFoundError();
      if (existing.status === 'SUSPENDED') {
        return reply.code(200).send({ id, status: 'SUSPENDED', changed: false });
      }

      const now = new Date();
      const changed = await app.prisma.$transaction(async (tx) => {
        // Deliberately no tokenVersion predicate: if rotation obtained the row
        // lock first, revocation waits and then suspends the newly rotated state.
        // If revocation won first, the ACTIVE condition prevents rotation from
        // putting a digest back on the suspended row.
        const suspended = await tx.staffUser.updateMany({
          where: { id, role: 'OUTLET_STAFF', authMethod: 'TOKEN', status: 'ACTIVE' },
          data: {
            status: 'SUSPENDED',
            outletTokenHash: null,
            tokenVersion: { increment: 1 },
          },
        });
        if (suspended.count !== 1) return false;

        await tx.refreshToken.updateMany({
          where: { subjectId: id, subjectType: 'STAFF', revokedAt: null },
          data: { revokedAt: now },
        });
        return true;
      });

      if (!changed) {
        return reply.code(200).send({ id, status: 'SUSPENDED', changed: false });
      }

      await writeAudit(app.prisma, {
        action: 'outlet.device_revoked',
        principal,
        subjectType: 'StaffUser',
        subjectId: id,
        metadata: { outletId: existing.outletId },
        ipAddress: request.ip,
      });
      return reply.code(200).send({ id, status: 'SUSPENDED', changed: true });
    },
  );

};

export default adminOutletRoutes;
