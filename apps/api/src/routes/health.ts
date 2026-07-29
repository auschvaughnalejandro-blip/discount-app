import { healthResponseSchema, type HealthResponse } from '@pgp/shared';
import type { FastifyPluginAsync } from 'fastify';

/**
 * Stage 3 introduces the route wrapper that requires every route to declare a
 * permission (R17). These two are the only unauthenticated probes and will be
 * registered through that wrapper's explicit public escape hatch.
 */
const healthRoutes: FastifyPluginAsync = async (app) => {
  // Liveness. Deliberately touches nothing — it must answer while the database
  // is down, otherwise it cannot distinguish a dead process from a dead database.
  app.get('/health', async (): Promise<HealthResponse> => {
    return healthResponseSchema.parse({ status: 'ok' });
  });

  // Readiness. Proves the Prisma client can reach PostgreSQL.
  app.get('/health/ready', async (_request, reply) => {
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
