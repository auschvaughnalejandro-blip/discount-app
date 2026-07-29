import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { ForbiddenError, UnauthorizedError } from '../errors.js';
import { writeAudit } from '../security/audit.js';
import {
  actorFor,
  isRoutePermission,
  roleHasPermission,
  type RoutePermission,
} from '../security/permissions.js';
import { PrincipalResolutionError, resolvePrincipal, type Principal } from '../security/principal.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Required on every route. Omitting it fails application startup (R17).
     * `'public'` is the explicit, greppable opt-out.
     */
    permission?: RoutePermission;
  }

  interface FastifyRequest {
    /** Set for every non-public route before the handler runs. */
    principal?: Principal;
  }
}

/**
 * R17 — deny by default, enforced at boot.
 *
 * The `onRoute` hook fires for every route registered after this plugin,
 * however it was registered — including a plain `app.get()` that bypasses any
 * helper or wrapper. That is the point: a wrapper you must remember to call
 * is exactly the control that fails under deadline. Here, forgetting to
 * declare a permission is not a hole discovered in production, it is a server
 * that will not start.
 *
 * Throwing inside `onRoute` rejects the enclosing plugin registration, which
 * `app.ready()` and `app.listen()` both surface — the process exits non-zero
 * instead of serving an unprotected endpoint.
 */
const authorizationPlugin: FastifyPluginAsync = async (app) => {
  app.addHook('onRoute', (routeOptions) => {
    const { permission } = routeOptions.config ?? {};
    const where = `${String(routeOptions.method)} ${routeOptions.url}`;

    if (permission === undefined) {
      throw new Error(
        `Route ${where} does not declare a permission. Every route must set ` +
          `config.permission to a known permission, or explicitly to 'public'. ` +
          `See src/security/permissions.ts.`,
      );
    }

    if (!isRoutePermission(permission)) {
      throw new Error(
        `Route ${where} declares an unknown permission ${JSON.stringify(permission)}. ` +
          `See PERMISSIONS in src/security/permissions.ts.`,
      );
    }
  });

  app.addHook('preHandler', async (request) => {
    // No route matched this path. There is nothing to authorize, and the
    // not-found handler must be allowed to answer: a 403 here would both be
    // wrong and make an unknown path distinguishable from a known one the
    // caller may not use.
    if (request.routeOptions?.url === undefined) {
      return;
    }

    const { permission } = request.routeOptions.config ?? {};

    // Unreachable for a started server — onRoute rejects both cases at boot.
    // Kept because "fail closed" means the runtime does not assume the boot
    // check ran.
    if (permission === undefined || !isRoutePermission(permission)) {
      throw new ForbiddenError();
    }

    if (permission === 'public') {
      return;
    }

    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedError();
    }
    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      throw new UnauthorizedError();
    }

    // The audience a token must carry is determined by the route's own
    // permission, not by anything in the token. A member-app token presented
    // to a staff route fails audience validation rather than being inspected
    // and then rejected (security-implementation.md §4: "A token minted for
    // the member app must not be accepted by the admin API").
    const actor = actorFor(permission);
    const audience =
      actor === 'MEMBER' ? request.server.env.JWT_AUDIENCE_MEMBER : request.server.env.JWT_AUDIENCE_STAFF;

    let principal: Principal;
    try {
      principal = await resolvePrincipal(request.server.prisma, token, {
        issuer: request.server.env.JWT_ISSUER,
        audience,
      });
    } catch (error) {
      if (error instanceof PrincipalResolutionError) {
        throw new UnauthorizedError();
      }
      throw error;
    }

    if (principal.subjectType !== actor) {
      throw new UnauthorizedError();
    }

    if (principal.subjectType === 'STAFF') {
      if (!principal.role || !roleHasPermission(principal.role, permission)) {
        // §9: every authorization denial is logged, so a spike in them is
        // visible. Written before the throw, since the throw ends the request.
        await writeAudit(request.server.prisma, {
          action: 'authorization.denied',
          principal,
          subjectType: 'Route',
          metadata: {
            permission,
            method: request.method,
            url: request.routeOptions.url ?? request.url,
            role: principal.role ?? null,
          },
          ipAddress: request.ip,
        });

        // 403, not 404: this is about the route, which is not a secret. A
        // record the caller may not see returns 404 — see errors.ts and
        // src/security/scope.ts.
        throw new ForbiddenError();
      }
    }

    request.principal = principal;
  });
};

export default fp(authorizationPlugin, { name: 'authorization' });
