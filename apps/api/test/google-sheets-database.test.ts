/** Integration proof for the real least-privileged PostgreSQL projection. */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  readHotelSheetsSource,
  type HotelSheetsSnapshot,
} from '../src/integrations/google-sheets/snapshot.js';
import { syncGoogleSheets } from '../src/integrations/google-sheets/sync.js';

const appUrl = process.env['DATABASE_URL'];
const ownerUrl = process.env['DATABASE_MIGRATION_URL'];
if (!appUrl || !ownerUrl) {
  throw new Error(
    'DATABASE_URL and DATABASE_MIGRATION_URL must be set to run Google Sheets database tests.',
  );
}

const appPrisma = new PrismaClient({ datasourceUrl: appUrl });
const ownerPrisma = new PrismaClient({ datasourceUrl: ownerUrl });
const testStartedAt = new Date();

beforeAll(async () => {
  await Promise.all([appPrisma.$connect(), ownerPrisma.$connect()]);
});

afterAll(async () => {
  await ownerPrisma.auditLog.deleteMany({
    where: {
      actorType: 'SYSTEM',
      subjectType: 'GoogleSheetsMirror',
      occurredAt: { gte: testStartedAt },
    },
  });
  await Promise.all([appPrisma.$disconnect(), ownerPrisma.$disconnect()]);
});

describe('the Google Sheets database projection', () => {
  it('runs as the application role and never reads member names or contact details', async () => {
    const source = await readHotelSheetsSource(appPrisma);
    const memberPrivateFields = await ownerPrisma.member.findMany({
      select: { fullName: true, phone: true, email: true },
    });
    const serialized = JSON.stringify(source);

    for (const member of memberPrivateFields) {
      expect(serialized).not.toContain(member.fullName);
      if (member.phone) expect(serialized).not.toContain(member.phone);
      if (member.email) expect(serialized).not.toContain(member.email);
    }
  });

  it('records a completed publication as a system export with counts only', async () => {
    const publisher = {
      replace: async (snapshot: HotelSheetsSnapshot) => ({
        generatedAt: snapshot.generatedAt.toISOString(),
        rows: Object.fromEntries(snapshot.tables.map((table) => [table.title, table.rows.length])),
      }),
    };

    const result = await syncGoogleSheets(appPrisma, publisher, testStartedAt);
    expect(result.rows).toHaveProperty('Members');

    const audit = await ownerPrisma.auditLog.findFirstOrThrow({
      where: {
        actorType: 'SYSTEM',
        subjectType: 'GoogleSheetsMirror',
        occurredAt: { gte: testStartedAt },
      },
      orderBy: { occurredAt: 'desc' },
    });
    const serialized = JSON.stringify(audit.metadata);
    expect(audit.action).toBe('report.exported');
    expect(serialized).toContain('google_sheets');

    const names = await ownerPrisma.member.findMany({ select: { fullName: true } });
    for (const { fullName } of names) {
      expect(serialized).not.toContain(fullName);
    }
  });
});
