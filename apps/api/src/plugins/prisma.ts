import { PrismaClient } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

/**
 * Decorates the instance with a Prisma client and closes it with the server.
 *
 * The client connects lazily on first query rather than at boot, so `GET /health`
 * stays a liveness probe that does not depend on the database. `GET /health/ready`
 * is the readiness probe that actually exercises the connection.
 */
const prismaPlugin: FastifyPluginAsync = async (app) => {
  const prisma = new PrismaClient();

  app.decorate('prisma', prisma);

  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });
};

export default fp(prismaPlugin, { name: 'prisma' });
