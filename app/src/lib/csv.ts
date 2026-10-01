/**
 * CSV export for bookkeeping data.
 *
 * Semicolon-separated with a UTF-8 BOM and comma decimals: that is what a
 * Finnish Excel opens correctly without an import wizard. Every field is
 * escaped, so a customer name containing a semicolon or a newline cannot
 * shift the columns of the file an accountant receives.
 */

export type CsvValue = string | number | null | undefined;

export const CSV_SEPARATOR = ";";
// Written as an escape: an invisible literal here is impossible to review.
export const UTF8_BOM = "\uFEFF";

/** Finnish decimal comma with exactly two decimals. */
export function csvMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return value.toFixed(2).replace(".", ",");
}

export function escapeCsvField(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  // A leading =, +, - or @ makes a spreadsheet evaluate the cell as a formula.
  // A real number, and the plain negative amount csvMoney writes ("-12,50"),
  // cannot be a formula and must stay a number so a spreadsheet can sum it;
  // the guard is for text cells only.
  const isPlainNumber = typeof value === "number" || /^-\d+,\d{2}$/.test(text);
  const guarded =
    !isPlainNumber && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  if (
    guarded.includes(CSV_SEPARATOR) ||
    guarded.includes('"') ||
    guarded.includes("\n") ||
    guarded.includes("\r")
  ) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

export function toCsv(headers: string[], rows: CsvValue[][]): string {
  const lines = [headers, ...rows].map((row) =>
    row.map(escapeCsvField).join(CSV_SEPARATOR)
  );
  // CRLF: the line ending every spreadsheet agrees on.
  return `${UTF8_BOM}${lines.join("\r\n")}\r\n`;
}

/** Content-Disposition value with a filename safe for any client. */
export function csvAttachmentHeaders(fileName: string): Record<string, string> {
  const safe = fileName.replace(/[^A-Za-z0-9._-]/g, "_");
  return {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${safe}"`,
    "Cache-Control": "private, no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
  };
}
