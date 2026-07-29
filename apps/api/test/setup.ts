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
