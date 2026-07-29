import Fastify, { type FastifyInstance } from 'fastify';

import type { Env } from './config/env.js';
import prismaPlugin from './plugins/prisma.js';
import healthRoutes from './routes/health.js';

export interface BuildAppOptions {
  env: Env;
}

export async function buildApp({ env }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Stage 9 adds the redaction layer that keeps member names, phone numbers
      // and email addresses out of application logs. Until then, nothing that
      // could carry member data is logged.
    },
    // `trustProxy` has to be settled before per-IP rate limiting (Stage 2) and
    // audit IP capture (Stage 9) can be believed. Left at its default until the
    // deployment topology is known.
  });

  await app.register(prismaPlugin);
  await app.register(healthRoutes);

  return app;
}
