import Fastify, { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

import type { Env } from './config/env.js';
import prismaPlugin from './plugins/prisma.js';
import authRoutes from './routes/auth.js';
import healthRoutes from './routes/health.js';

declare module 'fastify' {
  interface FastifyInstance {
    env: Env;
  }
}

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
    // `trustProxy` has to be settled before per-IP rate limiting and audit IP
    // capture (Stage 9) can be believed. Left at its default until the
    // deployment topology is known.
  });

  await app.register(fp(async (instance) => {
    instance.decorate('env', env);
  }));

  await app.register(prismaPlugin);
  await app.register(healthRoutes);
  // Stage 3 introduces the route wrapper that requires every route to declare
  // a permission (R17) and fails startup on an undeclared one. These auth
  // routes are the deliberately public exceptions — you cannot authenticate
  // through an endpoint that itself requires authentication — and will be
  // registered through that wrapper's explicit public escape hatch once it
  // exists, same as the health routes.
  await app.register(authRoutes);

  return app;
}
