import type { StatementBankAccount, StatementData, StatementTransaction } from "@/lib/statement-client";

/**
 * Paged reading of the Pankki feed (W20). The first paint needs ~50 rows, not
 * the whole ledger; "Näytä lisää" and the end-of-list sentinel ask for the
 * next page with the cursor the previous answer carried.
 *
 * Contract (W18): `GET /api/statements?limit=50[&cursor=]` answers
 * `{ transactions, nextCursor, total }`, rows newest first, each with its
 * `statementId`, `periodMonth` and `bankAccountId`. `GET /api/statements?view=summary`
 * answers the statements without rows (account, month, `openCount`), which is what
 * names a row's account and counts "Vaatii toimia" past the page on screen.
 *
 * The reading is lenient: an answer in the old shape (`{ statements }`, every row
 * at once) is one final page, so the client works before and after the paged
 * endpoint is deployed.
 */

export const BANK_PAGE_SIZE = 50;
/** A reload re-reads as many pages as the owner had opened, up to this many (2 000 rows). */
export const MAX_RELOAD_PAGES = 40;

export interface StatementsPage {
  statements: StatementData[];
  /** `null`: this was the last page. */
  nextCursor: string | null;
}

export function statementsUrl(cursor: string | null, limit: number = BANK_PAGE_SIZE): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  return `/api/statements?${params.toString()}`;
}

/** A row as the paged endpoint sends it: the transaction plus where it belongs. */
export type FeedPageRow = StatementTransaction & {
  statementId?: string;
  periodMonth?: string | null;
  bankAccountId?: string | null;
};

/** One statement without its rows (`?view=summary`). */
export interface StatementSummary {
  id: string;
  fileName?: string;
  fileType?: string;
  uploadedAt?: string;
  periodMonth: string | null;
  bankAccountId: string | null;
  bankAccount: StatementBankAccount | null;
  /** Rows of this statement that still need the owner. */
  openCount?: number;
}

function stub(id: string, periodMonth: string | null, bankAccountId: string | null, rows: StatementTransaction[]): StatementData {
  return {
    id,
    fileName: "",
    fileType: "",
    uploadedAt: "",
    periodMonth,
    bankAccountId,
    bankAccount: null,
    transactions: rows,
    totals: { income: 0, expenses: 0, transfers: 0, net: 0, txCount: rows.length },
  };
}

export function readStatementsPage(
  raw: { statements?: unknown; transactions?: unknown; nextCursor?: unknown } | null | undefined
): StatementsPage {
  const cursor = raw?.nextCursor;
  const nextCursor = typeof cursor === "string" && cursor !== "" ? cursor : null;
  if (Array.isArray(raw?.transactions)) {
    // The paged shape is flat; the screen groups by statement, so the rows are regrouped here.
    const byStatement = new Map<string, StatementData>();
    for (const row of raw.transactions as FeedPageRow[]) {
      const id = row.statementId ?? "feed";
      let statement = byStatement.get(id);
      if (!statement) {
        statement = stub(id, row.periodMonth ?? null, row.bankAccountId ?? null, []);
        byStatement.set(id, statement);
      }
      statement.transactions.push(row);
      statement.totals.txCount += 1;
    }
    return { statements: [...byStatement.values()], nextCursor };
  }
  return { statements: Array.isArray(raw?.statements) ? (raw.statements as StatementData[]) : [], nextCursor };
}

/** The summaries of an answer; an answer in the old shape (full statements) carries none. */
export function readSummaries(raw: { statements?: unknown } | null | undefined): StatementSummary[] {
  if (!Array.isArray(raw?.statements)) return [];
  return (raw.statements as Array<StatementSummary & { transactions?: unknown }>).filter(
    (statement) => typeof statement?.id === "string" && !Array.isArray(statement.transactions)
  );
}

/** Account name and month for the rows of statements that came without them. */
export function applySummaries(statements: StatementData[], summaries: readonly StatementSummary[]): StatementData[] {
  if (summaries.length === 0) return statements;
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  return statements.map((statement) => {
    const summary = byId.get(statement.id);
    if (!summary) return statement;
    return {
      ...statement,
      fileName: summary.fileName ?? statement.fileName,
      fileType: summary.fileType ?? statement.fileType,
      uploadedAt: summary.uploadedAt ?? statement.uploadedAt,
      periodMonth: summary.periodMonth ?? statement.periodMonth,
      bankAccountId: summary.bankAccountId ?? statement.bankAccountId,
      bankAccount: summary.bankAccount ?? statement.bankAccount,
    };
  });
}

/** Rows that need the owner across the whole ledger, or null when the server did not say. */
export function openTotal(summaries: readonly StatementSummary[]): number | null {
  if (summaries.length === 0 || summaries.some((summary) => typeof summary.openCount !== "number")) return null;
  return summaries.reduce((sum, summary) => sum + (summary.openCount ?? 0), 0);
}

export const STATEMENT_SUMMARY_URL = "/api/statements?view=summary";

/**
 * Adds a page to what is on screen. A statement can straddle two pages, so
 * statements are matched by id and their rows by id: no row appears twice and
 * the order of what was already shown does not change.
 */
export function mergeStatementsPage(current: StatementData[], incoming: StatementData[]): StatementData[] {
  const next = current.map((statement) => ({ ...statement, transactions: [...statement.transactions] }));
  const byId = new Map(next.map((statement) => [statement.id, statement]));
  for (const statement of incoming) {
    const existing = byId.get(statement.id);
    if (!existing) {
      const copy = { ...statement, transactions: dedupeRows(statement.transactions) };
      byId.set(copy.id, copy);
      next.push(copy);
      continue;
    }
    const known = new Set(existing.transactions.map((row) => row.id));
    for (const row of statement.transactions) {
      if (known.has(row.id)) continue;
      known.add(row.id);
      existing.transactions.push(row);
    }
  }
  return next;
}

function dedupeRows(rows: StatementTransaction[]): StatementTransaction[] {
  const seen = new Set<string>();
  return rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
}

/**
 * After a reload, rows whose content did not change keep their old object, so
 * the memoised row components skip them: one changed row repaints one row,
 * and a poll that found nothing new repaints nothing.
 */
export function reuseEqualRows(previous: StatementData[], next: StatementData[]): StatementData[] {
  const old = new Map<string, { row: StatementTransaction; json: string }>();
  for (const statement of previous) {
    for (const row of statement.transactions) old.set(row.id, { row, json: JSON.stringify(row) });
  }
  return next.map((statement) => ({
    ...statement,
    transactions: statement.transactions.map((row) => {
      const before = old.get(row.id);
      return before && before.json === JSON.stringify(row) ? before.row : row;
    }),
  }));
}
