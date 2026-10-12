import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { openBankRowsWhere } from "@/lib/bank-open-rows";
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
  // The owning account travels with every statement so the UI can show and
  // change it without a second round trip.
  bankAccount: {
    select: { id: true, name: true, bankName: true, iban: true, currency: true },
  },
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
      // Which invoice the row paid: the delete dialog, and Pankki's "Maksu laskulle N" (F12).
      invoicePayment: { select: { id: true, invoice: { select: { id: true, number: true } } } },
      // Which purchase invoice the row paid: the app's "Avaa ostolasku" and "Irrota".
      purchasePayment: {
        select: { id: true, purchaseInvoice: { select: { id: true, supplierName: true } } },
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
      invoicePayment?: { id: string; invoice: { id: string; number: number } } | null;
      purchasePayment?: { id: string; purchaseInvoice: { id: string; supplierName: string } } | null;
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
          source: true,
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
    transactions: s.transactions.map(({ invoicePayment, purchasePayment, ...t }) => ({
      ...publicTransaction(t),
      settlesInvoice: Boolean(invoicePayment),
      paidInvoice: invoicePayment ? { id: invoicePayment.invoice.id, number: invoicePayment.invoice.number } : null,
      settlesPurchase: Boolean(purchasePayment),
      paidPurchase: purchasePayment
        ? {
            id: purchasePayment.purchaseInvoice.id,
            supplierName: purchasePayment.purchaseInvoice.supplierName,
            paymentId: purchasePayment.id,
          }
        : null,
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
    // Newest month first. A bank sync creates one statement per month in the
    // order the bank returns rows (often newest first), so upload time alone
    // put the newest month at the bottom. SQLite sorts NULL months last here.
    orderBy: [{ periodMonth: "desc" }, { uploadedAt: "desc" }],
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

/* ------------------------------ W18: summary and paged feed ------------------------------ */

const statementOrder = [{ periodMonth: "desc" as const }, { uploadedAt: "desc" as const }];

type TotalsRow = {
  id: string;
  n: number | bigint;
  moneyIn: number | bigint | null;
  moneyOut: number | bigint | null;
  income: number | bigint | null;
  expenses: number | bigint | null;
  transfers: number | bigint | null;
};

const cents = (value: number | bigint | null | undefined) => Number(value ?? 0);

/**
 * `?view=summary`: every statement with its totals and open-row count, without its rows. The
 * figures are SQL sums over the same rules as computeStatementTotals and openBankRowsWhere, so the
 * month list costs two aggregate queries instead of the whole ledger with match candidates.
 */
export async function listStatementSummariesForUser(userId: string, month?: string | null) {
  const monthFilter = month ? Prisma.sql`AND s."periodMonth" = ${month}` : Prisma.empty;
  const [statements, sums, open] = await Promise.all([
    prisma.statement.findMany({
      where: { userId, ...(month ? { periodMonth: month } : {}) },
      select: {
        id: true,
        bankAccountId: true,
        fileName: true,
        fileType: true,
        periodMonth: true,
        periodSource: true,
        uploadedAt: true,
        bankAccount: statementInclude.bankAccount,
      },
      orderBy: statementOrder,
    }),
    prisma.$queryRaw<TotalsRow[]>`
      SELECT t."statementId" AS id,
        COUNT(*) AS n,
        SUM(CASE WHEN t."amountCents" > 0 THEN t."amountCents" ELSE 0 END) AS "moneyIn",
        SUM(CASE WHEN t."amountCents" > 0 THEN 0 ELSE -t."amountCents" END) AS "moneyOut",
        SUM(CASE WHEN t."type" = 'tulo' THEN t."amountCents" ELSE 0 END) AS income,
        SUM(CASE WHEN t."type" = 'meno' THEN ABS(t."amountCents") ELSE 0 END) AS expenses,
        SUM(CASE WHEN t."type" IN ('oma_siirto', 'palkka') THEN t."amountCents" ELSE 0 END) AS transfers
      FROM "Transaction" t JOIN "Statement" s ON s."id" = t."statementId"
      WHERE s."userId" = ${userId} ${monthFilter}
      GROUP BY t."statementId"`,
    prisma.transaction.groupBy({
      by: ["statementId"],
      where: { ...openBankRowsWhere(userId), ...(month ? { statement: { userId, periodMonth: month } } : {}) },
      _count: { _all: true },
    }),
  ]);
  const sumById = new Map(sums.map((row) => [row.id, row]));
  const openById = new Map(open.map((row) => [row.statementId, row._count._all]));
  return statements.map((statement) => {
    const sum = sumById.get(statement.id);
    return {
      ...statement,
      totals: {
        income: centsToEuros(cents(sum?.income)),
        expenses: centsToEuros(cents(sum?.expenses)),
        transfers: centsToEuros(cents(sum?.transfers)),
        net: centsToEuros(cents(sum?.income) - cents(sum?.expenses)),
        txCount: cents(sum?.n),
        moneyIn: centsToEuros(cents(sum?.moneyIn)),
        moneyOut: centsToEuros(cents(sum?.moneyOut)),
      },
      openCount: openById.get(statement.id) ?? 0,
    };
  });
}

export const FEED_PAGE_SIZE = 50;
export const FEED_PAGE_MAX = 200;

/** A cursor the server did not hand out. */
export class FeedCursorError extends Error {}

type FeedCursor = { d: string | null; id: string };

function encodeCursor(row: { date: Date | null; id: string }): string {
  const cursor: FeedCursor = { d: row.date ? row.date.toISOString() : null, id: row.id };
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(raw: string): FeedCursor {
  let value: Partial<FeedCursor>;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<FeedCursor>;
  } catch {
    throw new FeedCursorError("Virheellinen sivutuskursori");
  }
  const dateOk = value.d === null || (typeof value.d === "string" && !Number.isNaN(Date.parse(value.d)));
  if (typeof value.id !== "string" || !dateOk) throw new FeedCursorError("Virheellinen sivutuskursori");
  return { d: value.d ?? null, id: value.id };
}

/** Rows after the cursor in the feed order: date newest first (rows without a date last), then id. */
function afterCursor(cursor: FeedCursor): Prisma.TransactionWhereInput {
  if (cursor.d === null) return { date: null, id: { lt: cursor.id } };
  const date = new Date(cursor.d);
  return { OR: [{ date: { lt: date } }, { date, id: { lt: cursor.id } }, { date: null }] };
}

/**
 * `?cursor=` / `?limit=`: the bank rows newest first, one page at a time, each row in exactly the
 * shape the full list gives it (match candidates included, for this page's rows only) plus its
 * statement's `periodMonth` and `bankAccountId`. Keyset paging: a row stored while the owner
 * scrolls never shifts a page or repeats a row.
 */
export async function listStatementFeedPage(
  userId: string,
  options: { cursor?: string | null; limit?: number; month?: string | null; accountId?: string | null }
) {
  const limit = Math.min(Math.max(options.limit ?? FEED_PAGE_SIZE, 1), FEED_PAGE_MAX);
  const scope: Prisma.TransactionWhereInput = {
    statement: {
      userId,
      ...(options.month ? { periodMonth: options.month } : {}),
      ...(options.accountId ? { bankAccountId: options.accountId } : {}),
    },
  };
  const where = options.cursor ? { AND: [scope, afterCursor(decodeCursor(options.cursor))] } : scope;
  const [rows, total] = await Promise.all([
    prisma.transaction.findMany({
      where,
      include: { ...statementInclude.transactions.include, statement: { select: { periodMonth: true, bankAccountId: true } } },
      orderBy: [{ date: "desc" }, { id: "desc" }],
      take: limit + 1,
    }),
    prisma.transaction.count({ where: scope }),
  ]);
  const page = rows.slice(0, limit);
  const placeOf = new Map(page.map((row) => [row.id, row.statement]));
  const [enriched] = await enrichStatements(userId, [
    { transactions: page.map(({ statement: _statement, ...row }) => row) },
  ]);
  return {
    transactions: enriched.transactions.map((row) => ({
      ...row,
      periodMonth: placeOf.get(row.id)?.periodMonth ?? null,
      bankAccountId: placeOf.get(row.id)?.bankAccountId ?? null,
    })),
    nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    total,
  };
}
