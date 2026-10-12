import { prisma } from "./db";
import { foreignColumns } from "./foreign-purchase-input";
import { isUsableRate } from "./foreign-purchase";

/**
 * ECB reference rates (through api.frankfurter.app, free and keyless) for a
 * foreign document whose euro total is not printed. The rate used is stored in
 * FxRate and in the upload's reading, because a Finnish bookkeeper must be able
 * to show which rate priced a receipt. Nothing here may break a save: every
 * failure (offline, timeout, unknown currency, missing table) is a null.
 */

const FX_URL = "https://api.frankfurter.app";
const FX_TIMEOUT_MS = 5000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type FxSource = "ECB" | "document";

export interface EurRate {
  /** Euros for one unit of the document currency (1 USD = 0.9123 EUR). */
  rate: number;
  /** The business day the rate is from: earlier than the asked day on a weekend or holiday. */
  rateDate: string;
}

/** A euro figure computed from a foreign total, with the rate behind it. */
export interface EuroConversion {
  totalAmount: number;
  fxRate: number;
  fxRateDate: string | null;
  fxSource: FxSource;
}

export type FxFetcher = (url: string, init: { signal: AbortSignal }) => Promise<Pick<Response, "ok" | "status" | "json">>;

export interface FxStore {
  get(currency: string, date: string): Promise<EurRate | null>;
  put(currency: string, date: string, value: EurRate): Promise<void>;
}

let fetcher: FxFetcher | null = null;
let store: FxStore | null = null;

/** Tests replace the network so a run never reaches the ECB. */
export function setFxFetcherForTests(fn: FxFetcher | null): void {
  fetcher = fn;
}

/** Tests that do not want the database swap the cache for a plain map. */
export function setFxStoreForTests(next: FxStore | null): void {
  store = next;
}

export function isFxEnabled(): boolean {
  const flag = (process.env.FX_RATES_ENABLED ?? "").trim().toLowerCase();
  return flag !== "false" && flag !== "0" && flag !== "off";
}

/** Raw SQL on purpose: the table is new and the generated client may predate it. */
const dbStore: FxStore = {
  async get(currency, date) {
    const rows = await prisma.$queryRaw<Array<{ rate: number; rateDate: string }>>`
      SELECT "rate", "rateDate" FROM "FxRate" WHERE "currency" = ${currency} AND "date" = ${date} LIMIT 1`;
    const row = rows[0];
    return row && Number.isFinite(Number(row.rate)) ? { rate: Number(row.rate), rateDate: row.rateDate } : null;
  },
  async put(currency, date, value) {
    await prisma.$executeRaw`
      INSERT OR REPLACE INTO "FxRate" ("currency", "date", "rate", "rateDate", "source")
      VALUES (${currency}, ${date}, ${value.rate}, ${value.rateDate}, 'ECB')`;
  },
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The ECB rate for `currency` on `date` (YYYY-MM-DD; today when missing, and a
 * future day is clamped to today). null when the lookup is off, the currency is
 * euro or unknown to the ECB, or the network failed: the caller then leaves the
 * euro figure to the owner. Never throws.
 */
export async function getEurRate(currency: string | null | undefined, date?: string | null): Promise<EurRate | null> {
  const code = currency?.trim().toUpperCase() ?? "";
  if (!/^[A-Z]{3}$/.test(code) || code === "EUR") return null;
  if (!isFxEnabled()) return null;
  // Without an injected fetcher a test run is held off the network entirely.
  if (!fetcher && process.env.VITEST) return null;

  const today = todayIso();
  const day = date && ISO_DATE.test(date) && date <= today ? date : today;
  const cache = store ?? dbStore;

  try {
    const cached = await cache.get(code, day);
    if (cached) return cached;
  } catch (error) {
    console.warn("FX cache read failed:", error);
  }

  let fetched: EurRate | null = null;
  try {
    const doFetch: FxFetcher = fetcher ?? ((url, init) => fetch(url, init));
    const response = await doFetch(`${FX_URL}/${day}?from=${code}&to=EUR`, { signal: AbortSignal.timeout(FX_TIMEOUT_MS) });
    if (!response.ok) return null;
    const body = (await response.json()) as { date?: unknown; rates?: Record<string, unknown> };
    const rate = Number(body.rates?.EUR);
    if (!Number.isFinite(rate) || rate <= 0 || typeof body.date !== "string" || !ISO_DATE.test(body.date)) return null;
    fetched = { rate, rateDate: body.date };
  } catch (error) {
    console.warn(`FX lookup for ${code} failed:`, error instanceof Error ? error.message : error);
    return null;
  }

  try {
    await cache.put(code, day, fetched);
  } catch (error) {
    // A rate that cannot be cached is still a good rate for this save.
    console.warn("FX cache write failed:", error);
  }
  return fetched;
}

/** Whole cents, rounded once: the euro total of a foreign amount at a rate. */
export function convertToEuros(original: number, rate: number): number {
  return Math.round(original * rate * 100) / 100;
}

/**
 * Prices a foreign total in euros. A rate the document printed wins over the
 * ECB's; with neither the answer is null and the owner types the euro figure.
 */
export async function euroConversion(input: {
  currency: string | null | undefined;
  /** The total printed in `currency`, as a decimal (50.10), not cents. */
  originalAmount: number | null | undefined;
  /** The day to price at: the document's date. */
  date: string | null | undefined;
  /** The rate the document itself printed, EUR per 1 unit of `currency`. */
  printedRate?: number | null;
}): Promise<EuroConversion | null> {
  const code = input.currency?.trim().toUpperCase() ?? "";
  if (!/^[A-Z]{3}$/.test(code) || code === "EUR") return null;
  if (input.originalAmount == null || !Number.isFinite(input.originalAmount) || input.originalAmount <= 0) return null;

  if (isUsableRate(input.printedRate)) {
    return {
      totalAmount: convertToEuros(input.originalAmount, input.printedRate),
      fxRate: input.printedRate,
      fxRateDate: input.date && ISO_DATE.test(input.date) ? input.date : null,
      fxSource: "document",
    };
  }
  const found = await getEurRate(code, input.date);
  if (!found) return null;
  return {
    totalAmount: convertToEuros(input.originalAmount, found.rate),
    fxRate: found.rate,
    fxRateDate: found.rateDate,
    fxSource: "ECB",
  };
}

/**
 * The euro figure for a receipt saved without one, from the owner's currency
 * fields and the stored reading. A rate the extraction job already recorded is
 * reused, so the rate on the receipt is the one the owner was shown.
 */
export async function euroConversionForSave(
  body: Parameters<typeof foreignColumns>[0] & { date?: string | null },
  extractedJson: string | null
): Promise<EuroConversion | null> {
  const columns = foreignColumns(body, extractedJson);
  if (columns.currency === "EUR" || columns.originalAmountCents == null) return null;
  let read: { date?: string | null; fxRate?: number | null; fxRateDate?: string | null; fxSource?: FxSource | null } = {};
  try {
    read = extractedJson ? (JSON.parse(extractedJson) as typeof read) : {};
  } catch {
    // An unreadable stored reading only loses the recorded rate; a fresh lookup still works.
    read = {};
  }
  const original = columns.originalAmountCents / 100;
  if (isUsableRate(read.fxRate)) {
    return {
      totalAmount: convertToEuros(original, read.fxRate),
      fxRate: read.fxRate,
      fxRateDate: read.fxRateDate ?? null,
      fxSource: read.fxSource === "document" ? "document" : "ECB",
    };
  }
  return euroConversion({ currency: columns.currency, originalAmount: original, date: body.date ?? read.date ?? null });
}

/** Merges the rate into a stored reading so the receipt's upload shows which rate priced it. */
export function withFxRecorded(extractedJson: string | null, fx: EuroConversion): string | null {
  if (!extractedJson) return null;
  try {
    const read = JSON.parse(extractedJson) as Record<string, unknown>;
    return JSON.stringify({ ...read, fxRate: fx.fxRate, fxRateDate: fx.fxRateDate, fxSource: fx.fxSource });
  } catch {
    // Nothing to merge into; the FxRate table still holds the rate.
    return null;
  }
}

/**
 * The rate behind a saved receipt's euro figure, read from its upload's stored
 * reading, so the receipt screen can show it after an auto-save skipped the
 * editor. Nulls when nothing usable was recorded.
 */
export function storedFxRate(extractedJson: string | null | undefined): {
  fxRate: number | null;
  fxRateDate: string | null;
  fxSource: FxSource | null;
} {
  const none = { fxRate: null, fxRateDate: null, fxSource: null };
  if (!extractedJson) return none;
  try {
    const read = JSON.parse(extractedJson) as { fxRate?: unknown; fxRateDate?: unknown; fxSource?: unknown };
    if (!isUsableRate(read.fxRate)) return none;
    return {
      fxRate: read.fxRate,
      fxRateDate: typeof read.fxRateDate === "string" ? read.fxRateDate : null,
      fxSource: read.fxSource === "document" ? "document" : "ECB",
    };
  } catch {
    // An unreadable stored reading only hides the rate line.
    return none;
  }
}
