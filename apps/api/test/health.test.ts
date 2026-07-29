import { healthResponseSchema } from '@pgp/shared';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

describe('GET /health', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Starts from the real environment (test/setup.ts loads apps/api/.env) and
    // overrides only what this test is about. Listing every required variable
    // by hand meant every stage that added one broke this file for no reason.
    const env = loadEnv({
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      // Liveness must not touch the database, so the test deliberately points
      // at a URL that goes nowhere.
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
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
