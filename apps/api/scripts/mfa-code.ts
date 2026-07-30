/**
 * Prints a staff account's current TOTP code to the terminal — a stand-in for an
 * authenticator app during local development.
 *
 * ```
 * npm run mfa:code                    # admin@pgp.test
 * npm run mfa:code -- manager@pgp.test
 * ```
 *
 * ── Why a script, and not an echo inside the server ───────────────────────
 *
 * `DEV_OTP_ECHO` prints *member* passcodes from the request handler that issues
 * them (`src/security/dev-otp.ts`), and the obvious move is to do the same for
 * the staff second factor. It is the wrong shape here, for two reasons.
 *
 * A member passcode is issued once, by a request, and lasts five minutes — so
 * there is a moment to print it and a comfortable window to type it. A TOTP code
 * is not issued by anything: it is a function of the shared secret and the clock,
 * and it changes every 30 seconds. Printing "the" code at sign-in would print one
 * that expires while the person is still reading it.
 *
 * Worse, `verifyTotp`'s replay check (`mfaLastUsedEpoch`) refuses a code from a
 * period already spent. A single printed code that gets mistyped is then dead,
 * and the only way to get another is to start sign-in again. A ticking clock
 * outside the request path has neither problem, and it keeps a live second factor
 * out of the server's code path and its logs entirely — no new environment gate
 * to set wrong, nothing to leak in production, because this file never runs there.
 *
 * ── The gate ─────────────────────────────────────────────────────────────
 *
 * `NODE_ENV=development`, checked below. This prints a working second factor for
 * whichever database `DATABASE_URL` points at, so it refuses to run anywhere
 * else. Unlike the echo it needs no second flag: a script nobody invokes cannot
 * be left switched on by accident.
 */
import { PrismaClient } from '@prisma/client';
import { generate } from 'otplib';

import { decryptMfaSecret, MfaSecretError, roleRequiresMfa } from '../src/security/mfa.js';

const DEFAULT_EMAIL = 'admin@pgp.test';

/**
 * TOTP period. Must match what `verifyTotp` verifies against — `src/security/mfa.ts`
 * does not override otplib's default, so neither does this.
 */
const PERIOD_SECONDS = 30;

/** Fast enough that a new code appears the moment it becomes valid. */
const POLL_MS = 1000;

function box(lines: string[]): string {
  const rule = '  ══════════════════════════════════════════';
  return ['', rule, ...lines.map((line) => (line === '' ? '' : `   ${line}`)), rule, '', ''].join(
    '\n',
  );
}

function write(lines: string[]): void {
  process.stdout.write(box(lines));
}

function secondsRemaining(): number {
  return PERIOD_SECONDS - (Math.floor(Date.now() / 1000) % PERIOD_SECONDS);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<number> {
  if (process.env['NODE_ENV'] !== 'development') {
    write([
      'REFUSING TO RUN',
      '',
      `NODE_ENV is ${process.env['NODE_ENV'] ?? '(unset)'}, not "development".`,
      'This prints a working second factor and is for local use only.',
    ]);
    return 1;
  }

  const email = (process.argv[2] ?? DEFAULT_EMAIL).trim();
  const prisma = new PrismaClient();

  try {
    const staff = await prisma.staffUser.findUnique({
      where: { email },
      select: { email: true, role: true },
    });

    if (!staff) {
      const known = await prisma.staffUser.findMany({
        select: { email: true, role: true },
        orderBy: { email: 'asc' },
      });
      write([
        'NO SUCH STAFF ACCOUNT',
        '',
        `looked for  ${email}`,
        '',
        'Accounts on this database:',
        ...known.map((row) => `  ${row.email}  (${row.role.toLowerCase()})`),
      ]);
      return 1;
    }

    // OUTLET_STAFF signs in with a password alone — the verification page is not
    // a dashboard (see the note at the top of src/security/mfa.ts). Saying so is
    // more useful than spinning forever waiting for a secret that will never
    // arrive.
    if (!roleRequiresMfa(staff.role)) {
      write([
        'THIS ACCOUNT HAS NO SECOND FACTOR',
        '',
        `account  ${staff.email}`,
        `role     ${staff.role.toLowerCase()}`,
        '',
        'It signs in with a password alone. Nothing to print.',
      ]);
      return 0;
    }

    write([
      'AUTHENTICATOR  (development only)',
      '',
      `account  ${staff.email}`,
      '',
      'Waiting for a code. Ctrl-C to stop.',
      'A new one prints every 30 seconds; always use the newest.',
    ]);

    let lastCode: string | null = null;
    let lastCipher: string | null = null;
    let announcedMissing = false;

    for (;;) {
      // Re-read every tick rather than once at startup, so it does not matter
      // whether this was started before or after the browser reached the setup
      // screen — and so a fresh /auth/staff/mfa/enroll, which supersedes the
      // stored secret, is picked up instead of printing codes from a dead one.
      const current = await prisma.staffUser.findUnique({
        where: { email },
        select: { mfaSecret: true, mfaEnrolledAt: true },
      });

      if (!current) {
        write(['ACCOUNT DISAPPEARED', '', `${email} is no longer on this database.`]);
        return 1;
      }

      if (current.mfaSecret === null) {
        if (!announcedMissing) {
          write([
            'NO SECRET STORED YET',
            '',
            `account  ${staff.email}`,
            '',
            'Setup has not started. In the dashboard on :5175, sign in with the',
            'password — the page that shows a QR code is what stores the secret.',
            'Codes will start printing here as soon as it does.',
          ]);
          announcedMissing = true;
        }
        await sleep(POLL_MS);
        continue;
      }

      // A different ciphertext means a new secret, so whatever was printed
      // before is now worthless. Clearing this forces the next code out
      // immediately rather than waiting for the period to roll.
      if (current.mfaSecret !== lastCipher) {
        lastCipher = current.mfaSecret;
        lastCode = null;
        announcedMissing = false;
      }

      let secret: string;
      try {
        secret = decryptMfaSecret(current.mfaSecret);
      } catch (cause) {
        write([
          'STORED SECRET WILL NOT DECRYPT',
          '',
          cause instanceof MfaSecretError ? cause.message : String(cause),
          '',
          'MFA_SECRET_ENCRYPTION_KEY has almost certainly changed since',
          'enrollment. Clear the enrollment and set it up again — see RUNBOOK.md.',
        ]);
        return 1;
      }

      const code = await generate({ secret });

      if (code !== lastCode) {
        lastCode = code;
        write([
          'AUTHENTICATOR CODE  (development only)',
          '',
          `account  ${staff.email}`,
          `CODE     ${code}`,
          `expires  in ${secondsRemaining()}s`,
          '',
          current.mfaEnrolledAt === null ? 'Setting up — enter this to finish.' : 'Enter this to sign in.',
        ]);
      }

      await sleep(POLL_MS);
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Ctrl-C is the intended way out of the loop above, so it is a clean exit rather
// than an unhandled signal killing the process mid-query.
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
