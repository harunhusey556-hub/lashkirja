/**
 * "Tarvitaan sinulta" on Koti: concrete items, one per thing the owner must do,
 * each naming the other party and carrying what its one-tap action needs
 * (approved mockup 01-koti.png).
 *
 * Month scope: the current month shows everything that is open now (an
 * overdue invoice from spring is still due today). A past month shows only
 * items tied to that month, so its headline never counts today's work.
 */
import { prisma } from "@/lib/db";
import { centsToEuros } from "@/lib/money";
import { openPosition } from "@/lib/invoices";
import { parseVatDetails } from "@/lib/alv";
import { findPaymentReceiptDuplicates } from "@/lib/alv-period";
import { matchInvoicePaymentsFromBank } from "@/lib/sales-invoices";
import { helsinkiCalendarDate, isoDateToUtc } from "@/lib/validation";

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
    };

export type DashboardItemKind = DashboardItem["kind"];

export interface DashboardItems {
  items: DashboardItem[];
  /** How many of each kind exist in scope, shown or not. */
  totals: Record<DashboardItemKind, number>;
}

const iso = (date: Date | null | undefined) => (date ? date.toISOString().slice(0, 10) : null);

function inMonth(value: string | null, month: string): boolean {
  return value !== null && value.startsWith(month);
}

export async function buildDashboardItems(
  userId: string,
  month: string,
  isCurrent: boolean,
  now: Date = new Date()
): Promise<DashboardItems> {
  const today = isoDateToUtc(helsinkiCalendarDate(now));
  const [year, monthNum] = month.split("-").map(Number);
  const monthStart = new Date(Date.UTC(year, monthNum - 1, 1));
  const monthEnd = new Date(Date.UTC(year, monthNum, 1));

  const [overdueRows, pendingRows, matchRun, monthRows, duplicates] = await Promise.all([
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
      },
      orderBy: { createdAt: "desc" },
    }),
    matchInvoicePaymentsFromBank(userId, now, { dryRun: true }),
    // Bank rows of this month's tiliote that still need a document.
    prisma.transaction.findMany({
      where: {
        statement: { userId, periodMonth: month },
        type: { in: ["tulo", "meno"] },
        receiptId: null,
        invoicePayment: null,
        purchasePayment: null,
        matchStatus: { in: ["unmatched", "suggested"] },
      },
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
    findPaymentReceiptDuplicates(userId),
  ]);

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
    };
  });

  // Reference hits first (certain), then amount suggestions; one item per invoice.
  const matchEntries = [
    ...(matchRun.preview ?? []).map((entry) => ({ ...entry })),
    ...matchRun.suggestions.map((entry) => ({ ...entry })),
  ].filter((entry) => isCurrent || inMonth(entry.paidDate, month));
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
  const matchedRows = new Set(matchEntries.map((entry) => entry.transactionId));
  // A row with an income draft already has its document; the draft is listed
  // as a pending receipt instead.
  const drafted = await prisma.receipt.findMany({
    where: { userId, sourceTransactionId: { in: monthRows.map((row) => row.id) } },
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

  // Mockup order: what is costing money first, then documents, then matches.
  const groups: Array<[DashboardItemKind, DashboardItem[]]> = [
    ["overdue_invoice", overdue],
    ["pending_receipt", pending],
    ["missing_receipt", missing],
    ["invoice_match", matches],
    ["receipt_match", receiptMatches],
    ["payment_duplicate", duplicateItems],
  ];
  const totals = Object.fromEntries(groups.map(([kind, list]) => [kind, list.length])) as Record<
    DashboardItemKind,
    number
  >;
  return {
    items: groups.flatMap(([, list]) => list.slice(0, ITEMS_PER_KIND)),
    totals,
  };
}
