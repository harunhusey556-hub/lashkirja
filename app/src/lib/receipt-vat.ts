/**
 * Money and VAT rules of the receipt form, in one place so the editor and the
 * receipt routes agree (F03, F35, F120, F164). Pure: no React, no database.
 */
import { RATE_TO_FIELD } from "./vero/omavero-fields";
import { parseMoneyInput } from "./format";
import { eurosToCents } from "./money";

/** Default rate of a fresh VAT row; the editor shows it and computes from it. */
export const DEFAULT_VAT_RATE = "25.5";

/** Rates the VAT return knows (current and legacy ones) plus the explicit 0 %. */
const ALLOWED_VAT_RATES = new Set<number>([0, ...Object.keys(RATE_TO_FIELD).map(Number)]);

export function isSupportedVatRate(rate: number): boolean {
  return ALLOWED_VAT_RATES.has(rate);
}

/**
 * The one amount parser of the receipt screens. On top of parseMoneyInput
 * (space, NBSP, thin space, comma or dot, a trailing euro sign) it reads
 * dot-grouped "1.234,50" and comma-grouped "1,234.50": when both separators
 * appear the last one is the decimal mark and the other one groups thousands.
 */
export function parseReceiptAmount(value: string): number | null {
  const text = value.trim();
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  if (lastComma !== -1 && lastDot !== -1) {
    return parseMoneyInput(
      lastComma > lastDot ? text.replace(/\./g, "") : text.replace(/,/g, "")
    );
  }
  return parseMoneyInput(text);
}

const fieldFormatter = new Intl.NumberFormat("fi-FI", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** A stored amount as the Finnish field text: "24,90", "1 234,50", "0,20". */
export function moneyField(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return fieldFormatter.format(value);
}

/** The VAT inside a gross amount, in whole cents (integer maths, no float drift). */
function vatCentsInGross(grossEuros: number, rate: number): number {
  return Math.round((eurosToCents(grossEuros) * rate) / (100 + rate));
}

/** VAT of the typed total at the chosen rate as Finnish field text; null when it cannot be told. */
export function autoVatAmount(totalText: string, rateText: string): string | null {
  const total = parseReceiptAmount(totalText);
  const rate = Number(rateText);
  if (total === null || total < 0 || !rateText.trim() || !Number.isFinite(rate) || rate < 0) return null;
  return moneyField(vatCentsInGross(total, rate) / 100);
}

/**
 * A VAT row of the form. `auto` means the amount follows the total and the rate.
 * `defaulted` means the rate is only the default of the receipt date: nobody
 * chose it, so it moves with the date (V9).
 */
export interface VatRow {
  rate: string;
  amount: string;
  auto?: boolean;
  defaulted?: boolean;
}

/** The general rate rose from 24 % to 25,5 % on 1.9.2024. */
const GENERAL_RATE_CHANGE_DATE = "2024-09-01";
/** The reduced rate of 14 % became 13,5 % on 1.1.2026. */
const REDUCED_RATE_CHANGE_DATE = "2026-01-01";

/** The general VAT rate on the receipt date; 25,5 while the date is not known. */
export function defaultVatRateForDate(date: string): string {
  return date && date < GENERAL_RATE_CHANGE_DATE ? "24" : DEFAULT_VAT_RATE;
}

/** The rates the form offers for a receipt date: general, reduced, 10 % and 0 %. */
export function vatRateChoicesForDate(date: string): string[] {
  const reduced = date && date < REDUCED_RATE_CHANGE_DATE ? "14" : "13.5";
  return [defaultVatRateForDate(date), reduced, "10", "0"];
}

/** A single VAT row that has not been typed by hand follows the total. */
export function syncAutoVat(rows: VatRow[], totalText: string): VatRow[] {
  if (rows.length !== 1 || rows[0].auto === false) return rows;
  const [row] = rows;
  const amount = autoVatAmount(totalText, row.rate) ?? "";
  return [{ ...row, amount, auto: true }];
}

/**
 * The form rows of a stored receipt. No saved VAT gives NO rows ("Ei
 * ALV-erittelyä"): opening a receipt never invents VAT (V8, R53, R57). A
 * single saved row that equals the VAT of the total keeps following it,
 * anything else was typed by hand and stays as it is.
 */
export function vatRowsFromSaved(
  saved: Array<{ rate: number; amount: number }> | null | undefined,
  totalText: string
): VatRow[] {
  if (!saved || saved.length === 0) return [];
  const rows = saved.map((line) => ({
    rate: String(line.rate),
    amount: moneyField(Number.isFinite(line.amount) ? line.amount : 0),
    auto: false,
  }));
  if (rows.length === 1) {
    const expected = autoVatAmount(totalText, rows[0].rate);
    const same =
      expected !== null &&
      parseReceiptAmount(expected) === parseReceiptAmount(rows[0].amount);
    if (same) rows[0].auto = true;
  }
  return rows;
}

/** The default row of a NEW receipt: the general rate of the date with the VAT of the total. */
export function defaultVatRows(totalText: string, date: string): VatRow[] {
  return syncAutoVat(
    [{ rate: defaultVatRateForDate(date), amount: "", auto: true, defaulted: true }],
    totalText
  );
}

/** Rows of a NEW receipt: what extraction read, else the prefilled default row. */
export function newReceiptVatRows(
  extracted: Array<{ rate: number; amount: number }> | null | undefined,
  totalText: string,
  date: string
): VatRow[] {
  const read = vatRowsFromSaved(extracted, totalText);
  return read.length > 0 ? read : defaultVatRows(totalText, date);
}

/** A single row whose rate nobody chose follows the date; every other row is left as it is. */
export function followDateRate(rows: VatRow[], date: string, totalText: string): VatRow[] {
  if (rows.length !== 1 || !rows[0].defaulted || rows[0].auto === false) return rows;
  const rate = defaultVatRateForDate(date);
  if (rate === rows[0].rate) return rows;
  return [{ rate, amount: autoVatAmount(totalText, rate) ?? "", auto: true, defaulted: true }];
}

/**
 * The user taps "Lisää ALV-rivi". From the empty state the row shows the
 * general rate with the VAT of the total; a further row starts blank and the
 * existing ones stop following the total.
 */
export function addVatRow(rows: VatRow[], totalText: string, date: string): VatRow[] {
  if (rows.length === 0) return defaultVatRows(totalText, date);
  return [
    ...rows.map((row) => ({ rate: row.rate, amount: row.amount, auto: false })),
    { rate: defaultVatRateForDate(date), amount: "", auto: false },
  ];
}

/** True when the rows differ from the baseline in rate or amount (the following flag does not count). */
export function vatRowsChanged(rows: VatRow[], baseline: VatRow[]): boolean {
  if (rows.length !== baseline.length) return true;
  return rows.some((row, index) => {
    const other = baseline[index];
    return (
      Number(row.rate) !== Number(other.rate) ||
      parseReceiptAmount(row.amount) !== parseReceiptAmount(other.amount)
    );
  });
}

export const VAT_AMOUNT_MISSING_MESSAGE = "Anna ALV-summa tai poista rivi.";
export const VAT_AMOUNT_INVALID_MESSAGE = "ALV-summa ei ole kelvollinen.";

/**
 * The VAT lines the form sends, or the first row that cannot be sent. An empty
 * list means "no VAT". A row whose amount is empty is never filled in at save:
 * what is stored is what the screen shows.
 */
export function vatPayload(
  rows: VatRow[],
  totalText: string
): { lines: Array<{ rate: number; amount: number }> } | { errorKey: string; message: string } {
  const lines: Array<{ rate: number; amount: number }> = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.amount.trim() === "") {
      return { errorKey: `vat-${index}`, message: VAT_AMOUNT_MISSING_MESSAGE };
    }
    const rate = Number(row.rate);
    const amount = parseReceiptAmount(row.amount);
    if (!Number.isFinite(rate) || amount === null || amount < 0) {
      return { errorKey: `vat-${index}`, message: VAT_AMOUNT_INVALID_MESSAGE };
    }
    lines.push({ rate, amount });
  }
  const total = parseReceiptAmount(totalText);
  const vatCents = lines.reduce((sum, line) => sum + eurosToCents(line.amount), 0);
  if (total !== null && vatCents > eurosToCents(total)) {
    return { errorKey: "vat-0", message: VAT_TOO_LARGE_MESSAGE };
  }
  return { lines };
}

/** Rounding and apportioned VAT differ by a few cents; more than this is worth a hint. */
const MISMATCH_TOLERANCE_EUR = 0.05;

/** A non-blocking hint when a hand-typed VAT does not fit the total and the rate. */
export function vatMismatchHint(rows: VatRow[], totalText: string): string | null {
  if (rows.length !== 1 || rows[0].auto !== false) return null;
  const typed = parseReceiptAmount(rows[0].amount);
  const expectedText = autoVatAmount(totalText, rows[0].rate);
  const expected = expectedText === null ? null : parseReceiptAmount(expectedText);
  if (typed === null || expected === null) return null;
  if (Math.abs(typed - expected) <= MISMATCH_TOLERANCE_EUR) return null;
  return `ALV ei vastaa summaa ja ALV-%:a, odotettu ${expectedText} €.`;
}

/** True when two lists of VAT lines are the same in rate and cents, in order. */
export function sameVatLines(
  a: Array<{ rate: number; amount: number }>,
  b: Array<{ rate: number; amount: number }>
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (line, index) =>
        line.rate === b[index].rate && eurosToCents(line.amount) === eurosToCents(b[index].amount)
    )
  );
}

export const VAT_TOO_LARGE_MESSAGE = "ALV-summa ei voi olla suurempi kuin kuitin summa.";

/**
 * What is wrong with the VAT lines of a receipt, or null. Shared by
 * POST /api/receipts/save and PATCH /api/receipts/[id] so an API client is held
 * to the same rule as the form: a known rate, and no more VAT than the total.
 */
export function vatLinesProblem(
  lines: Array<{ rate: number; amount: number }>,
  totalAmount: number | null | undefined,
  /** False when the lines were stored earlier and are not being changed: only the amounts are checked. */
  checkRates = true
): string | null {
  for (const line of checkRates ? lines : []) {
    if (!isSupportedVatRate(line.rate)) {
      return `ALV-kanta ${String(line.rate).replace(".", ",")} % ei ole tuettu. Valitse 25,5, 13,5, 10 tai 0 %.`;
    }
  }
  if (totalAmount == null) return null;
  const vatCents = lines.reduce((sum, line) => sum + eurosToCents(line.amount), 0);
  if (vatCents > eurosToCents(totalAmount)) return VAT_TOO_LARGE_MESSAGE;
  return null;
}
