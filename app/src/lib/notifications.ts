/**
 * GET /api/notifications: the reminders the iPhone app shows as local notifications.
 *
 * Every rule is the one a screen already uses, read cheaply (counts and short lists, no
 * matcher run): Koti's "Kuitti puuttuu" rows (lib/month-rows.ts), its late invoices and
 * their reminder wait (reminder-waits.ts), the VAT deadline (vat-deadline.ts), the month
 * close, the failures "Tuonnit ja virheet" still shows open, and Sähköposti's receipts
 * waiting for review. The phone polls this every hour or two in the background, so it
 * must stay far lighter than /api/dashboard.
 *
 * Event kinds (a new bank row, a new e-mail receipt) honour `since` by when they arrived;
 * state kinds (a late invoice, a VAT return due) always come, and the phone's list of
 * shown ids keeps each one to a single notification.
 */
import { prisma } from "./db";
import { centsToEuros } from "./money";
import { openPosition } from "./invoices";
import { receiptTitle } from "./display-titles";
import { nextReminderWait } from "./reminder-schedule";
import { pendingReminderAt } from "./reminder-waits";
import { getLockedThrough, isMonthLocked } from "./period-lock";
import { helsinkiCalendarDate, isoDateToUtc } from "./validation";
import { nextVatDue, vatPeriodKindOf } from "./vat-deadline";
import {
  NOTIFICATION_KINDS,
  PER_KIND_LIMIT,
  bankSyncFailedText,
  boundFeed,
  missingReceiptText,
  monthBefore,
  monthCloseDue,
  monthCloseText,
  overdueInvoiceText,
  receiptReviewText,
  vatDueDays,
  vatDueText,
  type AppNotification,
  type NotificationKind,
} from "./notification-rules";

export { MAX_NOTIFICATIONS } from "./notification-rules";

export interface NotificationFeed {
  items: AppNotification[];
  /** Pass back as `since` next time. */
  cursor: string;
  /** What is open now per kind, whatever `since` said: the phone's daily summary reads these. */
  counts: Record<NotificationKind, number>;
}

/** Late invoices read per call; more than this many is a different conversation. */
const OVERDUE_SCAN = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const CURSOR_OVERLAP_MS = 60 * 1000;

type Section = { items: AppNotification[]; count: number };
const EMPTY: Section = { items: [], count: 0 };

/**
 * Expense rows of the open months that have no receipt and no receipt suggestion: Koti's
 * "Kuitti puuttuu" (the complement of `isDocumentedRow`, as `openMonthRowsWhere`, for every
 * month not yet closed). An expense row never gets an invoice match or an income draft, so
 * the dashboard's extra filters change nothing here.
 */
async function missingReceipts(userId: string, lockedThrough: string | null, since: Date | null): Promise<Section> {
  const where = {
    statement: { userId, ...(lockedThrough ? { periodMonth: { gt: lockedThrough } } : {}) },
    type: "meno",
    receiptId: null,
    invoicePayment: null,
    purchasePayment: null,
    matchStatus: "unmatched",
  };
  const [count, rows] = await Promise.all([
    prisma.transaction.count({ where }),
    prisma.transaction.findMany({
      where: { ...where, ...(since ? { createdAt: { gt: since } } : {}) },
      orderBy: [{ createdAt: "desc" }, { date: "desc" }],
      take: PER_KIND_LIMIT.missing_receipt,
      select: {
        id: true,
        date: true,
        amountCents: true,
        counterparty: true,
        message: true,
        createdAt: true,
        statement: { select: { periodMonth: true } },
      },
    }),
  ]);
  const items = rows.map((row): AppNotification => {
    const date = row.date ? row.date.toISOString().slice(0, 10) : null;
    const month = row.statement.periodMonth ?? date?.slice(0, 7) ?? "";
    const query = [month ? `month=${month}` : "", "nayta=toimet", `rivi=${row.id}`].filter(Boolean).join("&");
    return {
      id: `missing-receipt:${row.id}`,
      kind: "missing_receipt",
      ...missingReceiptText(row.counterparty || row.message || "Pankkitapahtuma", centsToEuros(row.amountCents), date),
      href: `/pankki/tapahtumat?${query}`,
      createdAt: row.createdAt.toISOString(),
    };
  });
  return { items, count };
}

/**
 * Sent invoices past due with money still open, when a reminder may go now. The id carries
 * the number of reminders sent, so the owner hears of each invoice once per step: when it
 * falls late, and again each time a reminder's own term has run out.
 */
async function overdueInvoices(userId: string, today: Date, now: Date): Promise<Section> {
  const rows = await prisma.salesInvoice.findMany({
    where: { userId, documentKind: "invoice", status: "sent", dueDate: { lt: today } },
    orderBy: { dueDate: "asc" },
    take: OVERDUE_SCAN,
    select: {
      id: true,
      number: true,
      status: true,
      dueDate: true,
      grossCents: true,
      closedReason: true,
      customer: { select: { name: true } },
      payments: { select: { amountCents: true } },
      reminders: { where: { sentTo: { not: null } }, orderBy: { sentAt: "desc" }, select: { sentAt: true, dueDate: true } },
    },
  });
  const items: AppNotification[] = [];
  for (const invoice of rows) {
    const position = openPosition({
      status: invoice.status,
      grossCents: invoice.grossCents,
      paidCents: invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0),
      closedReason: invoice.closedReason,
    });
    if (!position.collectible || position.openCents <= 0) continue;
    const latest = invoice.reminders[0] ?? null;
    // The last reminder's term still runs: nothing for the owner to do yet.
    if (pendingReminderAt(latest, now)) continue;
    const step = invoice.reminders.length;
    const since = latest ? nextReminderWait(latest).at : new Date(invoice.dueDate.getTime() + DAY_MS);
    items.push({
      id: `overdue-invoice:${invoice.id}:${step}`,
      kind: "overdue_invoice",
      ...overdueInvoiceText({
        number: invoice.number,
        party: invoice.customer.name,
        openEur: centsToEuros(position.openCents),
        daysLate: Math.round((today.getTime() - invoice.dueDate.getTime()) / DAY_MS),
        step,
      }),
      href: `/laskut/lasku?id=${invoice.id}`,
      createdAt: since.toISOString(),
    });
  }
  return { items, count: items.length };
}

/** The VAT return due within three days, while the owner has not marked it filed. */
async function vatDue(userId: string, todayIso: string): Promise<Section> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { vatRegistered: true, vatPeriod: true } });
  if (!user?.vatRegistered) return EMPTY;
  const due = nextVatDue(isoDateToUtc(todayIso), vatPeriodKindOf(user.vatPeriod));
  const daysLeft = vatDueDays(due.dueIso, todayIso);
  if (daysLeft === null) return EMPTY;
  const filing = await prisma.vatFiling.findUnique({
    where: { userId_period: { userId, period: due.key } },
    select: { filedAt: true },
  });
  if (filing?.filedAt) return EMPTY;
  const item: AppNotification = {
    id: `vat-due:${due.key}`,
    kind: "vat_due",
    ...vatDueText(due.label, due.dueIso, due.period.year, daysLeft),
    href: `/kirjanpito/alv?period=${due.queryKey}`,
    createdAt: new Date(Date.parse(`${due.dueIso}T00:00:00.000Z`) - 3 * DAY_MS).toISOString(),
  };
  return { items: [item], count: 1 };
}

/** Last month still open after the 5th, when it has anything in it (the dashboard's test). */
async function monthClose(userId: string, todayIso: string, lockedThrough: string | null): Promise<Section> {
  const previous = monthBefore(todayIso);
  if (Number(todayIso.slice(8, 10)) <= 5 || isMonthLocked(lockedThrough, previous)) return EMPTY;
  const bounds = { gte: new Date(`${previous}-01T00:00:00.000Z`), lt: new Date(`${todayIso.slice(0, 7)}-01T00:00:00.000Z`) };
  const [receipts, statements, invoices] = await Promise.all([
    prisma.receipt.count({ where: { userId, date: bounds }, take: 1 }),
    prisma.statement.count({ where: { userId, periodMonth: previous }, take: 1 }),
    prisma.salesInvoice.count({ where: { userId, issueDate: bounds }, take: 1 }),
  ]);
  const month = monthCloseDue(todayIso, { locked: false, hasContent: receipts + statements + invoices > 0 });
  if (!month) return EMPTY;
  const item: AppNotification = {
    id: `month-close:${month}`,
    kind: "month_close",
    ...monthCloseText(month),
    href: `/kirjanpito/kuukausi?month=${month}`,
    createdAt: new Date(`${todayIso.slice(0, 7)}-06T00:00:00.000Z`).toISOString(),
  };
  return { items: [item], count: 1 };
}

/**
 * Bank fetches that failed and are still open, the rule of "Tuonnit ja virheet"
 * (JobsQueue.openFailures in the app): the newest run of a connection failed, the owner has
 * not dismissed it, and the connection is still there, not revoked and not fetched since.
 * One notification per failure streak: the id names the last success, so a sync failing
 * every hour stays one notification, and a new one comes only after the bank worked again.
 */
async function bankSyncFailures(userId: string): Promise<Section> {
  const [jobs, connections] = await Promise.all([
    prisma.backgroundJob.findMany({
      where: { userId, kind: "bank_sync", status: { in: ["failed", "done", "dismissed"] } },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { status: true, resourceId: true, error: true, createdAt: true },
    }),
    prisma.bankConnection.findMany({
      where: { userId },
      select: { id: true, aspspName: true, status: true, lastSuccessAt: true },
    }),
  ]);
  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  const decided = new Set<string>();
  const items: AppNotification[] = [];
  for (const job of jobs) {
    if (!job.resourceId || decided.has(job.resourceId)) continue;
    decided.add(job.resourceId);
    if (job.status !== "failed") continue;
    const connection = byId.get(job.resourceId);
    if (!connection || connection.status === "revoked") continue;
    if (connection.lastSuccessAt && connection.lastSuccessAt > job.createdAt) continue;
    items.push({
      id: `bank-sync-failed:${connection.id}:${connection.lastSuccessAt?.toISOString() ?? "never"}`,
      kind: "bank_sync_failed",
      ...bankSyncFailedText(connection.aspspName, job.error),
      href: "/tyot",
      createdAt: job.createdAt.toISOString(),
    });
  }
  return { items, count: items.length };
}

/** Receipts mail sync brought in that wait for the owner's check. */
async function receiptsToReview(userId: string, since: Date | null): Promise<Section> {
  const where = { userId, source: "email_sync", reviewStatus: "pending" };
  const [count, rows] = await Promise.all([
    prisma.receipt.count({ where }),
    prisma.receipt.findMany({
      where: { ...where, ...(since ? { createdAt: { gt: since } } : {}) },
      orderBy: { createdAt: "desc" },
      take: PER_KIND_LIMIT.receipt_review,
      select: { id: true, vendor: true, date: true, createdAt: true, totalAmountCents: true },
    }),
  ]);
  const items = rows.map((receipt): AppNotification => ({
    id: `receipt-review:${receipt.id}`,
    kind: "receipt_review",
    ...receiptReviewText(
      receiptTitle(receipt),
      receipt.totalAmountCents == null ? null : centsToEuros(receipt.totalAmountCents)
    ),
    href: `/kuitit/kuitti?id=${receipt.id}`,
    createdAt: receipt.createdAt.toISOString(),
  }));
  return { items, count };
}

export async function buildNotificationFeed(
  userId: string,
  options: { since?: Date | null; now?: Date } = {}
): Promise<NotificationFeed> {
  const now = options.now ?? new Date();
  const since = options.since ?? null;
  const todayIso = helsinkiCalendarDate(now);
  const today = isoDateToUtc(todayIso);
  const lockedThrough = await getLockedThrough(userId);

  // One part failing (a slow query, a bad row) must not silence the others.
  const settle = (work: Promise<Section>) => work.catch((error: unknown) => {
    console.error("notifications: section failed", error);
    return EMPTY;
  });
  const [missing, overdue, vat, close, bank, review] = await Promise.all([
    settle(missingReceipts(userId, lockedThrough, since)),
    settle(overdueInvoices(userId, today, now)),
    settle(vatDue(userId, todayIso)),
    settle(monthClose(userId, todayIso, lockedThrough)),
    settle(bankSyncFailures(userId)),
    settle(receiptsToReview(userId, since)),
  ]);
  const sections: Record<NotificationKind, Section> = {
    missing_receipt: missing,
    overdue_invoice: overdue,
    vat_due: vat,
    month_close: close,
    bank_sync_failed: bank,
    receipt_review: review,
  };
  return {
    items: boundFeed(Object.fromEntries(NOTIFICATION_KINDS.map((kind) => [kind, sections[kind].items]))),
    // A minute of overlap: a row written while this ran is not skipped next time; the phone's
    // record of shown ids drops the repeat.
    cursor: new Date(now.getTime() - CURSOR_OVERLAP_MS).toISOString(),
    counts: Object.fromEntries(NOTIFICATION_KINDS.map((kind) => [kind, sections[kind].count])) as Record<
      NotificationKind,
      number
    >,
  };
}
