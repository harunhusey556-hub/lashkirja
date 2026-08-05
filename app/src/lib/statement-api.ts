import { prisma } from "@/lib/db";
import { buildInlineCandidates } from "@/lib/matching";
import { centsToEuros } from "@/lib/money";
import { computeStatementTotals } from "@/lib/statements";

function publicTransaction<T extends { amountCents: number }>(tx: T) {
  const { amountCents, ...rest } = tx;
  return { ...rest, amount: centsToEuros(amountCents) };
}

function publicReceipt<T extends { totalAmountCents?: number | null }>(receipt: T) {
  const { totalAmountCents, ...rest } = receipt;
  return {
    ...rest,
    totalAmount: totalAmountCents == null ? null : centsToEuros(totalAmountCents),
  };
}

const statementInclude = {
  transactions: {
    orderBy: { date: "asc" as const },
    include: {
      receipt: {
        select: {
          id: true,
          vendor: true,
          totalAmountCents: true,
          date: true,
        },
      },
    },
  },
};

async function enrichStatements(
  userId: string,
  statements: Array<{
    transactions: Array<{
      id: string;
      suggestedReceiptId: string | null;
      receipt: {
        id: string;
        vendor: string | null;
        totalAmountCents: number | null;
        date: Date | null;
      } | null;
      date: Date | null;
      counterparty: string | null;
      reference: string | null;
      message: string | null;
      type: string;
      matchStatus: string;
      amountCents: number;
    }>;
    [key: string]: unknown;
  }>
) {
  const suggestedIds = [
    ...new Set(
      statements
        .flatMap((s) => s.transactions)
        .map((t) => t.suggestedReceiptId)
        .filter((id): id is string => id !== null)
    ),
  ];
  const suggestedReceipts = suggestedIds.length
    ? await prisma.receipt.findMany({
        where: { id: { in: suggestedIds } },
        select: {
          id: true,
          vendor: true,
          totalAmountCents: true,
          date: true,
        },
      })
    : [];
  const suggestedById = new Map(suggestedReceipts.map((r) => [r.id, r]));
  const inlineCandidates = await buildInlineCandidates(
    userId,
    statements.flatMap((s) => s.transactions)
  );

  return statements.map((s) => ({
    ...s,
    transactions: s.transactions.map((t) => ({
      ...publicTransaction(t),
      receipt: t.receipt ? publicReceipt(t.receipt) : null,
      suggestedReceipt: t.suggestedReceiptId
        ? suggestedById.get(t.suggestedReceiptId)
          ? publicReceipt(suggestedById.get(t.suggestedReceiptId)!)
          : null
        : null,
      matchCandidates: inlineCandidates.get(t.id) ?? [],
    })),
    totals: computeStatementTotals(s.transactions.map(publicTransaction)),
  }));
}

export async function listStatementsForUser(userId: string, month?: string | null) {
  const statements = await prisma.statement.findMany({
    where: {
      userId,
      ...(month ? { periodMonth: month } : {}),
    },
    include: statementInclude,
    orderBy: { uploadedAt: "desc" },
  });
  return enrichStatements(userId, statements);
}

export async function getStatementForUser(userId: string, statementId: string) {
  const statement = await prisma.statement.findFirst({
    where: { id: statementId, userId },
    include: statementInclude,
  });
  if (!statement) return null;
  const [enriched] = await enrichStatements(userId, [statement]);
  return enriched;
}
