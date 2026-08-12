/**
 * CSV serialisation for the files that leave this system.
 *
 * Extracted from `routes/reports.ts`, which held the only copy while the
 * redemption export was the only export. The card export writes member names —
 * exactly the input the quoting rules below exist for — so the two share one
 * implementation rather than growing a second that is subtly different about
 * quotes, newlines or the BOM.
 */

/** U+FEFF, written as an escape: a literal BOM here is invisible in an editor
 *  and survives exactly one careless copy-paste. */
const BOM = '\ufeff';

/**
 * Minimal RFC 4180. Quote every field and double any quote inside it.
 *
 * Quoting unconditionally rather than only when needed: a member called
 * "Al-Thani, Noora" or an outlet called "Crust, Doha" or a staff member called
 * O'Brien would otherwise shift every column after it, and a spreadsheet that is
 * subtly wrong is worse than one that fails to open.
 *
 * The BOM, because Excel reads a UTF-8 file without one as the local codepage
 * and mangles any non-ASCII name — which, for this programme's membership, is
 * a good share of them.
 */
export function toCsv(header: string[], rows: string[][]): string {
  const escape = (field: string) => `"${field.replace(/"/g, '""')}"`;
  const lines = [header, ...rows].map((row) => row.map(escape).join(','));
  return `${BOM}${lines.join('\r\n')}\r\n`;
}
