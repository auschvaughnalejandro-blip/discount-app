import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Load `apps/api/.env` when present so integration tests pick up the local
 * database URLs. `.env` is gitignored; copy `.env.example` and fill it in.
 */
const envFile = resolve(import.meta.dirname, '..', '.env');

if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

/**
 * Pin the delivery channel, whatever the developer's `.env` says.
 *
 * This is not tidiness. With `OTP_DELIVERY_CHANNEL=smtp` inherited from a local
 * `.env`, member creation enforces its `email_required` guard and 25 tests fail —
 * so the suite's result depended on whether whoever ran it happened to have
 * configured mail. A test suite that passes or fails on a developer's local
 * settings is not telling you about the code.
 *
 * Tests that need to observe delivery inject a capturing sender through
 * `buildApp({ codeSender })`, which is unaffected by this.
 */
process.env['OTP_DELIVERY_CHANNEL'] = 'none';

/**
 * The developer's local `.env` may enable the production Google Sheets mirror.
 * A test that boots the app must never publish its seeded/temporary rows to an
 * external spreadsheet merely because that developer also tests the real sync.
 */
process.env['GOOGLE_SHEETS_SYNC_ENABLED'] = 'false';

/**
 * Pin the second factor on, whatever the developer's `.env` says.
 *
 * Same reasoning as the delivery channel above, and a sharper example of it.
 * `STAFF_MFA_REQUIRED=false` is a legitimate thing to have in a local `.env` —
 * it is why the variable exists — but every suite that signs an administrator in
 * (`auth`, `session-cookie`, `audit`, `acceptance-journey`, `staff-management`)
 * walks the password → challenge → TOTP sequence deliberately. With the switch
 * inherited as false, `/auth/staff/login` hands back tokens instead of a
 * challenge and each of those suites fails on the developer's machine while
 * passing in CI, for a reason nothing in the failure mentions.
 *
 * `staff-mfa-gate.test.ts` is the one file that cares about the switch itself,
 * and it passes the value it wants to `loadEnv` explicitly rather than relying on
 * the ambient one.
 */
process.env['STAFF_MFA_REQUIRED'] = 'true';

/**
 * Secrets the suite needs but no developer should have to invent.
 *
 * Set only when absent, so a `.env` that defines one still wins. These are test
 * values and deliberately obvious as such — nothing here is a default that could
 * reach a deployment, because `loadEnv` requires the real thing and production
 * never loads this file.
 */
const TEST_DEFAULTS: Record<string, string> = {
  IDENTITY_CODE_HMAC_SECRET: 'test-identity-code-hmac-secret-value',
};

for (const [name, value] of Object.entries(TEST_DEFAULTS)) {
  process.env[name] ??= value;
}
