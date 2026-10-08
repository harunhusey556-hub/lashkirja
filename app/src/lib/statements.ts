import { PAYROLL_PROVIDER } from "./vat-rules";
import { prisma } from "./db";
import { centsToEuros } from "./money";

export type TransactionType = "meno" | "tulo" | "oma_siirto" | "palkka";

export interface TransactionLike {
  amount: number;
  type: string;
}

export function isNonReceiptTransaction(t: { type: string }): boolean {
  return t.type === "oma_siirto" || t.type === "palkka";
}

export function inferTransactionType(
  amount: number,
  hints?: { message?: string | null; counterparty?: string | null }
): TransactionType {
  const message = (hints?.message ?? "").trim();
  const counterparty = (hints?.counterparty ?? "").trim();
  const hay = `${counterparty} ${message}`.toLowerCase();

  if (
    (/^\s*palkka\s*\.?$/i.test(message) || /\bpalkka\b/i.test(message)) &&
    !PAYROLL_PROVIDER.test(hay)
  ) {
    return "palkka";
  }

  if (
    /oma siirto|siirto omalle|transfer to self|yksityisnosto|yksityisotto|oma nosto/i.test(
      hay
    )
  ) {
    return "oma_siirto";
  }

  return amount >= 0 ? "tulo" : "meno";
}

export async function reinferStatementTransactionTypes(
  statementId: string,
  userId: string
): Promise<number> {
  const txs = await prisma.transaction.findMany({
    where: { statementId, statement: { userId } },
    select: {
      id: true,
      amountCents: true,
      counterparty: true,
      message: true,
      type: true,
    },
  });
  let updated = 0;
  for (const tx of txs) {
    const next = inferTransactionType(centsToEuros(tx.amountCents), {
      counterparty: tx.counterparty,
      message: tx.message,
    });
    if (next !== tx.type) {
      await prisma.transaction.update({
        where: { id: tx.id },
        data: { type: next },
      });
      updated += 1;
    }
  }
  return updated;
}

export interface StatementTotals {
  income: number;
  expenses: number;
  transfers: number;
  net: number;
  txCount: number;
  /** All money in and out as the bank counts it (its "Panot" / "Otot"), transfers included. */
  moneyIn: number;
  moneyOut: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeStatementTotals(
  transactions: TransactionLike[]
): StatementTotals {
  let income = 0;
  let expenses = 0;
  let transfers = 0;
  let moneyIn = 0;
  let moneyOut = 0;
  for (const t of transactions) {
    if (t.amount > 0) moneyIn += t.amount;
    else moneyOut += Math.abs(t.amount);
    if (t.type === "tulo") income += t.amount;
    else if (t.type === "meno") expenses += Math.abs(t.amount);
    else if (t.type === "oma_siirto" || t.type === "palkka") transfers += t.amount;
  }
  return {
    income: round2(income),
    expenses: round2(expenses),
    transfers: round2(transfers),
    net: round2(income - expenses),
    txCount: transactions.length,
    moneyIn: round2(moneyIn),
    moneyOut: round2(moneyOut),
  };
}
