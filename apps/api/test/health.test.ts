import { healthResponseSchema } from '@pgp/shared';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

describe('GET /health', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      // Liveness must not touch the database, so the test deliberately supplies
      // a URL that points nowhere.
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
      // Not exercised by a /health-only test, but loadEnv validates every
      // required variable at startup regardless of which routes are hit —
      // that's the point of validating eagerly rather than at first use.
      PASSWORD_PEPPER: 'unused-but-must-be-present-32-chars',
      OTP_CODE_HMAC_SECRET: 'unused-but-must-be-present-32-chars',
      JWT_ISSUER: 'unused',
      JWT_AUDIENCE_MEMBER: 'unused',
      JWT_AUDIENCE_STAFF: 'unused',
      JWT_SIGNING_KEY: 'unused-but-must-be-present-32-chars',
    });

    app = await buildApp({ env });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with a well-formed body', async () => {
    const response = await request(app.server).get('/health');

    expect(response.status).toBe(200);
    expect(healthResponseSchema.parse(response.body)).toEqual({ status: 'ok' });
  });

  it('answers while the database is unreachable', async () => {
    const response = await request(app.server).get('/health');

    expect(response.status).toBe(200);
  });
});
