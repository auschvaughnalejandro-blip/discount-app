import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Env } from '../config/env.js';

/**
 * The refresh token, in a cookie the page cannot read.
 *
 * ## Why a cookie and not `localStorage`
 *
 * security-implementation.md §4 asks for `httpOnly; Secure; SameSite=Strict`
 * and forbids `localStorage`, because any XSS flaw against web storage becomes
 * total account theft — for every member who ever opened the app, silently,
 * with sessions valid for thirty days.
 *
 * The clients previously held tokens in a module variable instead. That was the
 * right call over `localStorage` and it cost a sign-in on every page reload,
 * because a reload tears the page down and takes the variable with it. A
 * member who has to request a passcode every time they open the app is a member
 * who stops opening the app.
 *
 * An `httpOnly` cookie is held by the *browser* rather than the page: it
 * survives a reload, and `document.cookie` cannot see it. Persistence without
 * giving up the property that made memory worth the friction.
 *
 * ## Why this needs no CSRF token
 *
 * The usual objection to cookies is that the browser attaches them to requests
 * another site triggered. Three things together close that here:
 *
 *   1. `SameSite=Strict` — the browser does not send it on any cross-site
 *      request at all, which is the whole attack.
 *   2. `path` — it is sent only to the authentication namespace. No
 *      application-data route receives it, and only refresh/logout handlers read
 *      it; the other authentication handlers ignore cookies.
 *   3. The refresh response is unreadable cross-origin. An attacker who somehow
 *      triggered a refresh could not see the tokens it returned.
 *
 * The worst outcome left is that somebody forces a token rotation and logs the
 * victim out. That is a nuisance, not a compromise. **A CSRF token becomes
 * necessary the moment any state-changing route authenticates by cookie** —
 * none does; every other endpoint takes a bearer token in a header, which a
 * cross-site request cannot set.
 */

export const REFRESH_COOKIE = 'pgp_refresh';

/**
 * Browser-visible path, before Vite/Caddy strip the `/api` prefix. Refresh and
 * logout are sibling routes, so their narrowest common cookie path is the auth
 * namespace. No outlet, member or admin data route receives it, and the other
 * auth handlers never read it. Using the internal `/auth/refresh` path here
 * leaves browsers unable to send it to the actual `/api/auth/refresh` request.
 */
export const REFRESH_COOKIE_PATH = '/api/auth';

function baseOptions(env: Env) {
  return {
    httpOnly: true,
    // Only over HTTPS — except on localhost, where there is none and the
    // browser would silently drop the cookie, making development look broken
    // for a reason no error mentions.
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: REFRESH_COOKIE_PATH,
  };
}

export function setRefreshCookie(
  reply: FastifyReply,
  env: Env,
  token: string,
  ttlSeconds: number,
): void {
  reply.setCookie(REFRESH_COOKIE, token, { ...baseOptions(env), maxAge: ttlSeconds });
}

export function clearRefreshCookie(reply: FastifyReply, env: Env): void {
  // Same attributes as when it was set, or the browser treats it as a different
  // cookie and leaves the original in place.
  reply.clearCookie(REFRESH_COOKIE, baseOptions(env));
}

/**
 * The refresh token for this request: the cookie, or the body.
 *
 * The body is still accepted so a native shell — which has a keystore and no
 * cookie jar — keeps working, and so this change does not invalidate every
 * session the moment it deploys. The cookie is preferred where both are
 * present.
 */
export function readRefreshToken(
  request: FastifyRequest,
  body: { refreshToken?: string | undefined },
): string | undefined {
  const cookie = request.cookies?.[REFRESH_COOKIE];
  return cookie ?? body.refreshToken;
}
