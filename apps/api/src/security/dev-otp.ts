import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { FastifyBaseLogger } from 'fastify';

import type { Env } from '../config/env.js';

/**
 * Development-only OTP delivery.
 *
 * No SMS provider is specified anywhere in the reference documents
 * (PROGRESS.md Q6), so `issueOtp` stores a hashed code and nothing sends it.
 * That makes the member app impossible to sign into by hand, which makes it
 * impossible to demonstrate.
 *
 * This prints the code to the terminal the developer is already watching.
 *
 * ── Why the console and not the HTTP response ────────────────────────────
 *
 * Returning the code from the endpoint would put a live credential into a
 * response body, where a browser cache, a proxy, an access log or a
 * screen-share can capture it, and where a single misconfigured environment
 * turns it into a public account-takeover endpoint. The console reaches the
 * one person who is already sitting in front of the process.
 *
 * ── Why two independent gates ────────────────────────────────────────────
 *
 * `NODE_ENV === 'development'` **and** an explicit `DEV_OTP_ECHO=true`. Either
 * alone is one mistake away from production: NODE_ENV is set by tooling and
 * gets defaulted, and a lone feature flag survives being copied into a
 * production env file. Both must be wrong at once for this to leak.
 *
 * `isDevOtpEchoEnabled` is exported so a test can assert it stays inert under
 * every production-shaped configuration.
 */
export function isDevOtpEchoEnabled(env: Pick<Env, 'NODE_ENV' | 'DEV_OTP_ECHO'>): boolean {
  return env.NODE_ENV === 'development' && env.DEV_OTP_ECHO;
}

/**
 * Last four digits only.
 *
 * §9 forbids phone numbers in application logs, and this is still a log. Four
 * digits is enough to tell two test members apart, which is the only reason
 * the number is here at all.
 */
function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length <= 4 ? '••••' : `${'•'.repeat(6)}${digits.slice(-4)}`;
}

/**
 * Prints the code where a developer can see it. A no-op unless both gates pass.
 *
 * Written straight to stdout rather than through the logger, deliberately:
 * pino serialises to a single JSON line, so a multi-line block arrives as
 * literal `\n` escapes inside a string field — technically present, unreadable
 * in a terminal, and therefore useless for the one job this has. This is a
 * human-facing development affordance, not a log record; nothing depends on
 * it being machine-parseable.
 *
 * Everything else in this process still goes through the logger and its
 * redaction layer. This is the single exception, and it exists only when both
 * gates above are open.
 */
/**
 * Where the code is also written, so finding it never depends on which
 * terminal happens to be in front of you.
 *
 * Two dev servers cannot both hold port 3000; the loser exits, and its window
 * then shows nothing while the winner serves the requests. Hunting for a code
 * in the wrong window is not a puzzle worth setting anyone. A file has one
 * location regardless.
 *
 * Gitignored, and only ever written when both gates are open.
 */
export const DEV_OTP_FILE = 'VERIFICATION-CODE.txt';

export interface EchoOptions {
  /**
   * Directory the code file is written to. `null` disables the write.
   *
   * Exists because the first version always wrote to `process.cwd()`, which
   * meant running the test suite overwrote the developer's real
   * VERIFICATION-CODE.txt with test fixtures — a file that then confidently
   * showed a code which had never been issued. A test must not write into the
   * working tree it is testing.
   */
  fileDir?: string | null;
}

export function echoOtpForDevelopment(
  _logger: FastifyBaseLogger,
  env: Pick<Env, 'NODE_ENV' | 'DEV_OTP_ECHO'>,
  phone: string,
  code: string,
  options: EchoOptions = {},
): void {
  if (!isDevOtpEchoEnabled(env)) {
    return;
  }

  const box = [
    '',
    '  ══════════════════════════════════════════',
    '   VERIFICATION CODE  (development only)',
    '',
    `   phone ending  ${maskPhone(phone)}`,
    `   CODE          ${code}`,
    '',
    '  ══════════════════════════════════════════',
    '',
  ].join('\n');

  process.stdout.write(`${box}\n`);

  const fileDir = options.fileDir === undefined ? process.cwd() : options.fileDir;
  if (fileDir === null) {
    return;
  }

  // Best effort. A failure here must never break a sign-in — this is a
  // convenience, and the code has already been printed above.
  try {
    writeFileSync(
      resolve(fileDir, DEV_OTP_FILE),
      `${code}\n\n` +
        `phone ending ${maskPhone(phone)}\n` +
        `issued ${new Date().toISOString()}\n` +
        `valid for 5 minutes\n\n` +
        `Development only. Overwritten each time a code is issued.\n`,
      'utf8',
    );
  } catch {
    // Ignored on purpose.
  }
}

/**
 * Printed when a code was asked for but none was issued.
 *
 * `/auth/member/request-otp` answers identically whether or not the number is
 * registered (§3, account enumeration), which is correct and must stay — but
 * it means an unrecognised number produces silence, and silence is
 * indistinguishable from the feature being broken. This says which it was, to
 * the developer only, and never over HTTP.
 */
export function echoNoOtpForDevelopment(
  env: Pick<Env, 'NODE_ENV' | 'DEV_OTP_ECHO'>,
  phone: string,
  reason: string,
): void {
  if (!isDevOtpEchoEnabled(env)) {
    return;
  }

  process.stdout.write(
    [
      '',
      '  ══════════════════════════════════════════',
      '   NO CODE ISSUED  (development only)',
      '',
      `   phone ending  ${maskPhone(phone)}`,
      `   reason        ${reason}`,
      '',
      '  ══════════════════════════════════════════',
      '',
      '',
    ].join('\n'),
  );
}

/**
 * Printed once at startup so an operator cannot miss that codes are being
 * written to the terminal. This one goes through the logger — it carries no
 * credential and no personal data, and belongs in the log record.
 */
export function warnIfDevOtpEchoEnabled(
  logger: FastifyBaseLogger,
  env: Pick<Env, 'NODE_ENV' | 'DEV_OTP_ECHO'>,
): void {
  if (isDevOtpEchoEnabled(env)) {
    logger.warn(
      'DEV_OTP_ECHO is enabled: one-time passcodes are printed to this terminal. ' +
        'Development only.',
    );
  }
}
