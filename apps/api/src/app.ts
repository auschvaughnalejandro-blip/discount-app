import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

import type { Env } from './config/env.js';
import { REDACTED, REDACT_PATHS, redact } from './logging/redaction.js';
import { createCodeSender, type CodeSender } from './notifications/code-sender.js';
import authorizationPlugin from './plugins/authorization.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import googleSheetsPlugin from './plugins/google-sheets.js';
import prismaPlugin from './plugins/prisma.js';
import requestExpiryPlugin from './plugins/request-expiry.js';
import adminMemberRoutes from './routes/admin-members.js';
import adminOutletRoutes from './routes/admin-outlets.js';
import adminStaffRoutes from './routes/admin-staff.js';
import authRoutes from './routes/auth.js';
import benefitRoutes from './routes/benefits.js';
import healthRoutes from './routes/health.js';
import memberRoutes from './routes/member.js';
import outletRoutes from './routes/outlet.js';
import reportRoutes from './routes/reports.js';
import requestRoutes from './routes/requests.js';
import redemptionRoutes from './routes/redemptions.js';

declare module 'fastify' {
  interface FastifyInstance {
    env: Env;
    /** Stage 18. Delivers one-time passcodes; see notifications/code-sender.ts. */
    codeSender: CodeSender;
  }
}

export interface BuildAppOptions {
  env: Env;
  /** Test seam for observing delivery without opening a real SMTP connection. */
  codeSender?: CodeSender;
}

export async function buildApp({ env, codeSender }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    // Settled by configuration rather than left at its default: see
    // TRUST_PROXY in config/env.ts for why both values are dangerous in the
    // wrong deployment.
    trustProxy: env.TRUST_PROXY,
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
  });

  await app.register(
    fp(async (instance) => {
      instance.decorate('env', env);
    }, { name: 'env' }),
  );

  // Parses the refresh cookie. Registered before the routes that read it, and
  // deliberately unsigned: the value is already a high-entropy opaque token
  // matched against a stored hash, so a signature would add a second secret
  // and no security.
  await app.register(cookie);

  await app.register(errorHandlerPlugin);
  await app.register(prismaPlugin);
  await app.register(googleSheetsPlugin);
  await app.register(requestExpiryPlugin);

  // Built once, before routes. `createCodeSender` throws on a channel that is
  // configured but incomplete, so a deployment meaning to send mail and unable
  // to fails at startup rather than at a member's first sign-in attempt.
  await app.register(
    fp(
      async (instance) => {
        instance.decorate('codeSender', codeSender ?? (await createCodeSender(env, instance.log)));
      },
      { name: 'code-sender' },
    ),
  );

  // Registered before any routes: its onRoute hook only sees routes added
  // after it, so every route file below is covered and none can opt out by
  // being registered earlier (R17).
  await app.register(authorizationPlugin);

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(adminMemberRoutes);
  await app.register(adminStaffRoutes);
  await app.register(adminOutletRoutes);
  await app.register(memberRoutes);
  await app.register(benefitRoutes);
  await app.register(requestRoutes);
  await app.register(redemptionRoutes);
  await app.register(outletRoutes);
  await app.register(reportRoutes);

  return app;
}
