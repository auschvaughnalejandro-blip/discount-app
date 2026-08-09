/**
 * Sends one real email, and says exactly what went wrong if it cannot.
 *
 * SMTP fails opaquely. A wrong password, a missing App Password, 2-Step
 * Verification switched off, the wrong port for the chosen TLS mode — every one
 * of them surfaces inside the app as the same thing: no email arrives, and the
 * member sees a screen that looks like it worked. That is by design (§3 requires
 * the sign-in response to be identical whether or not delivery succeeded), and
 * it makes configuring SMTP miserable.
 *
 * So this bypasses the app entirely. It reads the same environment the API does,
 * makes one connection, and reports the outcome in full — including the
 * provider's own error, which the API deliberately never shows anyone.
 *
 *   npm run mail:test -w @pgp/api -- you@example.com
 *
 * Development only, like every other script in this directory: it prints
 * configuration detail that has no business on a production terminal.
 */
import { loadEnv } from '../src/config/env.js';
import { createCodeSender } from '../src/notifications/code-sender.js';

const DIVIDER = '─'.repeat(64);

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(22)}${value}`);
}

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('mail:test is a development tool. It prints configuration detail.');
  }

  const recipient = process.argv[2];
  if (!recipient || !recipient.includes('@')) {
    console.error('\nUsage: npm run mail:test -w @pgp/api -- you@example.com\n');
    process.exit(1);
  }

  const env = loadEnv();

  console.log(`\n${DIVIDER}`);
  console.log('  MAIL TEST');
  console.log(DIVIDER);
  line('channel', env.OTP_DELIVERY_CHANNEL);
  line('host', env.SMTP_HOST ?? '(unset)');
  line('port', String(env.SMTP_PORT));
  line('implicit TLS', String(env.SMTP_SECURE));
  line('user', env.SMTP_USER ?? '(unset)');
  // Length only. A password in a terminal is a password in a scrollback buffer.
  line('password', env.SMTP_PASSWORD ? `set, ${env.SMTP_PASSWORD.length} characters` : '(unset)');
  line('from', env.SMTP_FROM ?? '(unset)');
  line('to', recipient);
  console.log(DIVIDER);

  if (env.OTP_DELIVERY_CHANNEL !== 'smtp') {
    console.log(`
  OTP_DELIVERY_CHANNEL is "${env.OTP_DELIVERY_CHANNEL}", so nothing would be sent.

  Set it to "smtp" in apps/api/.env, along with SMTP_USER, SMTP_PASSWORD
  and SMTP_FROM, then run this again.
`);
    process.exit(1);
  }

  // Gmail's App Passwords are 16 characters. They are usually displayed in
  // four groups of four, and pasting the spaces is the single most common
  // mistake — it looks right and fails authentication.
  const password = env.SMTP_PASSWORD ?? '';
  if (env.SMTP_HOST?.includes('gmail') && password.replace(/\s/g, '').length !== 16) {
    console.log(`
  Warning: SMTP_PASSWORD is ${password.length} characters.

  A Google App Password is 16. If this is your normal Gmail password it will
  be rejected no matter how correct it is — Google does not accept account
  passwords over SMTP. Generate one at:

      myaccount.google.com  →  Security  →  App passwords

  (The option only appears once 2-Step Verification is switched on.)
`);
  }

  // Port and TLS mode have to agree, or the connection hangs rather than
  // failing — which reads as "the network is broken" instead of "these two
  // settings disagree".
  if ((env.SMTP_PORT === 465) !== env.SMTP_SECURE) {
    console.log(`
  Warning: port ${env.SMTP_PORT} with SMTP_SECURE=${env.SMTP_SECURE}.

  Port 465 needs SMTP_SECURE=true (TLS from the first byte).
  Port 587 needs SMTP_SECURE=false (starts plain, upgrades).
  A mismatch usually hangs until it times out.
`);
  }

  console.log('\n  Sending…\n');

  const sender = await createCodeSender(env, {
    // The sender logs through Fastify's logger; this is the smallest thing
    // that satisfies it without pulling a whole server into a CLI script.
    info: () => undefined,
    warn: () => undefined,
    error: (...args: unknown[]) => console.error('  transport error:', ...args),
  } as never);

  const started = Date.now();
  const outcome = await sender.send({
    email: recipient,
    phone: '+00000000000',
    code: '000000',
    purpose: 'sign-in',
  });
  const elapsed = Date.now() - started;

  if (outcome.delivered) {
    console.log(`  Delivered in ${elapsed} ms.\n`);
    console.log(`  Check ${recipient}. The subject is "Your Privilege Guest verification code"`);
    console.log(`  and the code inside is 000000 — this is a test, not a real passcode.\n`);
    console.log('  If it is not in the inbox, look in spam: a brand-new sender with no');
    console.log('  SPF or DKIM record is exactly what a spam filter is built to catch.\n');
    return;
  }

  console.log(`  NOT delivered after ${elapsed} ms — reason: ${outcome.reason}\n`);

  const advice: Record<string, string> = {
    no_address: 'No recipient address reached the sender. That is a bug, not configuration.',
    not_configured: 'The channel is not "smtp", or a required SMTP_* value is missing.',
    transport_failed:
      'The mail server refused the connection or the credentials.\n' +
      '  In order of likelihood:\n' +
      '    1. SMTP_PASSWORD is the account password, not a 16-character App Password\n' +
      '    2. 2-Step Verification is off, so no App Password exists\n' +
      '    3. Port and SMTP_SECURE disagree (465/true or 587/false)\n' +
      '    4. SMTP_USER is not the full address, including @gmail.com',
  };

  console.log(`  ${advice[outcome.reason] ?? 'Unrecognised failure.'}\n`);
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error('\n  mail:test failed:', error instanceof Error ? error.message : error, '\n');
  process.exit(1);
});
