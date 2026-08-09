import { Prisma, type PrismaClient } from '@prisma/client';

import type { GoogleSheetsPublisher, PublishedSheetCounts } from './publisher.js';
import { buildHotelSheetsSnapshot, readHotelSheetsSource } from './snapshot.js';

export interface SheetsPublisher {
  replace: GoogleSheetsPublisher['replace'];
}

/** One complete, idempotent reconciliation from PostgreSQL to the workbook. */
export async function syncGoogleSheets(
  prisma: PrismaClient,
  publisher: SheetsPublisher,
  generatedAt = new Date(),
): Promise<PublishedSheetCounts> {
  const source = await readHotelSheetsSource(prisma);
  const snapshot = buildHotelSheetsSnapshot(source, generatedAt);
  const published = await publisher.replace(snapshot);

  // A scheduled mirror is still a standing bulk export. Record each completed
  // disclosure with row counts only; never put member data or credentials in
  // audit metadata.
  await prisma.auditLog.create({
    data: {
      actorType: 'SYSTEM',
      actorId: null,
      action: 'report.exported',
      subjectType: 'GoogleSheetsMirror',
      subjectId: null,
      metadata: {
        destination: 'google_sheets',
        generatedAt: published.generatedAt,
        rows: published.rows,
      } as Prisma.InputJsonValue,
      ipAddress: null,
    },
  });

  return published;
}
