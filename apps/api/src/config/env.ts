import { z } from 'zod';

/**
 * Stage 0 validates only the variables Stage 0 uses. Each later stage extends
 * this schema with the variables it introduces, so a missing secret fails at
 * startup rather than at first use. Every variable is already named in
 * `.env.example`.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().positive().max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1),
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
