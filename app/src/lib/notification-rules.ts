/**
 * What the iPhone app may notify about, and the words it uses (GET /api/notifications).
 *
 * The app is installed without a paid developer account, so there is no remote push:
 * the phone asks this feed when it opens and when iOS lets it refresh in the background,
 * and shows each id once. Pure on purpose, so the limits and the copy are tested
 * without a database (lib/notifications.ts reads the rows).
 */
import { MONTHS } from "./finnish-months";
import { formatDayMonth, formatEur } from "./format";
import { vatDueDate } from "./vat-due";

export const NOTIFICATION_KINDS = [
  "bank_sync_failed",
  "vat_due",
  "month_close",
  "overdue_invoice",
  "missing_receipt",
  "receipt_review",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface AppNotification {
  /** Stable: the phone shows each id once ("missing-receipt:<transactionId>"). */
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  /** An in-app path the app's link reader understands (AppLink.swift). */
  href: string;
  createdAt: string;
}

/** One answer never carries more than this; the phone sums up the rest. */
export const MAX_NOTIFICATIONS = 20;

/** Per kind, so thirty bank rows cannot crowd out a VAT return that is due. */
export const PER_KIND_LIMIT: Record<NotificationKind, number> = {
  bank_sync_failed: 3,
  vat_due: 1,
  month_close: 1,
  overdue_invoice: 5,
  missing_receipt: 10,
  receipt_review: 5,
};

/** The feed in NOTIFICATION_KINDS order (the urgent first), each kind capped, MAX_NOTIFICATIONS in all. */
export function boundFeed(groups: Partial<Record<NotificationKind, AppNotification[]>>): AppNotification[] {
  return NOTIFICATION_KINDS.flatMap((kind) => (groups[kind] ?? []).slice(0, PER_KIND_LIMIT[kind])).slice(
    0,
    MAX_NOTIFICATIONS
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A sentence that ends in a date like "12.10." already has its full stop. */
function endSentence(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

/** Days from today to the due date (both YYYY-MM-DD), or null outside the three-day window. */
export function vatDueDays(dueIso: string, todayIso: string): number | null {
  const days = Math.round((Date.parse(`${dueIso}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / DAY_MS);
  return days >= 0 && days <= 3 ? days : null;
}

export function vatDueText(label: string, dueIso: string, periodYear: number, daysLeft: number) {
  const when = daysLeft === 0 ? "tänään." : daysLeft === 1 ? "huomenna." : `viimeistään ${vatDueDate(dueIso, periodYear)}`;
  return { title: "ALV-ilmoitus on tekemättä", body: endSentence(`${label}: ilmoita OmaVerossa ${when}`) };
}

function previousMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The month to remind about closing, or null: after the 5th day, last month when it is still
 * open and has anything in it (a month with nothing in it has nothing to close).
 */
export function monthCloseDue(todayIso: string, previous: { locked: boolean; hasContent: boolean }): string | null {
  if (Number(todayIso.slice(8, 10)) <= 5) return null;
  if (previous.locked || !previous.hasContent) return null;
  return previousMonth(todayIso.slice(0, 7));
}

/** The previous month of the given day's month, for the queries that decide `monthCloseDue`. */
export function monthBefore(todayIso: string): string {
  return previousMonth(todayIso.slice(0, 7));
}

export function monthCloseText(month: string) {
  const name = MONTHS[Number(month.slice(5, 7)) - 1] ?? month;
  return { title: `${name} on sulkematta`, body: "Tarkista kuukauden kirjaukset ja sulje kuukausi." };
}

export function missingReceiptText(party: string, amountEur: number, dateIso: string | null) {
  const day = dateIso ? `, ${formatDayMonth(dateIso)}` : "";
  return { title: "Kuitti puuttuu", body: `${endSentence(`${party} ${formatEur(Math.abs(amountEur))}${day}`)} Kuvaa kuitti.` };
}

export function overdueInvoiceText(input: { number: number; party: string; openEur: number; daysLate: number; step: number }) {
  const late = `${input.daysLate} ${input.daysLate === 1 ? "päivä" : "päivää"} myöhässä`;
  return {
    title: input.step === 0 ? "Lasku on myöhässä" : "Muistutuksen maksuaika on päättynyt",
    body: `Lasku ${input.number}, ${input.party}, ${formatEur(input.openEur)}: ${late}. Lähetä muistutus.`,
  };
}

const ERROR_MAX = 140;

export function bankSyncFailedText(bankName: string, error: string | null) {
  const reason = (error?.trim() || "Tapahtumien haku pankista epäonnistui.").slice(0, ERROR_MAX);
  return { title: "Pankkitapahtumien haku epäonnistui", body: `${bankName}: ${reason}` };
}

export function receiptReviewText(title: string, amountEur: number | null) {
  const amount = amountEur == null ? "" : ` ${formatEur(amountEur)}`;
  return { title: "Uusi kuitti sähköpostista", body: `${title}${amount} odottaa tarkistusta.` };
}
