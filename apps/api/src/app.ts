import Fastify, { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

import type { Env } from './config/env.js';
import { REDACTED, REDACT_PATHS, redact } from './logging/redaction.js';
import authorizationPlugin from './plugins/authorization.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import prismaPlugin from './plugins/prisma.js';
import adminMemberRoutes from './routes/admin-members.js';
import authRoutes from './routes/auth.js';
import benefitRoutes from './routes/benefits.js';
import healthRoutes from './routes/health.js';
import identityRoutes from './routes/identity.js';
import memberRoutes from './routes/member.js';
import reportRoutes from './routes/reports.js';
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
      // §9: "Application logs contain no member names, phone numbers or email
      // addresses. Enforce with a redaction layer on the logger rather than by
      // convention." Paths cover the shapes pino logs itself; the serializers
      // walk anything a caller passes, so `log.info({ member })` is safe even
      // though nobody anticipated that call.
      redact: { paths: REDACT_PATHS, censor: REDACTED },
      serializers: {
        member: redact,
        members: redact,
        body: redact,
        user: redact,
        staff: redact,
        principal: redact,
        data: redact,
      },
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
  await app.register(reportRoutes);

  return app;
}
