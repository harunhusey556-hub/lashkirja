import type { Prisma } from "@/generated/prisma/client";

/**
 * The bank rows that still need the owner, as one database count: the same rows
 * `needsAction` in lib/bank-feed.ts marks (sale, suggested, missing). The app's Kirjanpito
 * hub shows this figure; loading every statement with its match candidates to count them
 * cost a full ledger download per visit.
 */
export function openBankRowsWhere(userId: string): Prisma.TransactionWhereInput {
  return {
    statement: { userId },
    type: { notIn: ["oma_siirto", "palkka"] },
    invoicePayment: { is: null },
    purchasePayment: { is: null },
    matchStatus: { notIn: ["confirmed", "ignored"] },
  };
}
