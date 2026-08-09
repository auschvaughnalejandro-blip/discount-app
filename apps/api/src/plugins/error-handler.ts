import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';

import { HttpError, RateLimitedError } from '../errors.js';

/**
 * Maps thrown errors to responses.
 *
 * Response bodies carry a stable machine-readable `error` code and a generic
 * message. They never carry the underlying reason: which claim failed, which
 * field mismatched, whether a record exists but is out of scope. The detail
 * goes to the server log, where Stage 9's redaction layer will handle it.
 */
const errorHandlerPlugin: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof RateLimitedError) {
      reply.header('Retry-After', String(error.retryAfterSeconds));
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }

    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }

    // §8: schema validation at the edge. Zod's `.strict()` schemas reject
    // unknown fields rather than ignoring them, which is what makes
    // mass-assignment impossible — but the caller is told only that the body
    // was invalid, not which field gave them away.
    if (error instanceof ZodError) {
      request.log.info({ issues: error.issues.length }, 'request body rejected by schema');
      return reply.code(400).send({ error: 'invalid_request', message: 'Invalid request.' });
    }

    /**
     * A unique constraint the handler did not anticipate.
     *
     * Prisma raises P2002 when a write collides with a unique index. Left
     * unmapped it becomes a 500, which reads as "the server is broken" when the
     * truth is "that value is already taken" — and 500s are what people stop
     * reporting because they assume nothing can be done.
     *
     * Handlers that can name the conflict should still check for it first and
     * say which record holds the value; this is the backstop for the race
     * between that check and the write, and for constraints nobody predicted.
     * Deliberately generic: which field collided can be a disclosure on an
     * endpoint that has no business confirming a value exists.
     */
    const code: unknown = (error as { code?: unknown }).code;
    if (code === 'P2002') {
      request.log.warn({ err: error }, 'unique constraint violated');
      return reply.code(409).send({
        error: 'already_exists',
        message: 'That value is already in use.',
      });
    }

    // Fastify's own body parsing and validation errors carry a statusCode.
    const statusCode: unknown = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: 'invalid_request', message: 'Invalid request.' });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error', message: 'Internal error.' });
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send({ error: 'not_found', message: 'Not found.' });
  });
};

export default fp(errorHandlerPlugin, { name: 'error-handler' });
