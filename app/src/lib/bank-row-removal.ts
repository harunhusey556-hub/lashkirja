/**
 * Deleting bank rows (one row, or a whole tiliote) without breaking the books.
 *
 * Two things hang off a bank row by a plain id, not a relation, so deleting the
 * row does not take them along:
 *
 * - The sale draft made from an incoming row (`Receipt.sourceTransactionId`,
 *   "Hyväksy myynti"). A draft still waiting for approval has lost its reason
 *   to exist and is removed with the row. An approved one is booked evidence
 *   and stays.
 * - The "already settled by a bank row" rule of the VAT return (see
 *   alv-period.ts): an income receipt from, or linked to, a row that paid a
 *   sales invoice is left out, because that money is the invoice. The rule reads
 *   the row, and `InvoicePayment.transactionId` is nulled when the row goes, so
 *   without this the same sale would be counted again (invoice + receipt).
 *   Such a receipt is rejected in the same transaction: the invoice stays the
 *   one source of the sale and the return reads the same before and after.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "./db";
import { assertPeriodOpen } from "./period-lock";

/** SQLite caps the bound variables of one statement; stay well under it. */
const CHUNK = 500;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += CHUNK) out.push(items.slice(index, index + CHUNK));
  return out;
}

export interface RowRemovalOutcome<T> {
  result: T;
  /** Pending sale drafts removed together with their rows. */
  removedDrafts: number;
  /** Booked income receipts of rows that settled an invoice, dropped so the sale is not counted twice. */
  mergedIntoInvoice: number;
}

/**
 * Runs `remove` (the actual row or statement delete) in one transaction
 * together with the clean-up above. Refuses, before changing anything, when a
 * booked receipt it would have to reject belongs to a closed period.
 */
export async function removeBankRows<T>(
  userId: string,
  rowIds: string[],
  remove: (db: Prisma.TransactionClient) => Promise<T>
): Promise<RowRemovalOutcome<T>> {
  const settledRowIds: string[] = [];
  const linkedReceiptIds: string[] = [];
  for (const slice of chunks(rowIds)) {
    const rows = await prisma.transaction.findMany({
      where: { id: { in: slice }, statement: { userId } },
      select: { id: true, receiptId: true, invoicePayment: { select: { id: true } } },
    });
    for (const row of rows) {
      if (!row.invoicePayment) continue;
      settledRowIds.push(row.id);
      if (row.receiptId) linkedReceiptIds.push(row.receiptId);
    }
  }

  // Booked income that is only a second copy of a settled invoice.
  const duplicateSales: Array<{ id: string; date: Date | null }> = [];
  for (const slice of chunks(settledRowIds)) {
    const sources = await prisma.receipt.findMany({
      where: {
        userId,
        type: "tulo",
        reviewStatus: "approved",
        sourceTransactionId: { in: slice },
      },
      select: { id: true, date: true },
    });
    duplicateSales.push(...sources);
  }
  for (const slice of chunks(linkedReceiptIds)) {
    const linked = await prisma.receipt.findMany({
      where: { userId, type: "tulo", reviewStatus: "approved", id: { in: slice } },
      select: { id: true, date: true },
    });
    for (const receipt of linked) {
      if (!duplicateSales.some((known) => known.id === receipt.id)) duplicateSales.push(receipt);
    }
  }

  await assertPeriodOpen(
    userId,
    duplicateSales.map((receipt) => receipt.date)
  );

  return prisma.$transaction(
    async (db) => {
      let mergedIntoInvoice = 0;
      for (const slice of chunks(duplicateSales.map((receipt) => receipt.id))) {
        const updated = await db.receipt.updateMany({
          where: { id: { in: slice }, userId, reviewStatus: "approved" },
          data: { reviewStatus: "rejected" },
        });
        mergedIntoInvoice += updated.count;
      }

      let removedDrafts = 0;
      for (const slice of chunks(rowIds)) {
        const deleted = await db.receipt.deleteMany({
          where: {
            userId,
            source: "auto_income",
            reviewStatus: "pending",
            sourceTransactionId: { in: slice },
          },
        });
        removedDrafts += deleted.count;
      }

      const result = await remove(db);
      return { result, removedDrafts, mergedIntoInvoice };
    },
    { timeout: 60_000 }
  );
}
