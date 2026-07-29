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
 * This prints the code to the server console — the terminal the developer is
 * already watching — so a local sign-in can be completed.
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
 * Prints the code where a developer can see it. A no-op unless both gates pass.
 *
 * Deliberately loud: this is a live credential on screen, and nobody should be
 * able to leave it switched on without noticing.
 */
export function echoOtpForDevelopment(
  logger: FastifyBaseLogger,
  env: Pick<Env, 'NODE_ENV' | 'DEV_OTP_ECHO'>,
  phone: string,
  code: string,
): void {
  if (!isDevOtpEchoEnabled(env)) {
    return;
  }

  logger.warn(
    `\n` +
      `  ┌────────────────────────────────────────────────┐\n` +
      `  │  DEVELOPMENT ONLY — verification code          │\n` +
      `  │  ${phone.padEnd(44)}│\n` +
      `  │  code: ${code.padEnd(40)}│\n` +
      `  └────────────────────────────────────────────────┘\n` +
      `  DEV_OTP_ECHO is on. Never enable this outside development.\n`,
  );
}

/**
 * Printed once at startup so an operator cannot miss that codes are being
 * written to the log.
 */
export function warnIfDevOtpEchoEnabled(
  logger: FastifyBaseLogger,
  env: Pick<Env, 'NODE_ENV' | 'DEV_OTP_ECHO'>,
): void {
  if (isDevOtpEchoEnabled(env)) {
    logger.warn(
      'DEV_OTP_ECHO is enabled: one-time passcodes are printed to this log. ' +
        'Development only.',
    );
  }
}
