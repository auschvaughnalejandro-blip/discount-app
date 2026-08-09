import type { Env } from '../../config/env.js';

export interface GoogleSheetsConfig {
  spreadsheetId: string;
  serviceAccountEmail: string;
  privateKey: string;
  intervalSeconds: number;
}

const SPREADSHEET_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Resolve the conditionally required settings without ever echoing credential
 * values in an error. The one-shot command uses this even when automatic sync
 * is disabled, which makes manual reconciliation possible before scheduling is
 * switched on.
 */
export function requireGoogleSheetsConfig(env: Env): GoogleSheetsConfig {
  if (
    env.GOOGLE_SHEETS_SPREADSHEET_ID === undefined ||
    env.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL === undefined ||
    env.GOOGLE_SHEETS_PRIVATE_KEY_BASE64 === undefined
  ) {
    throw new Error(
      'Google Sheets is not configured. Set the spreadsheet ID, service account email, ' +
        'and base64-encoded private key.',
    );
  }

  if (!SPREADSHEET_ID.test(env.GOOGLE_SHEETS_SPREADSHEET_ID)) {
    throw new Error(
      'GOOGLE_SHEETS_SPREADSHEET_ID must be the ID between /d/ and /edit in the Sheet URL.',
    );
  }

  return {
    spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID,
    serviceAccountEmail: env.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL,
    privateKey: Buffer.from(env.GOOGLE_SHEETS_PRIVATE_KEY_BASE64, 'base64').toString('utf8'),
    intervalSeconds: env.GOOGLE_SHEETS_SYNC_INTERVAL_SECONDS,
  };
}
