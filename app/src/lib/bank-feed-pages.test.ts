import { describe, expect, it } from "vitest";
import {
  BANK_PAGE_SIZE,
  applySummaries,
  mergeStatementsPage,
  openTotal,
  readStatementsPage,
  readSummaries,
  reuseEqualRows,
  statementsUrl,
} from "./bank-feed-pages";
import { feedRows } from "./bank-feed";
import type { StatementData, StatementTransaction } from "./statement-client";

function tx(id: string, over: Partial<StatementTransaction> = {}): StatementTransaction {
  return {
    id,
    date: "2026-09-10T00:00:00.000Z",
    counterparty: `Kauppa ${id}`,
    amount: -10,
    reference: null,
    message: null,
    type: "meno",
    matchStatus: "unmatched",
    receiptId: null,
    receipt: null,
    suggestedReceiptId: null,
    suggestedReceipt: null,
    ...over,
  };
}

function statement(id: string, rows: StatementTransaction[], periodMonth = "2026-09"): StatementData {
  return {
    id,
    fileName: `${id}.csv`,
    fileType: "csv",
    uploadedAt: "2026-10-01T00:00:00.000Z",
    periodMonth,
    bankAccountId: "acc",
    bankAccount: { id: "acc", name: "Yritystili", bankName: null, iban: null, currency: "EUR" },
    transactions: rows,
    totals: { income: 0, expenses: 0, transfers: 0, net: 0, txCount: rows.length },
  };
}

describe("statementsUrl / readStatementsPage", () => {
  it("asks for one page of 50, with the cursor when there is one", () => {
    expect(statementsUrl(null)).toBe(`/api/statements?limit=${BANK_PAGE_SIZE}`);
    expect(statementsUrl("abc=")).toBe(`/api/statements?limit=${BANK_PAGE_SIZE}&cursor=abc%3D`);
  });

  it("reads a server that does not page as a single, final page", () => {
    const page = readStatementsPage({ statements: [statement("s1", [tx("a")])] });
    expect(page.nextCursor).toBeNull();
    expect(page.statements).toHaveLength(1);
    expect(readStatementsPage(null)).toEqual({ statements: [], nextCursor: null });
    expect(readStatementsPage({ statements: [], nextCursor: "" }).nextCursor).toBeNull();
    expect(readStatementsPage({ statements: [], nextCursor: "c2" }).nextCursor).toBe("c2");
  });
});

describe("the paged shape of W18 ({ transactions, nextCursor })", () => {
  const flat = (id: string, statementId: string, periodMonth = "2026-09") => ({
    ...tx(id),
    statementId,
    periodMonth,
    bankAccountId: "acc-1",
  });

  it("regroups flat rows by statement and keeps the cursor", () => {
    const page = readStatementsPage({
      transactions: [flat("a", "s1"), flat("b", "s2", "2026-08"), flat("c", "s1")],
      nextCursor: "next",
    });
    expect(page.nextCursor).toBe("next");
    expect(page.statements.map((s) => [s.id, s.transactions.map((r) => r.id), s.periodMonth])).toEqual([
      ["s1", ["a", "c"], "2026-09"],
      ["s2", ["b"], "2026-08"],
    ]);
  });

  it("names the account of each row from the summary, and totals the open rows", () => {
    const page = readStatementsPage({ transactions: [flat("a", "s1")], nextCursor: null });
    const summaries = readSummaries({
      statements: [
        { id: "s1", periodMonth: "2026-09", bankAccountId: "acc-1", openCount: 4, bankAccount: { id: "acc-1", name: "Yritystili", bankName: null, iban: null, currency: "EUR" } },
        { id: "s2", periodMonth: "2026-08", bankAccountId: "acc-1", openCount: 3, bankAccount: null },
      ],
    });
    expect(applySummaries(page.statements, summaries)[0].bankAccount?.name).toBe("Yritystili");
    expect(feedRows(applySummaries(page.statements, summaries))[0].accountName).toBe("Yritystili");
    expect(openTotal(summaries)).toBe(7);
  });

  it("does not mistake an old-shape answer (full statements) for summaries, nor invent an open count", () => {
    expect(readSummaries({ statements: [statement("s1", [tx("a")])] })).toEqual([]);
    expect(openTotal([])).toBeNull();
    expect(openTotal([{ id: "s1", periodMonth: null, bankAccountId: null, bankAccount: null }])).toBeNull();
  });

  it("pages merge without a repeated row even when the boundary falls inside a statement", () => {
    const first = readStatementsPage({ transactions: [flat("a", "s1"), flat("b", "s1")], nextCursor: "n" });
    const second = readStatementsPage({ transactions: [flat("c", "s1"), flat("d", "s2")], nextCursor: null });
    const merged = mergeStatementsPage(first.statements, second.statements);
    expect(merged.flatMap((s) => s.transactions.map((r) => r.id))).toEqual(["a", "b", "c", "d"]);
  });
});

describe("mergeStatementsPage", () => {
  it("adds the second page without duplicating a statement that straddles the boundary", () => {
    const first = [statement("s1", [tx("a"), tx("b")])];
    const second = [statement("s1", [tx("b"), tx("c")]), statement("s2", [tx("d")], "2026-08")];
    const merged = mergeStatementsPage(first, second);
    expect(merged.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(merged[0].transactions.map((r) => r.id)).toEqual(["a", "b", "c"]);
    const ids = merged.flatMap((s) => s.transactions.map((r) => r.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not change what was passed in", () => {
    const first = [statement("s1", [tx("a")])];
    mergeStatementsPage(first, [statement("s1", [tx("b")])]);
    expect(first[0].transactions.map((r) => r.id)).toEqual(["a"]);
  });

  it("drops a row repeated inside one new statement", () => {
    const merged = mergeStatementsPage([], [statement("s1", [tx("a"), tx("a")])]);
    expect(merged[0].transactions).toHaveLength(1);
  });
});

describe("reuseEqualRows", () => {
  it("keeps the object of every row that did not change, and takes the new one for a changed row", () => {
    const before = [statement("s1", [tx("a"), tx("b")])];
    const after = [statement("s1", [tx("a"), tx("b", { matchStatus: "confirmed" })])];
    const reused = reuseEqualRows(before, after);
    expect(reused[0].transactions[0]).toBe(before[0].transactions[0]);
    expect(reused[0].transactions[1]).toBe(after[0].transactions[1]);
    expect(reused[0].transactions[1].matchStatus).toBe("confirmed");
  });

  it("lets the list render a single changed row: feedRows hands back the same FeedRow for the rest", () => {
    const before = [statement("s1", [tx("a"), tx("b"), tx("c")])];
    const rowsBefore = feedRows(before);
    const after = reuseEqualRows(before, [statement("s1", [tx("a"), tx("b", { amount: -99 }), tx("c")])]);
    const rowsAfter = feedRows(after);
    const same = rowsAfter.filter((row) => rowsBefore.includes(row)).map((row) => row.id);
    expect(same.sort()).toEqual(["a", "c"]);
    expect(rowsAfter.find((row) => row.id === "b")?.amount).toBe(-99);
  });
});
