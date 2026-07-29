import { connect } from 'node:net';

import { buildApp } from './app.js';
import { loadEnv, type Env } from './config/env.js';

/** The three front ends, and the ports their dev servers use. */
const FRONT_ENDS = [
  { port: 5173, name: 'Member app (customers)' },
  { port: 5174, name: 'Verification page (staff)' },
  { port: 5175, name: 'Admin dashboard (owner)' },
] as const;

function isPortOpen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(300);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * Says plainly which front ends are running and which are not.
 *
 * `npm run dev` means "the backend only" inside apps/api and "all four" at the
 * repository root. Same command, different result, and the failure it produces
 * is a browser saying ERR_CONNECTION_REFUSED on a port that was simply never
 * started — which reads as the application being broken rather than as one
 * process not having been asked for.
 *
 * The server knows the answer, so it should say it rather than leave it to be
 * discovered in a browser.
 */
async function reportFrontEnds(env: Env): Promise<void> {
  if (env.NODE_ENV !== 'development') {
    return;
  }

  const statuses = await Promise.all(
    FRONT_ENDS.map(async (frontEnd) => ({
      ...frontEnd,
      running: await isPortOpen(frontEnd.port, env.API_HOST),
    })),
  );

  const missing = statuses.filter((entry) => !entry.running);

  const lines = [
    '',
    '  ------------------------------------------------------------',
    `   API ready on http://${env.API_HOST}:${env.API_PORT}`,
    '',
  ];

  for (const entry of statuses) {
    lines.push(
      `   ${entry.running ? 'running    ' : 'NOT RUNNING'}  ` +
        `http://localhost:${entry.port}  ${entry.name}`,
    );
  }

  if (missing.length > 0) {
    lines.push(
      '',
      `   ${missing.length} front end${missing.length === 1 ? '' : 's'} not started.`,
      '   This window runs the backend only. To start everything:',
      '',
      '       cd ..\\..     (the project root)',
      '       npm run dev',
    );
  }

  lines.push('  ------------------------------------------------------------', '', '');

  process.stdout.write(lines.join('\n'));
}

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp({ env });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().then(() => process.exit(0));
    });
  }

  await app.listen({ host: env.API_HOST, port: env.API_PORT });

  // After listen, so the ports it reports on are checked against a server that
  // is actually up.
  await reportFrontEnds(env);
}

main().catch((error: unknown) => {
  if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
    // The default output for this is a stack trace, which buries the one thing
    // that matters: this process is not running, and anything the browser
    // reaches is a different server.
    process.stderr.write(
      [
        '',
        '  ------------------------------------------------------------',
        '   PORT ALREADY IN USE — this server did NOT start.',
        '',
        '   Another process is already on that port. Anything your browser',
        '   reaches is that other process, not this one.',
        '',
        '   From the project root:',
        '',
        '       npm run stop     free the ports',
        '       npm run dev      start everything again',
        '  ------------------------------------------------------------',
        '',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});
