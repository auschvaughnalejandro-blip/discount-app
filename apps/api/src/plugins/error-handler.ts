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
