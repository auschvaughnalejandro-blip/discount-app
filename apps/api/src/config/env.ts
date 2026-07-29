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
