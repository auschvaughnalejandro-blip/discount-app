import { google, type sheets_v4 } from 'googleapis';

import type { GoogleSheetsConfig } from './config.js';
import type { HotelSheetsSnapshot, SheetCell, SheetTable } from './snapshot.js';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const REQUEST_TIMEOUT_MS = 30_000;

export interface PublishedSheetCounts {
  generatedAt: string;
  rows: Record<string, number>;
}

function extendedValue(value: SheetCell): sheets_v4.Schema$ExtendedValue {
  if (typeof value === 'number') {
    return { numberValue: value };
  }
  if (typeof value === 'boolean') {
    return { boolValue: value };
  }
  // Never use formulaValue. A title or term beginning with "=" remains a
  // literal string rather than becoming spreadsheet-formula injection.
  return { stringValue: value };
}

function valuesFor(table: SheetTable): SheetCell[][] {
  return [[...table.columns], ...table.rows];
}

function numericFormats(
  table: SheetTable,
  sheetId: number,
  endRowIndex: number,
): sheets_v4.Schema$Request[] {
  if (endRowIndex <= 1) {
    return [];
  }

  const formats =
    table.title === 'Benefits'
      ? [{ columnIndex: 2, type: 'NUMBER', pattern: '0.##"%"' }]
      : table.title === 'Redemptions'
        ? [
            { columnIndex: 4, type: 'NUMBER', pattern: '0.##"%"' },
            { columnIndex: 6, type: 'CURRENCY', pattern: '"QAR" #,##0.00;[RED]-"QAR" #,##0.00' },
            { columnIndex: 7, type: 'CURRENCY', pattern: '"QAR" #,##0.00;[RED]-"QAR" #,##0.00' },
          ]
        : [];

  const requests = formats.map(({ columnIndex, type, pattern }) => ({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: 1,
        endRowIndex,
        startColumnIndex: columnIndex,
        endColumnIndex: columnIndex + 1,
      },
      cell: {
        userEnteredFormat: {
          numberFormat: { type, pattern },
        },
      },
      fields: 'userEnteredFormat.numberFormat',
    },
  }));

  if (table.title === 'Overview') {
    for (const columnIndex of [2, 4]) {
      requests.push({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: 7,
            endRowIndex: 8,
            startColumnIndex: columnIndex,
            endColumnIndex: columnIndex + 1,
          },
          cell: {
            userEnteredFormat: {
              numberFormat: {
                type: 'CURRENCY',
                pattern: '"QAR" #,##0.00;[RED]-"QAR" #,##0.00',
              },
            },
          },
          fields: 'userEnteredFormat.numberFormat',
        },
      });
    }
  }

  return requests;
}

const STATUS_FORMATS = [
  {
    values: ['Active', 'Approved', 'Fulfilled', 'Published', 'Redemption', 'Yes'],
    backgroundColor: { red: 0.82, green: 0.94, blue: 0.87 },
    foregroundColor: { red: 0.08, green: 0.35, blue: 0.22 },
  },
  {
    values: ['Pending'],
    backgroundColor: { red: 1, green: 0.94, blue: 0.72 },
    foregroundColor: { red: 0.38, green: 0.27, blue: 0.03 },
  },
  {
    values: ['Suspended', 'Declined', 'Inactive', 'Reversal', 'Reversed redemption'],
    backgroundColor: { red: 0.98, green: 0.84, blue: 0.84 },
    foregroundColor: { red: 0.55, green: 0.09, blue: 0.09 },
  },
  {
    values: ['Draft', 'No'],
    backgroundColor: { red: 0.9, green: 0.91, blue: 0.92 },
    foregroundColor: { red: 0.28, green: 0.3, blue: 0.33 },
  },
] as const;

function conditionalFormats(
  table: SheetTable,
  sheetId: number,
  endRowIndex: number,
): sheets_v4.Schema$Request[] {
  if (table.title === 'Overview' || table.title === 'Sync Info' || endRowIndex <= 1) return [];

  return STATUS_FORMATS.flatMap((style) =>
    style.values.map((value, index) => ({
      addConditionalFormatRule: {
        index,
        rule: {
          ranges: [
            {
              sheetId,
              startRowIndex: 1,
              endRowIndex,
              startColumnIndex: 0,
              endColumnIndex: table.columns.length,
            },
          ],
          booleanRule: {
            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: value }] },
            format: {
              backgroundColor: style.backgroundColor,
              textFormat: { foregroundColor: style.foregroundColor, bold: true },
            },
          },
        },
      },
    })),
  );
}

/**
 * Owns only the seven fixed mirror tabs. Workbook permissions and any unrelated
 * worksheets remain under the hotel's control.
 */
export class GoogleSheetsPublisher {
  constructor(
    private readonly api: sheets_v4.Sheets,
    private readonly spreadsheetId: string,
  ) {}

  async replace(snapshot: HotelSheetsSnapshot): Promise<PublishedSheetCounts> {
    let sheets = await this.readSheets();
    const byTitle = new Map(
      sheets
        .filter((entry) => entry.properties?.title !== undefined)
        .map((entry) => [entry.properties?.title as string, entry]),
    );

    // Schema v1 called this managed worksheet `_Sync`. Rename it in place so
    // existing workbooks end up with exactly the approved seven tabs rather
    // than retaining an orphaned eighth tab.
    const legacySync = byTitle.get('_Sync');
    if (!byTitle.has('Sync Info') && legacySync?.properties?.sheetId !== undefined) {
      await this.api.spreadsheets.batchUpdate(
        {
          spreadsheetId: this.spreadsheetId,
          requestBody: {
            requests: [
              {
                updateSheetProperties: {
                  properties: { sheetId: legacySync.properties.sheetId, title: 'Sync Info' },
                  fields: 'title',
                },
              },
            ],
          },
        },
        { timeout: REQUEST_TIMEOUT_MS },
      );
      sheets = await this.readSheets();
    }

    const currentByTitle = new Map(
      sheets
        .filter((entry) => entry.properties?.title !== undefined)
        .map((entry) => [entry.properties?.title as string, entry]),
    );

    const missing = snapshot.tables.filter((table) => !currentByTitle.has(table.title));
    if (missing.length > 0) {
      await this.api.spreadsheets.batchUpdate(
        {
          spreadsheetId: this.spreadsheetId,
          requestBody: {
            requests: missing.map((table) => ({
              addSheet: {
                properties: {
                  title: table.title,
                  gridProperties: {
                    rowCount: Math.max(table.rows.length + 1, 2),
                    columnCount: Math.max(table.columns.length, 2),
                    frozenRowCount: 1,
                  },
                },
              },
            })),
          },
        },
        { timeout: REQUEST_TIMEOUT_MS },
      );

      sheets = await this.readSheets();
    }

    const refreshedByTitle = new Map(
      sheets
        .filter((entry) => entry.properties?.title !== undefined)
        .map((entry) => [entry.properties?.title as string, entry]),
    );
    const requests: sheets_v4.Schema$Request[] = [];

    for (const [tableIndex, table] of snapshot.tables.entries()) {
      const sheet = refreshedByTitle.get(table.title);
      // Narrowed on the sheet itself rather than only on its id, so everything
      // below can read `sheet.…` without re-testing. The id check alone left
      // `sheet` possibly undefined, which is what the compiler was pointing at.
      if (!sheet) {
        throw new Error(`Google Sheets did not return the managed tab ${table.title}.`);
      }
      const sheetId = sheet.properties?.sheetId;
      if (sheetId === undefined || sheetId === null) {
        throw new Error(`Google Sheets did not return an ID for the managed tab ${table.title}.`);
      }
      if (sheet.properties?.sheetType !== undefined && sheet.properties.sheetType !== 'GRID') {
        throw new Error(`The managed tab ${table.title} must be a normal grid worksheet.`);
      }

      const values = valuesFor(table);
      const rowCount = Math.max(values.length, 2);
      const columnCount = Math.max(table.columns.length, 2);

      // Clear the filter before a possible grid shrink, then recreate it over
      // the exact new data range below.
      for (let index = (sheet.conditionalFormats?.length ?? 0) - 1; index >= 0; index--) {
        requests.push({ deleteConditionalFormatRule: { sheetId, index } });
      }

      requests.push(
        { clearBasicFilter: { sheetId } },
        {
          updateSheetProperties: {
            properties: {
              sheetId,
              index: tableIndex,
              gridProperties: {
                rowCount,
                columnCount,
                frozenRowCount: table.title === 'Overview' ? 2 : 1,
              },
            },
            fields:
              'index,gridProperties.rowCount,gridProperties.columnCount,' +
              'gridProperties.frozenRowCount',
          },
        },
        {
          // Including a field in the mask while leaving it unset clears it.
          // This removes stale rows when a later snapshot is smaller.
          repeatCell: {
            range: { sheetId },
            cell: {},
            fields: 'userEnteredValue',
          },
        },
        {
          updateCells: {
            start: { sheetId, rowIndex: 0, columnIndex: 0 },
            rows: values.map((row) => ({
              values: row.map((value) => ({ userEnteredValue: extendedValue(value) })),
            })),
            fields: 'userEnteredValue',
          },
        },
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 0,
              endRowIndex: 1,
              startColumnIndex: 0,
              endColumnIndex: table.columns.length,
            },
            cell: {
              userEnteredFormat: {
                backgroundColorStyle: {
                  rgbColor: { red: 0.04, green: 0.38, blue: 0.31 },
                },
                textFormat: {
                  bold: true,
                  foregroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } },
                },
                horizontalAlignment: 'CENTER',
                wrapStrategy: 'WRAP',
              },
            },
            fields:
              'userEnteredFormat(backgroundColorStyle,textFormat,' +
              'horizontalAlignment,wrapStrategy)',
          },
        },
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 1,
              endRowIndex: values.length,
              startColumnIndex: 0,
              endColumnIndex: table.columns.length,
            },
            cell: {
              userEnteredFormat: {
                verticalAlignment: 'MIDDLE',
                wrapStrategy: 'WRAP',
              },
            },
            fields: 'userEnteredFormat(verticalAlignment,wrapStrategy)',
          },
        },
        ...numericFormats(table, sheetId, values.length),
        ...conditionalFormats(table, sheetId, values.length),
      );

      if (table.title !== 'Overview' && table.title !== 'Sync Info') {
        requests.push({
          setBasicFilter: {
            filter: {
              range: {
                sheetId,
                startRowIndex: 0,
                endRowIndex: values.length,
                startColumnIndex: 0,
                endColumnIndex: table.columns.length,
              },
            },
          },
        });
      }

      requests.push({
        autoResizeDimensions: {
          dimensions: {
            sheetId,
            dimension: 'COLUMNS',
            startIndex: 0,
            endIndex: table.columns.length,
          },
        },
      });

      if (table.title === 'Benefits') {
        requests.push({
          updateDimensionProperties: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: 8, endIndex: 9 },
            properties: { pixelSize: 420 },
            fields: 'pixelSize',
          },
        });
      }

      if (table.title === 'Overview') {
        for (const startColumnIndex of [0, 2, 4, 6]) {
          requests.push({
            updateDimensionProperties: {
              range: {
                sheetId,
                dimension: 'COLUMNS',
                startIndex: startColumnIndex,
                endIndex: startColumnIndex + 1,
              },
              properties: { pixelSize: 190 },
              fields: 'pixelSize',
            },
          });
        }
        for (const startColumnIndex of [1, 3, 5, 7]) {
          requests.push({
            updateDimensionProperties: {
              range: {
                sheetId,
                dimension: 'COLUMNS',
                startIndex: startColumnIndex,
                endIndex: startColumnIndex + 1,
              },
              properties: { pixelSize: startColumnIndex === 1 || startColumnIndex === 5 ? 70 : 28 },
              fields: 'pixelSize',
            },
          });
        }
        for (const startRowIndex of [3, 6]) {
          requests.push({
            repeatCell: {
              range: {
                sheetId,
                startRowIndex,
                endRowIndex: startRowIndex + 2,
                startColumnIndex: 0,
                endColumnIndex: 8,
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.9, green: 0.96, blue: 0.94 },
                  textFormat: { bold: true },
                  horizontalAlignment: 'CENTER',
                },
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
            },
          });
        }
        requests.push({
          repeatCell: {
            range: { sheetId, startRowIndex: 4, endRowIndex: 5, startColumnIndex: 0, endColumnIndex: 8 },
            cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 16 } } },
            fields: 'userEnteredFormat.textFormat',
          },
        });
        requests.push({
          repeatCell: {
            range: { sheetId, startRowIndex: 7, endRowIndex: 8, startColumnIndex: 0, endColumnIndex: 8 },
            cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 16 } } },
            fields: 'userEnteredFormat.textFormat',
          },
        });
        requests.push({
          repeatCell: {
            range: { sheetId, startRowIndex: 9, endRowIndex: 10, startColumnIndex: 0, endColumnIndex: 6 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.04, green: 0.38, blue: 0.31 },
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat)',
          },
        });
      }
    }

    // Google validates every request first and applies this batch atomically.
    // Readers therefore see either the previous snapshot or the complete new
    // one, never a workbook with half its tabs refreshed.
    await this.api.spreadsheets.batchUpdate(
      {
        spreadsheetId: this.spreadsheetId,
        requestBody: { requests },
      },
      { timeout: REQUEST_TIMEOUT_MS },
    );

    return {
      generatedAt: snapshot.generatedAt.toISOString(),
      rows: Object.fromEntries(snapshot.tables.map((table) => [table.title, table.rows.length])),
    };
  }

  private async readSheets(): Promise<sheets_v4.Schema$Sheet[]> {
    const response = await this.api.spreadsheets.get(
      {
        spreadsheetId: this.spreadsheetId,
        fields:
          'sheets(properties(sheetId,title,sheetType,gridProperties),conditionalFormats)',
      },
      { timeout: REQUEST_TIMEOUT_MS },
    );

    return response.data.sheets ?? [];
  }
}

export function createGoogleSheetsPublisher(config: GoogleSheetsConfig): GoogleSheetsPublisher {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: config.serviceAccountEmail,
      private_key: config.privateKey,
    },
    scopes: [SHEETS_SCOPE],
  });

  return new GoogleSheetsPublisher(google.sheets({ version: 'v4', auth }), config.spreadsheetId);
}
