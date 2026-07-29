import { z } from 'zod';

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
  // security-implementation.md §4 lifetimes: 10 min dashboard, 15 min
  // verification page, 30 min member app; 12h staff refresh, 30-day member
  // refresh.
  ACCESS_TOKEN_TTL_MEMBER_SECONDS: z.coerce.number().int().positive().default(1800),
  ACCESS_TOKEN_TTL_STAFF_DASHBOARD_SECONDS: z.coerce.number().int().positive().default(600),
  ACCESS_TOKEN_TTL_STAFF_VERIFY_SECONDS: z.coerce.number().int().positive().default(900),
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

  // ── Stage 6 — identity codes ──────────────────────────────────────────
  IDENTITY_CODE_HMAC_SECRET: z.string().min(16),
  // R9: the rotation window is a tunable setting, not a hardcoded constant.
  // §7: "start around 24 hours, monitor verification failures at outlets, and
  // adjust." Changing this must need no code change.
  IDENTITY_CODE_WINDOW_HOURS: z.coerce.number().positive().default(24),

  // -- Stage 7 -- verification lookups ------------------------------------
  // security-implementation.md §5: "Rate limited hard: a handful of lookups
  // per staff member per hour. Membership numbers are sequential and printed
  // on cards, so an unlimited lookup endpoint is an enumeration tool."
  // "A handful per hour" is the only quantity given; 30 reads that generously
  // for a busy restaurant shift. See PROGRESS.md.
  RATE_LIMIT_VERIFY_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
  RATE_LIMIT_VERIFY_PER_STAFF_MAX: z.coerce.number().int().positive().default(30),
  // §5: the resolve result is "bound to a short-lived verification session --
  // staff can act on that member for a few minutes, then the context expires."
  // "A few minutes" is the only quantity given.
  VERIFICATION_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  // Development-only OTP delivery. Honoured only when NODE_ENV is
  // 'development' as well -- see src/security/dev-otp.ts for why both gates
  // exist. Defaults off, so it must be switched on deliberately.
  // Only the exact string "true" enables it. Anything else — absent, empty,
  // "1", "TRUE", "yes" — is off, so a typo fails closed.
  DEV_OTP_ECHO: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),

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
