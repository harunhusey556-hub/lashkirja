import type { StatementData, StatementTransaction } from "@/lib/statement-client";

/**
 * The Pankki screen's one list: every bank row from every tiliote, newest
 * first, grouped by month. A tiliote is how rows arrive (one per month and
 * account from the bank, or a file), not something the owner browses.
 */

export interface FeedRow extends StatementTransaction {
  statementId: string;
  /** "YYYY-MM" the row is shown under. */
  month: string;
  accountName: string | null;
}

/**
 * What the row needs from the owner, in the owner's terms.
 * - `sale`: a recognised sale (MobilePay etc.) waiting for one "Hyväksy".
 * - `suggested`: a kuitti is proposed for the row.
 * - `missing`: no document yet.
 * - `linked` / `ignored` / `transfer`: nothing to do.
 */
export type RowState = "sale" | "suggested" | "missing" | "linked" | "ignored" | "transfer";

export function rowState(row: StatementTransaction): RowState {
  if (row.type === "oma_siirto" || row.type === "palkka") return "transfer";
  if (row.matchStatus === "confirmed") return "linked";
  if (row.matchStatus === "ignored") return "ignored";
  if (row.matchStatus === "suggested" && row.suggestedReceiptId) {
    return row.suggestedReceipt?.source === "auto_income" ? "sale" : "suggested";
  }
  return "missing";
}

export function needsAction(row: StatementTransaction): boolean {
  const state = rowState(row);
  return state === "sale" || state === "suggested" || state === "missing";
}

function rowMonth(statement: StatementData, row: StatementTransaction): string {
  if (statement.periodMonth) return statement.periodMonth;
  if (row.date) return row.date.slice(0, 7);
  return "";
}

/** Every row of every statement, newest first; undated rows last in their month. */
export function feedRows(statements: StatementData[]): FeedRow[] {
  const rows: FeedRow[] = [];
  for (const statement of statements) {
    for (const row of statement.transactions) {
      rows.push({
        ...row,
        statementId: statement.id,
        month: rowMonth(statement, row),
        accountName: statement.bankAccount?.name ?? null,
      });
    }
  }
  return rows.sort((a, b) => {
    if (a.month !== b.month) return b.month.localeCompare(a.month);
    if (a.date !== b.date) {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return b.date.localeCompare(a.date);
    }
    return a.id.localeCompare(b.id);
  });
}

export interface FeedMonth {
  month: string;
  rows: FeedRow[];
  /** Rows that still need the owner. */
  open: number;
}

/** Rows (already sorted by `feedRows`) grouped by month, newest month first. */
export function groupByMonth(rows: FeedRow[]): FeedMonth[] {
  const groups: FeedMonth[] = [];
  for (const row of rows) {
    let group = groups.at(-1);
    if (!group || group.month !== row.month) {
      group = { month: row.month, rows: [], open: 0 };
      groups.push(group);
    }
    group.rows.push(row);
    if (needsAction(row)) group.open += 1;
  }
  return groups;
}

/** Case-insensitive search over the words and the amount the owner sees. */
export function matchesSearch(row: FeedRow, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase("fi");
  if (!needle) return true;
  const amount = Math.abs(row.amount).toFixed(2);
  const haystack = [
    row.counterparty,
    row.message,
    row.reference,
    row.accountName,
    amount,
    amount.replace(".", ","),
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase("fi");
  return haystack.includes(needle);
}

/**
 * The row after "Poista linkitys". When the link was the approval of the row's
 * own sale, the sale is waiting again and the row offers "Hyväksy" at once;
 * otherwise the row is simply open.
 */
export function unlinkedRowPatch(
  receipt: StatementTransaction["receipt"],
  restoredSale: boolean
): Partial<StatementTransaction> {
  if (restoredSale && receipt) {
    return {
      matchStatus: "suggested",
      receiptId: null,
      receipt: null,
      suggestedReceiptId: receipt.id,
      suggestedReceipt: { ...receipt, source: "auto_income" },
    };
  }
  return { matchStatus: "unmatched", receiptId: null, receipt: null };
}

/** What happened, in one sentence: an approved sale that left the books says so. */
export function unlinkMessage(restoredSale: boolean): string {
  return restoredSale
    ? "Linkitys poistettu. Myynti ei ole kirjanpidossa, ennen kuin hyväksyt sen uudelleen."
    : "Linkitys poistettu.";
}
