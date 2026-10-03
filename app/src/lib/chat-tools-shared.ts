/**
 * Helpers shared by the assistant's tools (chat-tools*.ts): exact money text,
 * page cursors, period parsing and the loose name match. Nothing here reads
 * the database.
 */
import { normalizeSearch } from "./search";
import { helsinkiMonthKey } from "./validation";

/** A bad argument from the model: the message goes back to it as the tool result. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/** Exact euros from integer cents: 123456 -> "1234.56", -5 -> "-0.05". No float on the way. */
export function eur(cents: number): string {
  const whole = Math.round(cents);
  const sign = whole < 0 ? "-" : "";
  const abs = Math.abs(whole);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Euros a library already rounded to the cent (12.3 -> "12.30"). */
export function eurOf(euros: number): string {
  return eur(Math.round(euros * 100));
}

export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 25;

/** An opaque page cursor. It carries only an offset: the query is owner-scoped again on every page. */
export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown };
    if (typeof parsed.o === "number" && Number.isInteger(parsed.o) && parsed.o >= 0 && parsed.o < 100_000) return parsed.o;
  } catch {
    // fall through
  }
  throw new ToolInputError("Invalid cursor: pass back nextCursor exactly as it was returned.");
}

export function pageOf<T>(rows: T[], cursor: string | null | undefined, limit: number | undefined) {
  const offset = decodeCursor(cursor);
  const size = Math.min(Math.max(1, Math.floor(limit ?? DEFAULT_PAGE_SIZE)), MAX_PAGE_SIZE);
  const items = rows.slice(offset, offset + size);
  const next = offset + size < rows.length ? encodeCursor(offset + size) : null;
  return { items, nextCursor: next, offset };
}

export interface ResolvedPeriod {
  /** "2026-09", "2026-Q3", "2026" or "2026-07..2026-09". */
  key: string;
  fromMonth: string;
  toMonth: string;
  months: number;
  start: Date;
  /** Exclusive. */
  end: Date;
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MAX_RANGE_MONTHS = 36;

function monthIndex(month: string): number {
  const [year, m] = month.split("-").map(Number);
  return year * 12 + (m - 1);
}

export function monthFromIndex(index: number): string {
  const year = Math.floor(index / 12);
  return `${year}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function rangeOf(fromMonth: string, toMonth: string, key: string): ResolvedPeriod {
  const from = monthIndex(fromMonth);
  const to = monthIndex(toMonth);
  if (to < from) throw new ToolInputError("Period 'from' is after 'to'.");
  if (to - from + 1 > MAX_RANGE_MONTHS) throw new ToolInputError(`A period may span at most ${MAX_RANGE_MONTHS} months.`);
  const start = new Date(Date.UTC(Math.floor(from / 12), from % 12, 1));
  const end = new Date(Date.UTC(Math.floor((to + 1) / 12), (to + 1) % 12, 1));
  return { key, fromMonth, toMonth, months: to - from + 1, start, end };
}

/**
 * `period` ("2026-09", "2026-Q3", "2026") or an inclusive month range
 * (`from`/`to`, "YYYY-MM"). Nothing given: null, or the current month when
 * `fallbackToCurrent` is set.
 */
export function resolvePeriod(
  input: { period?: string | null; from?: string | null; to?: string | null },
  now: Date = new Date(),
  fallbackToCurrent = false
): ResolvedPeriod | null {
  const period = input.period?.trim();
  if (period) {
    const quarter = /^(\d{4})-Q([1-4])$/i.exec(period);
    if (quarter) {
      const year = quarter[1];
      const q = Number(quarter[2]);
      const first = `${year}-${String((q - 1) * 3 + 1).padStart(2, "0")}`;
      const last = `${year}-${String(q * 3).padStart(2, "0")}`;
      return rangeOf(first, last, `${year}-Q${q}`);
    }
    if (/^\d{4}$/.test(period)) return rangeOf(`${period}-01`, `${period}-12`, period);
    if (MONTH.test(period)) return rangeOf(period, period, period);
    throw new ToolInputError("Invalid period: use YYYY-MM, YYYY-Qn or YYYY, or from/to as YYYY-MM.");
  }
  const from = input.from?.trim();
  const to = input.to?.trim();
  if (from || to) {
    const first = from || to!;
    const last = to || helsinkiMonthKey(now);
    if (!MONTH.test(first) || !MONTH.test(last)) throw new ToolInputError("from/to must be YYYY-MM.");
    return rangeOf(first, last, first === last ? first : `${first}..${last}`);
  }
  if (!fallbackToCurrent) return null;
  const current = helsinkiMonthKey(now);
  return rangeOf(current, current, current);
}

/** The `count` periods of the same length right before `period`, newest first. */
export function previousPeriods(period: ResolvedPeriod, count: number): ResolvedPeriod[] {
  const out: ResolvedPeriod[] = [];
  let end = monthIndex(period.fromMonth) - 1;
  for (let i = 0; i < count; i += 1) {
    const start = end - period.months + 1;
    const fromMonth = monthFromIndex(start);
    const toMonth = monthFromIndex(end);
    out.push(rangeOf(fromMonth, toMonth, fromMonth === toMonth ? fromMonth : `${fromMonth}..${toMonth}`));
    end = start - 1;
  }
  return out;
}

export function isoDay(date: Date | null | undefined): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

/** Folded for a loose match: case, Turkish i, and accents ("Hämeen" ~ "hameen"). */
export function looseText(value: string | null | undefined): string {
  return normalizeSearch(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[b.length];
}

function tokenMatches(query: string, word: string): boolean {
  if (word.startsWith(query)) return true;
  // An inflected name in the question ("Virtaselle") still finds "Virtanen".
  if (word.length >= 4 && query.startsWith(word)) return true;
  // Finnish -nen names inflect on an -s- stem: Virtanen -> Virtasen, Virtaselle, Mäkistä.
  if (word.length >= 6 && word.endsWith("nen") && query.startsWith(`${word.slice(0, -3)}s`)) return true;
  const allowed = query.length >= 7 ? 2 : query.length >= 4 ? 1 : 0;
  if (allowed === 0) return false;
  return editDistance(query, word, allowed) <= allowed;
}

/**
 * A name as a person types it: any case or accents, a part of it, an
 * inflected form, or one or two letters off. Every word of the query must
 * match some word of the text.
 */
export function fuzzyMatch(query: string | null | undefined, ...texts: Array<string | null | undefined>): boolean {
  const q = looseText(query);
  if (!q) return true;
  const words = texts.flatMap((text) => looseText(text).split(" ")).filter(Boolean);
  if (texts.some((text) => looseText(text).includes(q))) return true;
  return q.split(" ").every((token) => words.some((word) => tokenMatches(token, word)));
}

/** True when the query names the text exactly (after folding): an exact match wins over fuzzy ones. */
export function exactName(query: string, text: string): boolean {
  return looseText(query) === looseText(text);
}
