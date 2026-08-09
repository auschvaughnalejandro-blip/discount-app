import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { requireGoogleSheetsConfig } from '../integrations/google-sheets/config.js';
import { syncGoogleSheets } from '../integrations/google-sheets/sync.js';

function errorCategory(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return 'unknown';
  }

  const candidate = error as {
    code?: unknown;
    response?: { status?: unknown };
  };
  const status = candidate.response?.status ?? candidate.code;

  if (status === 401) return 'authentication';
  if (status === 403) return 'permission';
  if (status === 404) return 'spreadsheet_not_found';
  if (status === 429) return 'quota';
  return 'provider_error';
}

/**
 * Optional eventual-consistency worker. It is deliberately detached from
 * request handlers: a Google outage can make the mirror stale, but cannot make
 * a member creation or redemption fail.
 */
const googleSheetsPlugin: FastifyPluginAsync = async (app) => {
  if (!app.env.GOOGLE_SHEETS_SYNC_ENABLED) {
    return;
  }

  const config = requireGoogleSheetsConfig(app.env);
  // The official client is intentionally lazy. It is a substantial dependency,
  // and a deployment with the optional mirror disabled should not load it at
  // startup or make every API test pay its import cost.
  const { createGoogleSheetsPublisher } = await import(
    '../integrations/google-sheets/publisher.js'
  );
  const publisher = createGoogleSheetsPublisher(config);
  let interval: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;

  function startSync(): void {
    if (inFlight !== undefined) {
      app.log.debug({ integration: 'google_sheets' }, 'Google Sheets sync already running');
      return;
    }

    const startedAt = Date.now();
    inFlight = syncGoogleSheets(app.prisma, publisher)
      .then((result) => {
        app.log.info(
          {
            integration: 'google_sheets',
            generatedAt: result.generatedAt,
            rows: result.rows,
            durationMs: Date.now() - startedAt,
          },
          'Google Sheets mirror updated',
        );
      })
      .catch((error: unknown) => {
        // Do not pass the provider error object to the logger. Auth libraries
        // may attach request configuration, including credentials, to it.
        app.log.error(
          {
            integration: 'google_sheets',
            category: errorCategory(error),
            durationMs: Date.now() - startedAt,
          },
          'Google Sheets mirror update failed; PostgreSQL remains available',
        );
      })
      .finally(() => {
        inFlight = undefined;
      });
  }

  app.addHook('onReady', async () => {
    // Do not await: readiness describes the authoritative API/database path,
    // not whether an optional reporting destination is reachable.
    startSync();
    interval = setInterval(startSync, config.intervalSeconds * 1_000);
    interval.unref();
  });

  app.addHook('onClose', async () => {
    if (interval !== undefined) {
      clearInterval(interval);
    }
    await inFlight;
  });
};

export default fp(googleSheetsPlugin, {
  name: 'google-sheets-mirror',
  dependencies: ['env', 'prisma'],
});
