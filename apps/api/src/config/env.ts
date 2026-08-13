import { z } from 'zod';

const optionalNonEmptyString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);

const optionalEmail = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().trim().email().optional(),
);

const optionalBase64 = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be standard base64 without whitespace')
    .optional(),
);

/**
 * Each stage extends this schema with the variables it introduces, so a
 * missing secret fails at startup rather than at first use. Every variable is
 * named in `.env.example`.
 */
const envSchema = z.object({
  // ── Stage 0 ────────────────────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().positive().max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /**
   * Whether to believe `X-Forwarded-For`.
   *
   * Behind a reverse proxy this is not optional. Left off, Fastify sees the
   * proxy's address on every request — so every per-IP rate limit shares one
   * bucket and every audited address is the proxy's. Both controls appear
   * present in the code and do nothing, which is worse than their absence.
   *
   * Off by default because a directly-exposed API must *not* believe that
   * header: anyone can set it, and trusting it there would let a caller pick
   * their own rate-limit bucket and forge their own audit trail. Turn it on
   * only where something trustworthy overwrites it — which Caddy does.
   */
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  DATABASE_URL: z.string().min(1),

  // ── Stage 2 — credentials ─────────────────────────────────────────────
  // security-implementation.md §3: a pepper held in the key management
  // service, not the database. No KMS exists in this build; this is the
  // nearest equivalent available. See DECISIONS.md.
  PASSWORD_PEPPER: z.string().min(16),
  OTP_CODE_HMAC_SECRET: z.string().min(16),
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  // ── Stage 2 — tokens ───────────────────────────────────────────────────
  JWT_ISSUER: z.string().min(1),
  JWT_AUDIENCE_MEMBER: z.string().min(1),
  JWT_AUDIENCE_STAFF: z.string().min(1),
  // HS256 (see src/security/tokens.ts); 32 bytes minimum for a symmetric key
  // used with HMAC-SHA256.
  JWT_SIGNING_KEY: z.string().min(32),
  // security-implementation.md §4 lifetimes: 10 min dashboard, 30 min member
  // app; 12h staff refresh, 30-day member refresh.
  ACCESS_TOKEN_TTL_MEMBER_SECONDS: z.coerce.number().int().positive().default(1800),
  ACCESS_TOKEN_TTL_STAFF_DASHBOARD_SECONDS: z.coerce.number().int().positive().default(600),
  REFRESH_TOKEN_TTL_MEMBER_SECONDS: z.coerce.number().int().positive().default(2_592_000),
  REFRESH_TOKEN_TTL_STAFF_SECONDS: z.coerce.number().int().positive().default(43_200),

  // ── Stage 2 — rate limiting ───────────────────────────────────────────
  // "Strict", per §3/§4/§8; exact thresholds are not specified there. See
  // DECISIONS.md and PROGRESS.md open questions.
  RATE_LIMIT_LOGIN_PER_IP_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_LOGIN_PER_IDENTIFIER_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_LOGIN_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
  RATE_LIMIT_OTP_REQUEST_PER_IP_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_OTP_REQUEST_PER_IDENTIFIER_MAX: z.coerce.number().int().positive().default(3),
  RATE_LIMIT_OTP_VERIFY_PER_IP_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_OTP_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),

  // ── Stage 4 — member lifecycle ────────────────────────────────────────
  // security-implementation.md §3 requires claim codes to expire "after a
  // defined period" but does not define one, and product-definition.md §8 is
  // silent. 30 days assumes a posted invitation letter. See PROGRESS.md.
  CLAIM_CODE_TTL_HOURS: z.coerce.number().int().positive().default(720),
  // §10: consent is stored with the wording version it was given against, so
  // a later change to the wording does not retroactively reinterpret it.
  CONSENT_WORDING_VERSION: z.string().min(1).default('v1-2026-07'),
  // §3: "Strict rate limiting on the activation endpoint, since a guessable
  // claim code grants a genuine membership."
  RATE_LIMIT_CLAIM_PER_IP_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_CLAIM_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
  // §8: "Pagination caps so no endpoint can be coerced into returning the
  // full membership."
  MEMBER_LIST_MAX_PAGE_SIZE: z.coerce.number().int().positive().default(100),

  // Applied to a bare local number so a member can type 55550003 rather than
  // +97455550003. Configuration, not a constant, so a property in another
  // country needs no code change.
  DEFAULT_PHONE_COUNTRY_CODE: z.string().regex(/^\+\d{1,4}$/).default('+974'),

  // -- Stage 18 -- one-time passcode delivery (PROGRESS.md Q6) ------------
  // 'none' generates codes and delivers nothing, which is stages 0-17's
  // behaviour and stays the default so an existing deployment does not start
  // mailing members because it was upgraded. 'smtp' delivers by email -- see
  // src/notifications/code-sender.ts for why email and not SMS, and why that
  // is an interim arrangement rather than the destination.
  // 'sms' delivers passcodes over a carrier and everything else over SMTP --
  // see src/notifications/sms-sender.ts for why it is not all-or-nothing. It
  // therefore requires the SMTP block to be present as well; superRefine below
  // enforces that rather than letting outlet notices vanish at runtime.
  OTP_DELIVERY_CHANNEL: z.enum(['none', 'smtp', 'sms']).default('none'),

  // Optional individually, required together when the channel is 'smtp';
  // createSmtpSender throws at startup if any is missing. Kept optional here
  // so a deployment on 'none' needs none of them present.
  SMTP_HOST: z.string().min(1).optional(),
  // 465 is implicit TLS, 587 is STARTTLS. Both are fine for Gmail.
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_SECURE: z
    .string()
    .default('true')
    .transform((value) => value === 'true'),
  SMTP_USER: z.string().min(1).optional(),
  // A Google App Password, not the account password -- Gmail rejects the
  // latter. Never logged; loadEnv below deliberately echoes no values.
  SMTP_PASSWORD: z.string().min(1).optional(),
  SMTP_FROM: z.string().min(1).optional(),

  // -- SMS passcode delivery ----------------------------------------------
  // Required together when OTP_DELIVERY_CHANNEL='sms'. 'log' writes the body
  // to the log instead of sending it, so the wiring can be proved before a
  // carrier account exists -- and is refused in production, because the body
  // contains the passcode.
  SMS_PROVIDER: z.enum(['http', 'log']).default('http'),
  SMS_API_URL: z.string().url().optional(),
  SMS_API_USER: z.string().min(1).optional(),
  SMS_API_PASSWORD: z.string().min(1).optional(),
  // The brand name a member sees as the sender. Carriers in the region require
  // this to be registered in advance and reject unregistered values, so it has
  // a lead time -- see DEPLOYMENT.md.
  SMS_SENDER_ID: z.string().min(1).max(11).optional(),
  // Pacing. A gateway throttles rather than queues, so the dispatcher shapes
  // traffic to these rather than discovering the limit through rejections.
  // Conservative by default; raise them only against the provider's documented
  // ceiling, never by experiment against production.
  SMS_MAX_CONCURRENT: z.coerce.number().int().positive().default(4),
  SMS_MAX_PER_SECOND: z.coerce.number().int().positive().default(10),
  // Total tries per message. Only transient failures are retried; a rejected
  // recipient is never sent twice, because each attempt is separately billed.
  SMS_MAX_ATTEMPTS: z.coerce.number().int().positive().max(5).default(3),
  SMS_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),

  // -- Stage 19 -- staff MFA (PROGRESS.md Q5) -----------------------------
  // Encrypts the TOTP secret at rest (AES-256-GCM), so a stolen dump alone
  // yields no working second factors. Validated here rather than read from
  // process.env inside mfa.ts, so a missing or wrong-length key fails at boot
  // like every other secret in this file -- not on the first MFA attempt, which
  // in production means during someone's login.
  MFA_SECRET_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'must be 32 bytes, hex-encoded (64 characters)'),
  // Shown as the account issuer in the authenticator app, so staff with
  // accounts on several systems can tell them apart.
  MFA_ISSUER_LABEL: z.string().min(1).default('Privilege Guest'),
  // How long the post-password challenge token is valid. Long enough to open
  // an authenticator app and read a code, short enough that a challenge left
  // on a counter screen expires. Deliberately not a full session.
  MFA_CHALLENGE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  // Six digits is brute-forceable, so verification is rate limited on the same
  // pattern as the OTP path -- per challenge and per IP.
  RATE_LIMIT_MFA_VERIFY_PER_USER_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_MFA_VERIFY_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),

  /**
   * Whether a dashboard password must be followed by a second factor.
   *
   * **A local-development convenience, and nothing else.** §3 requires MFA on
   * every dashboard account "without exception", so this defaults to true and
   * `superRefine` below refuses to start at all if it is false while
   * `NODE_ENV=production`. The flag cannot be the reason a live deployment ends
   * up with single-factor administrators; getting it wrong stops the server
   * rather than quietly weakening it.
   *
   * It exists because the second factor is a TOTP code, and a developer without
   * the secret in an authenticator app has to run `npm run mfa:code` in a second
   * terminal and read a number that changes every thirty seconds — every time
   * they sign in, all day. That is real friction for no local benefit: the
   * threat MFA answers is a stolen or phished administrator password reaching
   * the internet, and a database seeded with fictional members on 127.0.0.1 is
   * not that.
   *
   * Turning it off changes only the *gate*. Enrollment, verification, recovery
   * codes and the replay check are all still there and still work; nothing is
   * deleted, so switching it back on needs no migration and no re-enrollment.
   */
  STAFF_MFA_REQUIRED: z
    .string()
    .default('true')
    .transform((value) => value !== 'false'),

  // -- Stage 8 -- reporting ----------------------------------------------
  // R13: "Enforce a minimum cohort size of 5 below which the endpoint returns
  // 'insufficient data' rather than a number." The figure is given explicitly
  // in §6, unlike most thresholds here.
  REPORT_MIN_COHORT_SIZE: z.coerce.number().int().positive().default(5),
  // §6: exports are "administrator-only, rate-limited, individually audited".
  // No rate is specified; a handful a day fits an action that should never be
  // routine.
  RATE_LIMIT_EXPORT_PER_USER_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_EXPORT_WINDOW_SECONDS: z.coerce.number().int().positive().default(86400),

  // -- Hotel-facing Google Sheets mirror --------------------------------
  // PostgreSQL remains authoritative. When enabled, a background task writes
  // a privacy-limited, read-only snapshot; no request handler waits for Google.
  GOOGLE_SHEETS_SYNC_ENABLED: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  GOOGLE_SHEETS_SPREADSHEET_ID: optionalNonEmptyString,
  GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL: optionalEmail,
  // Base64 avoids putting a multiline PEM value in .env/Compose. It is only an
  // encoding and must still be supplied through the deployment secret store.
  GOOGLE_SHEETS_PRIVATE_KEY_BASE64: optionalBase64,
  GOOGLE_SHEETS_SYNC_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(86_400)
    .default(300),

  // ── Outlet fulfilment — the guest announces, the outlet confirms ────────

  // The anti-spam rule the client asked for: a guest may announce themselves
  // once a minute. Enforced by counting rows on (memberId, requestedAt), not by
  // the in-memory limiter -- a restart must not hand somebody a fresh allowance,
  // and the figure is small enough that an accidental double tap is the case it
  // actually catches.
  REQUEST_THROTTLE_SECONDS: z.coerce.number().int().positive().default(60),
  // A notice nobody confirms is closed as NOT_USED after this long, so an outlet
  // screen shows tonight's guests rather than an accumulating list, and a member
  // is never left looking at "we told them" from four days ago.
  REQUEST_EXPIRY_HOURS: z.coerce.number().int().positive().default(24),
  // How often the sweep runs. In-process, like the Sheets sync, and carrying the
  // same caveat: it assumes the single documented API instance.
  REQUEST_EXPIRY_SWEEP_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(86_400)
    .default(900),

  // Whether the guest's own free text travels in the outlet's email.
  //
  // Default false, and that default is the privacy position rather than
  // laziness: the standing export policy excludes request free text from
  // anything that leaves the system, and a guest can type their own name into
  // that box — so "we never send names" stops being true the moment this is on.
  // The outlet always sees the note on its own screen either way. Turn this on
  // only once the hotel has agreed it, and record the agreement.
  OUTLET_NOTIFY_INCLUDE_NOTE: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),

  // ── The card's scannable code ──────────────────────────────────────────
  // Keys the HMAC over the identity payload printed on the card and shown in the
  // app. §7 says this should come from a key management service; there is no KMS
  // in this build, so an environment variable is the same compromise already
  // made for PASSWORD_PEPPER. Required, because a card code nobody can verify is
  // worse than no card code.
  IDENTITY_CODE_HMAC_SECRET: z.string().min(16),
  // Applies to the rotating `v1` payload only. The card's `v2` payload is static
  // -- ink cannot rotate -- and is accepted regardless of age. See DECISIONS.md
  // for why that is acceptable: the code identifies, and grants nothing.
  IDENTITY_CODE_WINDOW_HOURS: z.coerce.number().int().positive().default(24),
  // §5: "a handful of lookups per staff member per hour". A membership number is
  // sequential and printed on the card, so an unmetered lookup endpoint is an
  // enumeration tool no matter who holds the credential.
  RATE_LIMIT_RESOLVE_PER_ACCOUNT_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_RESOLVE_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
  // How long an outlet may act on a member it has just resolved. Long enough to
  // key in a bill, short enough that a screen left on a counter goes cold.
  VERIFICATION_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(600),
}).superRefine((env, context) => {
  const requiredWhenEnabled = [
    ['GOOGLE_SHEETS_SPREADSHEET_ID', env.GOOGLE_SHEETS_SPREADSHEET_ID],
    ['GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL', env.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL],
    ['GOOGLE_SHEETS_PRIVATE_KEY_BASE64', env.GOOGLE_SHEETS_PRIVATE_KEY_BASE64],
  ] as const;

  if (env.GOOGLE_SHEETS_SYNC_ENABLED) {
    for (const [key, value] of requiredWhenEnabled) {
      if (value === undefined) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: 'is required when GOOGLE_SHEETS_SYNC_ENABLED=true',
        });
      }
    }
  }

  // §3 admits no exception, so this is a boot failure rather than a warning in a
  // log nobody reads. A misconfigured production deployment must not be reachable
  // with one factor for the minutes it takes somebody to notice.
  if (!env.STAFF_MFA_REQUIRED && env.NODE_ENV === 'production') {
    context.addIssue({
      code: 'custom',
      path: ['STAFF_MFA_REQUIRED'],
      message:
        'cannot be false when NODE_ENV=production — security-implementation.md §3 requires a ' +
        'second factor on every dashboard account without exception. It exists so local ' +
        'development need not run `npm run mfa:code`, and for nothing else.',
    });
  }

  if (env.OTP_DELIVERY_CHANNEL === 'sms') {
    // The SMS sender routes lifecycle and outlet messages to SMTP, because an
    // outlet is a mailbox with no phone number attached. Without these the
    // outlet would simply stop being told that a guest is coming, and nothing
    // would fail loudly enough to notice.
    for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'] as const) {
      if (env[key] === undefined) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message:
            'is required when OTP_DELIVERY_CHANNEL=sms — passcodes go by SMS, but outlet ' +
            'notices have no phone number and still need mail. See notifications/sms-sender.ts.',
        });
      }
    }

    if (env.SMS_PROVIDER === 'http') {
      for (const key of ['SMS_API_URL', 'SMS_API_USER', 'SMS_API_PASSWORD', 'SMS_SENDER_ID'] as const) {
        if (env[key] === undefined) {
          context.addIssue({
            code: 'custom',
            path: [key],
            message: 'is required when OTP_DELIVERY_CHANNEL=sms and SMS_PROVIDER=http',
          });
        }
      }
    }
  }

  // The logging transport prints the passcode. That is the whole point of it in
  // development and a credential in a log file anywhere else.
  if (env.SMS_PROVIDER === 'log' && env.NODE_ENV === 'production') {
    context.addIssue({
      code: 'custom',
      path: ['SMS_PROVIDER'],
      message:
        'cannot be "log" when NODE_ENV=production — that transport writes the passcode ' +
        'into the log instead of sending it.',
    });
  }

  if (env.GOOGLE_SHEETS_PRIVATE_KEY_BASE64 !== undefined) {
    const decoded = Buffer.from(env.GOOGLE_SHEETS_PRIVATE_KEY_BASE64, 'base64').toString('utf8');
    if (!decoded.includes('-----BEGIN PRIVATE KEY-----')) {
      context.addIssue({
        code: 'custom',
        path: ['GOOGLE_SHEETS_PRIVATE_KEY_BASE64'],
        message: 'must decode to a PEM PKCS#8 private key',
      });
    }
  }

});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    // Never echo the values back — some of them are secrets.
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return parsed.data;
}
