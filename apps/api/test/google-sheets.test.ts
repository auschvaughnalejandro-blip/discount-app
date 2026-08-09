import type { sheets_v4 } from 'googleapis';
import { describe, expect, it, vi } from 'vitest';

import { loadEnv } from '../src/config/env.js';
import { requireGoogleSheetsConfig } from '../src/integrations/google-sheets/config.js';
import { GoogleSheetsPublisher } from '../src/integrations/google-sheets/publisher.js';
import {
  buildHotelSheetsSnapshot,
  type HotelSheetsSource,
} from '../src/integrations/google-sheets/snapshot.js';

const generatedAt = new Date('2026-08-09T10:00:00.000Z');

function source(): HotelSheetsSource {
  return {
    members: [
      {
        memberNumber: 'PG-0003',
        status: 'ACTIVE',
        joinedAt: new Date('2026-01-02T00:00:00.000Z'),
        claimed: true,
        totalUses: 2,
        lastUsedAt: new Date('2026-08-08T18:30:00.000Z'),
      },
    ],
    benefits: [
      {
        key: 'dining',
        title: '=HYPERLINK("https://attacker.invalid")',
        category: 'Dining',
        discountPct: '25.00',
        secondaryLabel: null,
        secondaryPct: null,
        childRulesJson: '{"6-12":50}',
        maxGuests: 6,
        minGuests: null,
        reservationPhone: '+97440000000',
        terms: 'Hotel terms',
        published: true,
        sortOrder: 1,
        outletKind: 'DINING',
        version: 3,
        updatedAt: new Date('2026-08-01T09:00:00.000Z'),
      },
    ],
    outlets: [{ name: 'Main Restaurant', kind: 'DINING', active: true }],
    requests: [
      {
        requestedAt: new Date('2026-08-09T08:00:00.000Z'),
        memberNumber: 'PG-0003',
        benefit: 'Dining',
        status: 'PENDING',
        decidedAt: null,
        fulfilledAt: null,
      },
    ],
    redemptions: [
      {
        occurredAt: new Date('2026-08-08T18:30:00.000Z'),
        memberNumber: 'PG-0003',
        benefit: 'Dining',
        outlet: 'Main Restaurant',
        discountPct: '25.00',
        partySize: 2,
        billAmountMinor: 10_000,
        recordedBy: 'Hotel Administrator',
        reversal: false,
        reversed: false,
      },
    ],
  };
}

function metadata() {
  return [
    'Overview',
    'Members',
    'Requests',
    'Redemptions',
    'Benefits',
    'Outlets',
    'Sync Info',
  ].map((title, index) => ({
      properties: {
        title,
        sheetId: index + 1,
        sheetType: 'GRID',
        gridProperties: { rowCount: 100, columnCount: 20 },
      },
    }));
}

function fakeApi(getResponse = metadata()) {
  const get = vi.fn().mockResolvedValue({ data: { sheets: getResponse } });
  const batchUpdate = vi.fn().mockResolvedValue({ data: {} });
  const api = {
    spreadsheets: { get, batchUpdate },
  } as unknown as sheets_v4.Sheets;
  return { api, get, batchUpdate };
}

describe('the Google Sheets snapshot privacy boundary', () => {
  it('contains fixed operational columns and no member PII or security fields', () => {
    const withUnexpectedPrivateFields = source() as HotelSheetsSource & {
      fullName: string;
      phone: string;
      email: string;
      passwordHash: string;
      mfaSecret: string;
      refreshToken: string;
      requestNote: string;
    };
    Object.assign(withUnexpectedPrivateFields, {
      fullName: 'PRIVATE MEMBER NAME',
      phone: '+97455559999',
      email: 'private@example.test',
      passwordHash: 'PRIVATE PASSWORD HASH',
      mfaSecret: 'PRIVATE MFA SECRET',
      refreshToken: 'PRIVATE REFRESH TOKEN',
      requestNote: 'PRIVATE REQUEST NOTE',
    });

    const snapshot = buildHotelSheetsSnapshot(withUnexpectedPrivateFields, generatedAt);
    const serialized = JSON.stringify(snapshot);
    const members = snapshot.tables.find((table) => table.title === 'Members');

    expect(snapshot.tables.map((table) => table.title)).toEqual([
      'Overview',
      'Members',
      'Requests',
      'Redemptions',
      'Benefits',
      'Outlets',
      'Sync Info',
    ]);
    expect(members?.columns).toEqual([
      'Membership Number',
      'Status',
      'Joined Date',
      'App Activated',
      'Total Uses',
      'Last Used',
    ]);

    for (const privateValue of [
      'PRIVATE MEMBER NAME',
      '+97455559999',
      'private@example.test',
      'PRIVATE PASSWORD HASH',
      'PRIVATE MFA SECRET',
      'PRIVATE REFRESH TOKEN',
      'PRIVATE REQUEST NOTE',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(serialized).toContain('PostgreSQL');
    expect(serialized).toContain('Read only');
  });

  it('preserves financial values and the rate applied on the visit', () => {
    const snapshot = buildHotelSheetsSnapshot(source(), generatedAt);
    const table = snapshot.tables.find((entry) => entry.title === 'Redemptions');

    expect(table?.rows[0]).toEqual([
      '08 Aug 2026, 21:30',
      'PG-0003',
      'Dining',
      'Main Restaurant',
      25,
      2,
      100,
      25,
      'Hotel Administrator',
      'Redemption',
    ]);
  });
});

describe('atomic Google Sheets publication', () => {
  it('clears stale cells and writes strings as literals, never formulas', async () => {
    const { api, batchUpdate } = fakeApi();
    const publisher = new GoogleSheetsPublisher(api, 'spreadsheet-id');

    const result = await publisher.replace(buildHotelSheetsSnapshot(source(), generatedAt));

    expect(result.rows).toMatchObject({ Members: 1, Requests: 1, Benefits: 1, Redemptions: 1 });
    expect(batchUpdate).toHaveBeenCalledTimes(1);

    const requestBody = batchUpdate.mock.calls[0]?.[0]?.requestBody;
    const serialized = JSON.stringify(requestBody);
    expect(serialized).toContain('userEnteredValue');
    expect(serialized).toContain('stringValue');
    expect(serialized).toContain('=HYPERLINK');
    expect(serialized).not.toContain('formulaValue');

    const requests = requestBody?.requests as sheets_v4.Schema$Request[];
    expect(requests.some((request) => request.repeatCell?.fields === 'userEnteredValue')).toBe(
      true,
    );
    expect(requests.some((request) => request.updateCells !== undefined)).toBe(true);
  });

  it('creates only missing managed tabs and preserves unrelated worksheets', async () => {
    const finalMetadata = metadata();
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          sheets: [
            {
              properties: {
                title: 'Hotel notes',
                sheetId: 99,
                sheetType: 'GRID',
                gridProperties: { rowCount: 20, columnCount: 5 },
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          sheets: [
            ...finalMetadata,
            {
              properties: {
                title: 'Hotel notes',
                sheetId: 99,
                sheetType: 'GRID',
                gridProperties: { rowCount: 20, columnCount: 5 },
              },
            },
          ],
        },
      });
    const batchUpdate = vi.fn().mockResolvedValue({ data: {} });
    const api = { spreadsheets: { get, batchUpdate } } as unknown as sheets_v4.Sheets;

    await new GoogleSheetsPublisher(api, 'spreadsheet-id').replace(
      buildHotelSheetsSnapshot(source(), generatedAt),
    );

    expect(batchUpdate).toHaveBeenCalledTimes(2);
    const createRequests = batchUpdate.mock.calls[0]?.[0]?.requestBody?.requests;
    expect(createRequests).toHaveLength(7);
    expect(JSON.stringify(batchUpdate.mock.calls[1]?.[0])).not.toContain('"sheetId":99');
  });
});

describe('Google Sheets configuration', () => {
  const base = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
    PASSWORD_PEPPER: 'a-secure-password-pepper',
    OTP_CODE_HMAC_SECRET: 'a-secure-otp-secret',
    JWT_ISSUER: 'https://api.example.test',
    JWT_AUDIENCE_MEMBER: 'members',
    JWT_AUDIENCE_STAFF: 'staff',
    JWT_SIGNING_KEY: 'a-secure-jwt-signing-key-at-least-32-bytes',
    MFA_SECRET_ENCRYPTION_KEY: '00'.repeat(32),
  } satisfies NodeJS.ProcessEnv;

  it('is disabled by default and does not require Google credentials at API startup', () => {
    const env = loadEnv(base);
    expect(env.GOOGLE_SHEETS_SYNC_ENABLED).toBe(false);
  });

  it('requires all credentials when automatic sync is enabled', () => {
    expect(() => loadEnv({ ...base, GOOGLE_SHEETS_SYNC_ENABLED: 'true' })).toThrow(
      /GOOGLE_SHEETS_SPREADSHEET_ID/,
    );
  });

  it('decodes the private key only after validation', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----';
    const env = loadEnv({
      ...base,
      GOOGLE_SHEETS_SYNC_ENABLED: 'true',
      GOOGLE_SHEETS_SPREADSHEET_ID: 'abc_123-XYZ',
      GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL: 'mirror@test.iam.gserviceaccount.com',
      GOOGLE_SHEETS_PRIVATE_KEY_BASE64: Buffer.from(pem).toString('base64'),
    });

    expect(requireGoogleSheetsConfig(env)).toMatchObject({
      spreadsheetId: 'abc_123-XYZ',
      serviceAccountEmail: 'mirror@test.iam.gserviceaccount.com',
      privateKey: pem,
      intervalSeconds: 300,
    });
  });
});
