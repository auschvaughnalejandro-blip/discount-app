import { healthResponseSchema, type HealthResponse } from '@pgp/shared';
import type { FastifyPluginAsync } from 'fastify';

/**
 * Both probes are `public` — deliberately, and declared as such (R17). A
 * liveness probe that required a token could not report on a process whose
 * auth dependencies were the thing that was broken.
 *
 * Neither returns anything about members, benefits or configuration.
 */
const healthRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Opening the API in a browser is a natural thing to do and used to answer
   * with a bare 404, which reads as "broken" rather than "you want a different
   * port". This says what the process is and where the pages are.
   *
   * It lists the two front ends and nothing else — no route table, no
   * version, no configuration. Which endpoints exist is not a secret, but a
   * ready-made map of them is a courtesy to nobody but an attacker.
   */
  app.get('/', { config: { permission: 'public' } }, async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(
      `<!doctype html>
<title>Privilege Guest Program API</title>
<h1>Privilege Guest Program &mdash; API</h1>
<p>This is the backend. There is no page here; it serves the two front ends.</p>
<ul>
  <li><a href="http://localhost:5173">localhost:5173</a> &mdash; member app (guests)</li>
  <li><a href="http://localhost:5175">localhost:5175</a> &mdash; admin dashboard (the hotel)</li>
</ul>
<p>Each needs its own dev server running. From the repository root:
<code>npm run dev</code> starts all three, or <code>npm run dev:member</code>
and friends start one at a time.</p>
<p>Liveness: <a href="/health">/health</a> &middot;
Readiness: <a href="/health/ready">/health/ready</a></p>
`,
    );
  });

  /**
   * Settings a client needs before anyone has signed in.
   *
   * Only the dialling code today. It lives here rather than as a constant in
   * each client for the same reason no benefit percentage does: a second
   * property in another country must be a configuration change, not a release.
   *
   * Public because it has to be — the activation screen shows it before there
   * is any principal — and safe because it discloses nothing. Anything that
   * would not go on a poster does not belong in this response.
   */
  app.get('/config', { config: { permission: 'public' } }, async () => {
    return { defaultCountryCode: app.env.DEFAULT_PHONE_COUNTRY_CODE };
  });

  // Liveness. Deliberately touches nothing — it must answer while the database
  // is down, otherwise it cannot distinguish a dead process from a dead database.
  app.get('/health', { config: { permission: 'public' } }, async (): Promise<HealthResponse> => {
    return healthResponseSchema.parse({ status: 'ok' });
  });

  // Readiness. Proves the Prisma client can reach PostgreSQL.
  app.get('/health/ready', { config: { permission: 'public' } }, async (_request, reply) => {
    try {
      await app.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'up' };
    } catch {
      // The reason is logged by the error handler; the body stays uninformative.
      return reply.code(503).send({ status: 'unavailable', database: 'down' });
    }
  });
};

export default healthRoutes;
