/**
 * Prints the member's current one-time passcode to the terminal — the guest-side
 * counterpart to `npm run mfa:code`.
 *
 * ```
 * npm run otp:code
 * ```
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * `DEV_OTP_ECHO` already prints the code from the request handler that issues it
 * (`src/security/dev-otp.ts`) and writes it to VERIFICATION-CODE.txt. Both work.
 * Neither is findable: the terminal copy arrives inside the `npm run dev` stream
 * between two walls of JSON request logs, and the file is gitignored, which means
 * an editor sidebar hides it from the one person who needs it.
 *
 * So the code was always there and the answer to "where is it" was still a
 * scavenger hunt. This gives it the same treatment the staff second factor gets:
 * its own window, showing one thing, updating itself.
 *
 * ── Why it watches the file and not the database ─────────────────────────
 *
 * `issueOtp` stores `hashOtpCode(code)` and discards the plaintext — deliberately,
 * so a database read cannot yield a working credential. The plaintext exists for
 * exactly one moment, in the handler that generated it, which is why the echo
 * lives there. This tails that echo's output rather than trying to recover
 * something the schema is designed not to keep.
 *
 * ── The gate ─────────────────────────────────────────────────────────────
 *
 * `NODE_ENV=development`, plus `DEV_OTP_ECHO`, matching `isDevOtpEchoEnabled`.
 * This only ever reads a file that those two flags are what create, so it cannot
 * surface a code in an environment where nothing writes one — but it checks
 * anyway, and says which flag is off, because "nothing is appearing" with no
 * explanation is the problem this script was written to end.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DEV_OTP_FILE } from '../src/security/dev-otp.js';

/** Fast enough that the code is on screen before the browser finishes its POST. */
const POLL_MS = 500;

/** Matches OTP_TTL_SECONDS so the countdown cannot drift from the real expiry. */
const TTL_SECONDS = Number(process.env['OTP_TTL_SECONDS'] ?? 300);

function box(lines: string[]): string {
  const rule = '  ══════════════════════════════════════════';
  return ['', rule, ...lines.map((line) => (line === '' ? '' : `   ${line}`)), rule, '', ''].join(
    '\n',
  );
}

function write(lines: string[]): void {
  process.stdout.write(box(lines));
}

interface Issued {
  code: string;
  phone: string;
  issuedAt: Date;
}

/**
 * Parses what `echoOtpForDevelopment` writes. Returns null for anything else —
 * including a half-written file, which is a real possibility when the poll lands
 * mid-write and is not worth a crash.
 */
function readIssued(path: string): Issued | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }

  const lines = raw.split('\n');
  const code = (lines[0] ?? '').trim();
  if (!/^\d{4,10}$/.test(code)) {
    return null;
  }

  const phone = lines.find((line) => line.startsWith('phone ending '))?.slice(13).trim() ?? '';
  const issuedRaw = lines.find((line) => line.startsWith('issued '))?.slice(7).trim() ?? '';
  const issuedAt = new Date(issuedRaw);

  return { code, phone, issuedAt: Number.isNaN(issuedAt.getTime()) ? new Date(0) : issuedAt };
}

function secondsLeft(issuedAt: Date): number {
  return Math.round((issuedAt.getTime() + TTL_SECONDS * 1000 - Date.now()) / 1000);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<number> {
  if (process.env['NODE_ENV'] !== 'development') {
    write([
      'REFUSING TO RUN',
      '',
      `NODE_ENV is ${process.env['NODE_ENV'] ?? '(unset)'}, not "development".`,
      'This prints a working sign-in credential and is for local use only.',
    ]);
    return 1;
  }

  if (process.env['DEV_OTP_ECHO'] !== 'true') {
    write([
      'DEV_OTP_ECHO IS NOT ENABLED',
      '',
      'Nothing writes a code for this to read.',
      'Set DEV_OTP_ECHO=true in apps/api/.env and restart the API.',
    ]);
    return 1;
  }

  // Same path the API writes to: it runs from apps/api, and so does this.
  const path = resolve(process.cwd(), DEV_OTP_FILE);

  write([
    'MEMBER VERIFICATION CODE  (development only)',
    '',
    'Waiting for a code. Ctrl-C to stop.',
    '',
    'Request one from the member app: "Already activated? Sign in",',
    'enter a mobile number, then "Send code".',
  ]);

  let lastShown: string | null = null;

  for (;;) {
    const issued = readIssued(path);

    if (issued) {
      // Key on the issue time as well as the digits: the same code drawn twice
      // in a row is rare but not impossible, and a re-send that looks identical
      // still deserves to be announced.
      const key = `${issued.code}@${issued.issuedAt.toISOString()}`;
      const remaining = secondsLeft(issued.issuedAt);

      // A code already dead when this starts is history, not an event. Showing
      // it as if it had just arrived is how someone ends up typing an expired
      // code and blaming the app.
      if (key !== lastShown && remaining > 0) {
        lastShown = key;
        write([
          'MEMBER VERIFICATION CODE  (development only)',
          '',
          `phone ending  ${issued.phone}`,
          `CODE          ${issued.code}`,
          `expires       in ${remaining}s`,
          '',
          'Enter this in the member app.',
        ]);
      } else if (key !== lastShown) {
        lastShown = key;
        write([
          'AN EXPIRED CODE IS ON FILE',
          '',
          `phone ending  ${issued.phone}`,
          `expired       ${Math.abs(remaining)}s ago`,
          '',
          'Press "Send code" again for a fresh one.',
        ]);
      }
    }

    await sleep(POLL_MS);
  }
}

// Ctrl-C is the intended way out of the loop above.
process.on('SIGINT', () => {
  process.stdout.write('\n  Stopped.\n\n');
  process.exit(0);
});

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    write(['FAILED', '', error instanceof Error ? error.message : String(error)]);
    process.exit(1);
  });
