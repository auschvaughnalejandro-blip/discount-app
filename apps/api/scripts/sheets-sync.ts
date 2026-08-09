import { PrismaClient } from '@prisma/client';

import { loadEnv } from '../src/config/env.js';
import { requireGoogleSheetsConfig } from '../src/integrations/google-sheets/config.js';
import { createGoogleSheetsPublisher } from '../src/integrations/google-sheets/publisher.js';
import { syncGoogleSheets } from '../src/integrations/google-sheets/sync.js';

function operatorMessage(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('Google Sheets is not configured.')) {
    return error.message;
  }
  if (error instanceof Error && error.message.startsWith('GOOGLE_SHEETS_')) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: unknown; response?: { status?: unknown } };
    const status = candidate.response?.status ?? candidate.code;
    if (status === 401) return 'Google rejected the service-account credentials.';
    if (status === 403) return 'The service account does not have Editor access to the workbook.';
    if (status === 404) return 'The configured spreadsheet ID was not found.';
    if (status === 429) return 'Google Sheets quota was exceeded; retry later.';
    if (typeof status === 'string' && status.startsWith('P')) {
      return 'The PostgreSQL snapshot could not be read.';
    }
  }
  return 'The mirror could not be updated. See the runbook for safe diagnostics.';
}

async function main(): Promise<void> {
  const env = loadEnv();
  const config = requireGoogleSheetsConfig(env);
  const publisher = createGoogleSheetsPublisher(config);
  const prisma = new PrismaClient();

  try {
    const result = await syncGoogleSheets(prisma, publisher);
    const lines = [
      `Google Sheets mirror updated at ${result.generatedAt}`,
      ...Object.entries(result.rows).map(([title, rows]) => `  ${title}: ${rows} rows`),
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Google Sheets sync failed: ${operatorMessage(error)}\n`);
  process.exitCode = 1;
});
