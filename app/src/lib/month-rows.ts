/**
 * One rule for "is this bank row in order?" (FP-2, TF-04).
 *
 * Koti's progress bar, Koti's task rows and the month close checklist all
 * read a month's bank rows. They used three different rules, which is how
 * August showed "2 / 3 kunnossa" with no row for the third: an income row
 * that had settled a sales invoice counted as not done in the bar and as
 * "ei tositetta" in the checklist, but had (correctly) no task on Koti.
 *
 * A row is documented by a receipt, by an invoice payment (sales or
 * purchase), or by an explicit confirmation. An ignored row needs nothing.
 * Transfers between own accounts (oma_siirto) are never counted.
 */

export interface MonthRowFacts {
  type: string;
  matchStatus: string;
  receiptId: string | null;
  invoicePayment?: { id: string } | null;
  purchasePayment?: { id: string } | null;
}

/** Rows the month is measured by: income and expense, not own transfers or ignored ones. */
export function isCountedRow(row: MonthRowFacts): boolean {
  return (row.type === "tulo" || row.type === "meno") && row.matchStatus !== "ignored";
}

export function isDocumentedRow(row: MonthRowFacts): boolean {
  return (
    row.receiptId !== null ||
    Boolean(row.invoicePayment) ||
    Boolean(row.purchasePayment) ||
    row.matchStatus === "confirmed"
  );
}

/** Prisma select for the facts above. */
export const MONTH_ROW_FACTS = {
  type: true,
  matchStatus: true,
  receiptId: true,
  invoicePayment: { select: { id: true } },
  purchasePayment: { select: { id: true } },
} as const;

/**
 * Prisma filter for a month's rows that still need something from the user.
 * The complement of `isDocumentedRow` among the counted rows.
 */
export function openMonthRowsWhere(userId: string, month: string) {
  return {
    statement: { userId, periodMonth: month },
    type: { in: ["tulo", "meno"] },
    receiptId: null,
    invoicePayment: null,
    purchasePayment: null,
    matchStatus: { in: ["unmatched", "suggested"] },
  };
}

export interface MonthProgress {
  /** Counted rows. */
  matchable: number;
  /** Counted rows that are documented. */
  matched: number;
  /** Of the rest, those with a receipt suggestion waiting. */
  suggested: number;
}

export function monthProgress(rows: MonthRowFacts[]): MonthProgress {
  let matchable = 0;
  let matched = 0;
  let suggested = 0;
  for (const row of rows) {
    if (!isCountedRow(row)) continue;
    matchable += 1;
    if (isDocumentedRow(row)) matched += 1;
    else if (row.matchStatus === "suggested") suggested += 1;
  }
  return { matchable, matched, suggested };
}
