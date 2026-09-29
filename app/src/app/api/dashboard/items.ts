/**
 * "Tarvitaan sinulta" on Koti: concrete items, one per thing the owner must do,
 * each naming the other party and carrying what its one-tap action needs
 * (approved mockup 01-koti.png).
 *
 * Month scope: the current month shows everything that is open now (an
 * overdue invoice from spring is still due today). A past month shows only
 * items tied to that month, so its headline never counts today's work.
 *
 * FP-2: every item says whether it blocks closing the month. Only blocking
 * items count in "N asiaa ennen kuun loppua"; an overdue sales invoice is
 * money to chase, not bookkeeping left undone (spec §5.1). Every bank row
 * of the month that is not documented (lib/month-rows.ts) has exactly one
 * item, so the progress bar's gap is always covered by rows.
 */
import { prisma } from "@/lib/db";
import { centsToEuros } from "@/lib/money";
import { openPosition } from "@/lib/invoices";
import { parseVatDetails } from "@/lib/alv";
import { findPaymentReceiptDuplicates } from "@/lib/alv-period";
import { matchInvoicePaymentsFromBank } from "@/lib/sales-invoices";
import { helsinkiCalendarDate, isoDateToUtc } from "@/lib/validation";
import { openMonthRowsWhere } from "@/lib/month-rows";
import { approvalGaps, type ApprovalGap } from "@/lib/receipt-approval";

/** Rows shown per kind; the rest sit behind "Näytä kaikki". */
export const ITEMS_PER_KIND = 3;

export type DashboardItem =
  | {
      id: string;
      kind: "overdue_invoice";
      action: "remind";
      invoiceId: string;
      customerId: string;
      number: number;
      party: string;
      amount: number;
      dueDate: string;
      daysLate: number;
    }
  | {
      id: string;
      kind: "pending_receipt";
      action: "approve";
      receiptId: string;
      party: string;
      amount: number | null;
      type: string;
      date: string | null;
      category: string | null;
      vatRate: number | null;
      /** FP-6: what is missing before a one-tap approve; empty = "Hyväksy". */
      gaps: ApprovalGap[];
    }
  | {
      id: string;
      kind: "invoice_match";
      action: "confirm_match";
      invoiceId: string;
      number: number;
      transactionId: string;
      party: string;
      amount: number;
      paidDate: string;
    }
  | {
      id: string;
      kind: "missing_receipt";
      action: "add_photo";
      transactionId: string;
      party: string;
      amount: number;
      date: string | null;
    }
  | {
      id: string;
      kind: "receipt_match";
      action: "review_match";
      transactionId: string;
      party: string;
      amount: number;
      date: string | null;
    }
  | {
      id: string;
      kind: "payment_duplicate";
      action: "open_invoice";
      invoiceId: string;
      number: number;
      party: string;
      amount: number;
      paidDate: string;
    }
  | {
      id: string;
      kind: "draft_invoice";
      action: "open_invoice";
      invoiceId: string;
      number: number;
      party: string;
      amount: number;
      issueDate: string;
    };

export type DashboardItemKind = DashboardItem["kind"];

/** Kinds that do not stop the month from being closed (FP-2, spec §5.1). */
export const NON_BLOCKING_KINDS: ReadonlySet<DashboardItemKind> = new Set(["overdue_invoice"]);

export function isBlockingKind(kind: DashboardItemKind): boolean {
  return !NON_BLOCKING_KINDS.has(kind);
}

export interface DashboardItems {
  items: DashboardItem[];
  /** How many of each kind exist in scope, shown or not. */
  totals: Record<DashboardItemKind, number>;
  /** Σ totals of the blocking kinds: the "ennen kuun loppua" headline. */
  blockingTotal: number;
}

/** Work shared by the current month and the previous month's summary. */
export interface SharedMatchData {
  matchRun: Awaited<ReturnType<typeof matchInvoicePaymentsFromBank>>;
  duplicates: Awaited<ReturnType<typeof findPaymentReceiptDuplicates>>;
}

export async function loadSharedMatchData(userId: string, now: Date = new Date()): Promise<SharedMatchData> {
  const [matchRun, duplicates] = await Promise.all([
    matchInvoicePaymentsFromBank(userId, now, { dryRun: true }),
    findPaymentReceiptDuplicates(userId),
  ]);
  return { matchRun, duplicates };
}

const iso = (date: Date | null | undefined) => (date ? date.toISOString().slice(0, 10) : null);

function inMonth(value: string | null, month: string): boolean {
  return value !== null && value.startsWith(month);
}

export async function buildDashboardItems(
  userId: string,
  month: string,
  isCurrent: boolean,
  now: Date = new Date(),
  shared?: SharedMatchData,
  perKind: number = ITEMS_PER_KIND
): Promise<DashboardItems> {
  const today = isoDateToUtc(helsinkiCalendarDate(now));
  const [year, monthNum] = month.split("-").map(Number);
  const monthStart = new Date(Date.UTC(year, monthNum - 1, 1));
  const monthEnd = new Date(Date.UTC(year, monthNum, 1));

  const [overdueRows, pendingRows, { matchRun, duplicates }, monthRows, draftRows] = await Promise.all([
    prisma.salesInvoice.findMany({
      where: {
        userId,
        documentKind: "invoice",
        status: "sent",
        dueDate: { lt: today },
        ...(isCurrent ? {} : { issueDate: { gte: monthStart, lt: monthEnd } }),
      },
      select: {
        id: true,
        number: true,
        status: true,
        dueDate: true,
        grossCents: true,
        closedReason: true,
        customerId: true,
        customer: { select: { name: true } },
        payments: { select: { amountCents: true } },
      },
      orderBy: { dueDate: "asc" },
    }),
    prisma.receipt.findMany({
      where: {
        userId,
        reviewStatus: "pending",
        ...(isCurrent ? {} : { date: { gte: monthStart, lt: monthEnd } }),
      },
      select: {
        id: true,
        vendor: true,
        fileName: true,
        totalAmountCents: true,
        type: true,
        date: true,
        category: true,
        vatDetails: true,
        sourceTransactionId: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    shared ? Promise.resolve(shared) : loadSharedMatchData(userId, now),
    // Bank rows of this month's tiliote that still need a document (the one rule, lib/month-rows.ts).
    prisma.transaction.findMany({
      where: openMonthRowsWhere(userId, month),
      select: {
        id: true,
        date: true,
        amountCents: true,
        counterparty: true,
        message: true,
        matchStatus: true,
      },
      orderBy: { date: "desc" },
    }),
    // Draft invoices dated in the month: not in the books until they are sent.
    prisma.salesInvoice.findMany({
      where: {
        userId,
        status: "draft",
        documentKind: "invoice",
        issueDate: { gte: monthStart, lt: monthEnd },
      },
      select: {
        id: true,
        number: true,
        grossCents: true,
        issueDate: true,
        customer: { select: { name: true } },
      },
      orderBy: { number: "asc" },
    }),
  ]);

  // A past month's income draft is tied to its bank row, whose booking date can
  // fall outside the tiliote's month: include it by the row, not only by date.
  if (!isCurrent && monthRows.length > 0) {
    const shown = new Set(pendingRows.map((receipt) => receipt.id));
    const byRow = await prisma.receipt.findMany({
      where: {
        userId,
        reviewStatus: "pending",
        sourceTransactionId: { in: monthRows.map((row) => row.id) },
      },
      select: {
        id: true,
        vendor: true,
        fileName: true,
        totalAmountCents: true,
        type: true,
        date: true,
        category: true,
        vatDetails: true,
        sourceTransactionId: true,
      },
    });
    for (const receipt of byRow) if (!shown.has(receipt.id)) pendingRows.push(receipt);
  }
  const monthRowIds = new Set(monthRows.map((row) => row.id));

  // An invoice whose payment is already on the statement gets "Kohdista",
  // never a reminder: the customer has paid.
  const paidOnStatement = new Set(
    [...(matchRun.preview ?? []), ...matchRun.suggestions].map((entry) => entry.invoiceId)
  );
  const overdue = overdueRows
    .filter((invoice) => !paidOnStatement.has(invoice.id))
    .map((invoice) => {
      const position = openPosition({
        status: invoice.status,
        grossCents: invoice.grossCents,
        paidCents: invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0),
        closedReason: invoice.closedReason,
      });
      return { invoice, position };
    })
    .filter(({ position }) => position.collectible && position.openCents > 0)
    .map(({ invoice, position }): DashboardItem => ({
      id: `overdue_invoice:${invoice.id}`,
      kind: "overdue_invoice",
      action: "remind",
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      number: invoice.number,
      party: invoice.customer.name,
      amount: centsToEuros(position.openCents),
      dueDate: iso(invoice.dueDate)!,
      daysLate: Math.round((today.getTime() - invoice.dueDate.getTime()) / 86_400_000),
    }));

  const pending = pendingRows.map((receipt): DashboardItem => {
    const vatLines = parseVatDetails(receipt.vatDetails);
    const rates = vatLines ? [...new Set(vatLines.map((line) => line.rate))] : [];
    return {
      id: `pending_receipt:${receipt.id}`,
      kind: "pending_receipt",
      action: "approve",
      receiptId: receipt.id,
      party: receipt.vendor || receipt.fileName || "Kuitti",
      amount: receipt.totalAmountCents == null ? null : centsToEuros(receipt.totalAmountCents),
      type: receipt.type,
      date: iso(receipt.date),
      category: receipt.category,
      vatRate: rates.length === 1 ? rates[0] : null,
      gaps: approvalGaps({ totalAmountCents: receipt.totalAmountCents, vendor: receipt.vendor }),
    };
  });

  // Reference hits first (certain), then amount suggestions; one item per invoice.
  const matchEntries = [
    ...(matchRun.preview ?? []).map((entry) => ({ ...entry })),
    ...matchRun.suggestions.map((entry) => ({ ...entry })),
  ].filter((entry) => isCurrent || monthRowIds.has(entry.transactionId));
  const seenInvoices = new Set<string>();
  const matches: DashboardItem[] = [];
  for (const entry of matchEntries) {
    if (seenInvoices.has(entry.invoiceId)) continue;
    seenInvoices.add(entry.invoiceId);
    matches.push({
      id: `invoice_match:${entry.invoiceId}:${entry.transactionId}`,
      kind: "invoice_match",
      action: "confirm_match",
      invoiceId: entry.invoiceId,
      number: entry.invoiceNumber,
      transactionId: entry.transactionId,
      party: entry.customerName,
      amount: entry.amount,
      paidDate: entry.paidDate,
    });
  }
  // Only rows that got an item: a second candidate row for the same invoice is
  // still an open row and must keep its own task (FP-2).
  const matchedRows = new Set(
    matches.map((item) => (item.kind === "invoice_match" ? item.transactionId : ""))
  );
  // A row with an income draft already has its document; the draft is listed
  // as a pending receipt instead.
  const drafted = await prisma.receipt.findMany({
    // Pending only: a rejected draft leaves its row without a document again.
    where: { userId, reviewStatus: "pending", sourceTransactionId: { in: monthRows.map((row) => row.id) } },
    select: { sourceTransactionId: true },
  });
  const draftedRows = new Set(drafted.map((receipt) => receipt.sourceTransactionId));

  const missing: DashboardItem[] = [];
  const receiptMatches: DashboardItem[] = [];
  for (const row of monthRows) {
    // A row that is an invoice payment waiting for Kohdista needs no receipt.
    if (matchedRows.has(row.id) || draftedRows.has(row.id)) continue;
    const base = {
      transactionId: row.id,
      party: row.counterparty || row.message || "Pankkitapahtuma",
      amount: centsToEuros(row.amountCents),
      date: iso(row.date),
    };
    if (row.matchStatus === "suggested") {
      receiptMatches.push({
        id: `receipt_match:${row.id}`,
        kind: "receipt_match",
        action: "review_match",
        ...base,
      });
    } else {
      missing.push({ id: `missing_receipt:${row.id}`, kind: "missing_receipt", action: "add_photo", ...base });
    }
  }

  const duplicateItems = duplicates
    .filter((pair) => isCurrent || inMonth(pair.paidDate, month))
    .map((pair): DashboardItem => ({
      id: `payment_duplicate:${pair.receiptId}:${pair.paymentId}`,
      kind: "payment_duplicate",
      action: "open_invoice",
      invoiceId: pair.invoiceId,
      number: pair.invoiceNumber,
      party: pair.customerName,
      amount: centsToEuros(pair.amountCents),
      paidDate: pair.paidDate,
    }));

  const drafts = draftRows.map((invoice): DashboardItem => ({
    id: `draft_invoice:${invoice.id}`,
    kind: "draft_invoice",
    action: "open_invoice",
    invoiceId: invoice.id,
    number: invoice.number,
    party: invoice.customer.name,
    amount: centsToEuros(invoice.grossCents),
    issueDate: iso(invoice.issueDate)!,
  }));

  // Mockup order: documents first, then matches, then drafts; the
  // non-blocking overdue invoices form their own group on Koti.
  const groups: Array<[DashboardItemKind, DashboardItem[]]> = [
    ["pending_receipt", pending],
    ["missing_receipt", missing],
    ["invoice_match", matches],
    ["receipt_match", receiptMatches],
    ["payment_duplicate", duplicateItems],
    ["draft_invoice", drafts],
    ["overdue_invoice", overdue],
  ];
  const totals = Object.fromEntries(groups.map(([kind, list]) => [kind, list.length])) as Record<
    DashboardItemKind,
    number
  >;
  const blockingTotal = groups
    .filter(([kind]) => isBlockingKind(kind))
    .reduce((sum, [, list]) => sum + list.length, 0);
  return {
    items: groups.flatMap(([, list]) => list.slice(0, perKind)),
    totals,
    blockingTotal,
  };
}
