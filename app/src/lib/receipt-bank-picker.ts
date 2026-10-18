/**
 * "Valitse muu pankkitapahtuma" on a receipt: every bank row the owner could link
 * by hand, not only the matcher's three or five suggestions (the owner,
 * 2026-10-15: "I am limited to what the AI proposed"). Same answer shape and
 * paging as the purchase invoice picker (purchase-bank-match.ts), so the app
 * shows both with one component. The gate's score only ranks; nothing here is
 * linked, POST /api/matching/confirm does that.
 */
import { prisma } from "./db";
import { NotFoundError } from "./api-errors";
import { centsToEuros } from "./money";
import { receiptDirection, scorePair, type MatchReceipt } from "./matching";
import {
  matchesPurchaseSearch,
  pageOf,
  type CandidatePage,
  type PurchaseBankCandidateList,
} from "./purchase-bank-match";

const DAY_MS = 86_400_000;

function isoDay(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

/**
 * Bank rows that may be this receipt's payment, best first: the same direction
 * (a meno receipt is money out, a credit note money back), not documented by
 * another receipt and not a sales or purchase payment - except a payment of
 * this receipt's own ostolasku, which is the same purchase.
 */
export async function listBankRowsForReceipt(
  userId: string,
  receiptId: string,
  options: { q?: string | null; month?: string | null } & CandidatePage = {}
): Promise<PurchaseBankCandidateList> {
  const receipt = await prisma.receipt.findFirst({
    where: { id: receiptId, userId },
    select: {
      id: true,
      vendor: true,
      date: true,
      totalAmountCents: true,
      type: true,
      reference: true,
      invoiceNumber: true,
      purchaseInvoice: { select: { id: true } },
    },
  });
  if (!receipt) throw new NotFoundError("Kuittia ei löytynyt.");

  const ownInvoiceId = receipt.purchaseInvoice?.id ?? null;
  const model: MatchReceipt = {
    id: receipt.id,
    vendor: receipt.vendor,
    date: receipt.date,
    totalAmount: receipt.totalAmountCents == null ? null : centsToEuros(receipt.totalAmountCents),
    type: receipt.type,
    reference: receipt.reference,
    invoiceNumber: receipt.invoiceNumber,
  };
  const rows = await prisma.transaction.findMany({
    where: {
      statement: { userId },
      amountCents: receiptDirection(model) === "tulo" ? { gt: 0 } : { lt: 0 },
      invoicePayment: null,
      OR: [{ receiptId: null }, { receiptId: receipt.id }],
      AND: [
        {
          OR: [
            { purchasePayment: null },
            ...(ownInvoiceId ? [{ purchasePayment: { purchaseInvoiceId: ownInvoiceId } }] : []),
          ],
        },
      ],
    },
    select: {
      id: true,
      statementId: true,
      date: true,
      amountCents: true,
      counterparty: true,
      reference: true,
      message: true,
      type: true,
      statement: { select: { periodMonth: true } },
    },
  });

  const q = options.q?.trim() ?? "";
  const monthOf = (row: (typeof rows)[number]) => isoDay(row.date)?.slice(0, 7) ?? row.statement.periodMonth ?? "";
  const searched = rows.filter((row) =>
    matchesPurchaseSearch(q, [row.counterparty, row.message, row.reference], row.amountCents)
  );

  const months = new Map<string, number>();
  for (const row of searched) {
    const key = monthOf(row);
    if (key) months.set(key, (months.get(key) ?? 0) + 1);
  }

  const receiptDay = receipt.date?.getTime() ?? null;
  const gap = (date: Date | null) =>
    date === null || receiptDay === null ? Number.MAX_SAFE_INTEGER : Math.abs(date.getTime() - receiptDay) / DAY_MS;
  const ranked = searched
    .filter((row) => !options.month || monthOf(row) === options.month)
    .map((row) => {
      // A row the gate refuses (an oma_siirto, a palkka) is still the owner's to pick; it just ranks last.
      const scored = scorePair(
        {
          id: row.id,
          date: row.date,
          counterparty: row.counterparty,
          amount: centsToEuros(row.amountCents),
          reference: row.reference,
          message: row.message,
          type: row.type,
        },
        model
      );
      return { row, score: scored?.score ?? 0, reasons: scored?.explanation ?? [], codes: scored?.reasons ?? [] };
    })
    // Best score first, then the bank date nearest the receipt's, then the newest row.
    .sort(
      (a, b) =>
        b.score - a.score ||
        gap(a.row.date) - gap(b.row.date) ||
        (b.row.date?.getTime() ?? 0) - (a.row.date?.getTime() ?? 0)
    );

  const page = pageOf(ranked, options);
  return {
    candidates: page.items.map(({ row, score, reasons, codes }) => ({
      transactionId: row.id,
      statementId: row.statementId,
      date: isoDay(row.date),
      counterparty: row.counterparty,
      message: row.message,
      reference: row.reference,
      amount: centsToEuros(Math.abs(row.amountCents)),
      score,
      exactAmount: codes.includes("amount"),
      amountDiff: null,
      reasons,
    })),
    total: ranked.length,
    offset: page.offset,
    hasMore: page.hasMore,
    months: [...months.entries()]
      .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
      .map(([month, count]) => ({ month, count })),
  };
}
