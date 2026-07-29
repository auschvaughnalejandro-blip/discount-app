import Fastify, { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

import type { Env } from './config/env.js';
import authorizationPlugin from './plugins/authorization.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import prismaPlugin from './plugins/prisma.js';
import adminMemberRoutes from './routes/admin-members.js';
import authRoutes from './routes/auth.js';
import benefitRoutes from './routes/benefits.js';
import healthRoutes from './routes/health.js';
import identityRoutes from './routes/identity.js';
import memberRoutes from './routes/member.js';
import verifyRoutes from './routes/verify.js';

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

  await app.register(
    fp(async (instance) => {
      instance.decorate('env', env);
    }, { name: 'env' }),
  );

  await app.register(errorHandlerPlugin);
  await app.register(prismaPlugin);

  // Registered before any routes: its onRoute hook only sees routes added
  // after it, so every route file below is covered and none can opt out by
  // being registered earlier (R17).
  await app.register(authorizationPlugin);

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(adminMemberRoutes);
  await app.register(memberRoutes);
  await app.register(benefitRoutes);
  await app.register(identityRoutes);
  await app.register(verifyRoutes);

  return app;
}
