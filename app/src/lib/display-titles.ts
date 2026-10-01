/**
 * What a row is called on screen. A file name is a storage detail, never a
 * title: an unnamed receipt reads "Kuitti 28.9.", a statement reads
 * "Tiliote · elokuu 2026" (findings-vs 2.10, F28). Pure, safe on the client.
 */
import { formatMonth } from "./format";

const FILE_EXTENSION = /\.(jpe?g|png|pdf|csv|heic|heif|webp|gif|tiff?|txt|xlsx?|camt|xml)$/i;
const CAPTURE_NAME = /^(kuitti|receipt|img|image|photo|scan)[-_ ]?\d{6,}/i;

/** A name that is really a file name (or a camera or upload name). */
export function looksLikeFileName(value: string | null | undefined): boolean {
  const text = (value ?? "").trim();
  return text !== "" && (FILE_EXTENSION.test(text) || CAPTURE_NAME.test(text));
}

type DateInput = Date | string | null | undefined;

function toDate(value: DateInput): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "28.9." from a date, read in Helsinki time so a late evening upload keeps its day. */
export function shortDay(value: DateInput): string | null {
  const date = toDate(value);
  if (!date) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Helsinki",
    day: "numeric",
    month: "numeric",
  }).formatToParts(date);
  const day = parts.find((part) => part.type === "day")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return day && month ? `${day}.${month}.` : null;
}

/**
 * The vendor, else "Kuitti 28.9." from the receipt date (or the day it was
 * added), else plain "Kuitti". A file name is never used.
 */
export function receiptTitle(receipt: {
  vendor?: string | null;
  date?: DateInput;
  createdAt?: DateInput;
}): string {
  const vendor = receipt.vendor?.trim();
  if (vendor && !looksLikeFileName(vendor)) return vendor;
  const day = shortDay(receipt.date) ?? shortDay(receipt.createdAt);
  return day ? `Kuitti ${day}` : "Kuitti";
}

/** The old stored job titles were "Kuitin analysointi: <file name>". */
const STORED_ANALYSIS_TITLE = /^Kuitin analysointi(?::.*)?$/i;

/** A background job's title, built from what it is and when it started, never from a file. */
export function jobTitle(job: { kind: string; title?: string | null; createdAt?: DateInput }): string {
  if (job.kind === "document_analysis") {
    const day = shortDay(job.createdAt);
    return day ? `Kuitti ${day}` : "Kuitti";
  }
  if (job.kind === "bank_sync") return "Pankkitapahtumien haku";
  if (job.kind === "email_scan") return "Sähköpostin tarkistus";
  const title = job.title?.trim() ?? "";
  if (!title || looksLikeFileName(title) || STORED_ANALYSIS_TITLE.test(title)) return "Työ";
  return title;
}

/** A tiliote is named by its month, not by the file it came from. */
export function statementTitle(statement: { fileType?: string | null; periodMonth?: string | null }): string {
  const month = statement.periodMonth ? formatMonth(statement.periodMonth) : "";
  const label = statement.fileType === "enablebanking" ? "Pankkiyhteys" : "Tiliote";
  return month ? `${label} · ${month}` : label;
}
