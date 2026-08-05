/**
 * Regex for Finnish amounts, e.g. "1 234,56", "1.234,56", "243,06"; 
 * fallback dot-decimal "243.06" (dot-decimal guarded so date fragments like 
 * "20.05" in "20.05.2026" never match).
 */
export const AMOUNT_RE =
  /\d{1,3}(?:[ .\u00a0]\d{3})*,\d{2}(?!\d)|(?<![\d.])(\d+\.\d{2})(?![.\d])/g;

/**
 * Parses a string amount to a number, handling Finnish formatting.
 */
export function parseAmount(s: string): number {
  if (s.includes(",")) {
    return parseFloat(s.replace(/[ .\u00a0]/g, "").replace(",", "."));
  }
  return parseFloat(s);
}

/**
 * Extracts all matched amounts from a line of text.
 */
export function amountsOnLine(line: string): number[] {
  return [...line.matchAll(AMOUNT_RE)].map((m) => parseAmount(m[0]));
}

/**
 * Validates if the parsed year, month, and day represent a valid date.
 */
export function isIsoCalendarDateParts(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const daysInMonth = new Date(y, m, 0).getDate();
  return d <= daysInMonth;
}

/**
 * Validates if a YYYY-MM-DD string is a valid date.
 */
export function isIsoCalendarDate(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export const DATE_RE = /(\d{1,2})[./](\d{1,2})[./](20\d{2})/;

/**
 * Creates an ISO date string (YYYY-MM-DD) from a RegExpMatchArray matching DATE_RE.
 */
export function isoFromDateMatch(m: RegExpMatchArray): string {
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}
