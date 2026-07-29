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
