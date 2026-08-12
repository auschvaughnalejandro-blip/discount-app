import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { expireStaleRequests } from '../routes/requests.js';

/**
 * Closes out notices nobody ever confirmed.
 *
 * A guest announces themselves, then changes their mind and eats somewhere else.
 * Nothing is wrong, but the row stays `SENT` — so without this an outlet screen
 * slowly fills with people who are not coming, and the guest's own app keeps
 * saying "the restaurant has been told" about a Tuesday four weeks ago.
 *
 * Detached from every request handler on purpose, for the same reason the Sheets
 * mirror is: a slow or failing sweep must not be able to make a guest wait or a
 * confirmation fail.
 *
 * Runs in this process, on a timer. That assumes the single API instance the
 * deployment documents — two instances would both sweep, which is harmless here
 * (the update is idempotent and conditional on `status = 'SENT'`) but is still
 * worth knowing before anybody scales this out. The same caveat applies to the
 * in-memory rate limiter, and both want the same external scheduler if that day
 * comes.
 */
const requestExpiryPlugin: FastifyPluginAsync = async (app) => {
  let interval: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;

  function sweep(): void {
    if (inFlight !== undefined) {
      return;
    }

    const startedAt = Date.now();
    inFlight = expireStaleRequests(app.prisma, app.env.REQUEST_EXPIRY_HOURS)
      .then((count) => {
        // Silent when there is nothing to do. A log line every fifteen minutes
        // saying "closed 0" is noise that trains people to stop reading logs.
        if (count > 0) {
          app.log.info(
            { closed: count, durationMs: Date.now() - startedAt },
            'closed benefit requests nobody confirmed',
          );
        }
      })
      .catch((error: unknown) => {
        app.log.error(
          { err: error instanceof Error ? error.name : 'unknown' },
          'benefit request expiry sweep failed',
        );
      })
      .finally(() => {
        inFlight = undefined;
      });
  }

  app.addHook('onReady', async () => {
    // Not awaited: readiness describes the API and database, not whether a
    // housekeeping pass has finished.
    sweep();
    interval = setInterval(sweep, app.env.REQUEST_EXPIRY_SWEEP_INTERVAL_SECONDS * 1_000);
    // Unreferenced so the timer cannot hold the process open — a test suite that
    // builds an app and closes it must be able to exit.
    interval.unref();
  });

  app.addHook('onClose', async () => {
    if (interval !== undefined) {
      clearInterval(interval);
    }
    await inFlight;
  });
};

export default fp(requestExpiryPlugin, {
  name: 'request-expiry',
  dependencies: ['env', 'prisma'],
});
