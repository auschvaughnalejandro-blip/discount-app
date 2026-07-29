import type { FastifyPluginAsync } from 'fastify';

import { NotFoundError } from '../errors.js';
import { issueIdentityCode } from '../security/identity-codes.js';
import { scopeForMember, scopedWhere } from '../security/scope.js';

/**
 * The digital card's rotating credential (wireframes screen 7).
 *
 * `POST /verify/resolve` — the staff side of this — belongs to Stage 7, which
 * owns member resolution and the entitlements it returns.
 */
const identityRoutes: FastifyPluginAsync = async (app) => {
  // ── GET /member/me/identity-code ──────────────────────────────────────
  app.get(
    '/member/me/identity-code',
    { config: { permission: 'member:self' } },
    async (request) => {
      const principal = request.principal;
      if (!principal) {
        throw new NotFoundError();
      }

      const member = await app.prisma.member.findFirst({
        where: scopedWhere({}, scopeForMember(principal)),
        select: { id: true, status: true },
      });

      if (!member || member.status !== 'ACTIVE') {
        throw new NotFoundError();
      }

      // Signed over the opaque internal id, never the printed PG number (R3).
      // A fresh `issuedAt` on every call is what makes the code rotate: the
      // app regenerates it, and yesterday's screenshot falls outside the
      // window (§7).
      const payload = issueIdentityCode(member.id);

      return {
        payload,
        // So the client knows when to regenerate. Read from configuration —
        // changing the window must not need a code change (R9).
        windowHours: app.env.IDENTITY_CODE_WINDOW_HOURS,
        issuedAt: new Date().toISOString(),
      };
    },
  );
};

export default identityRoutes;
