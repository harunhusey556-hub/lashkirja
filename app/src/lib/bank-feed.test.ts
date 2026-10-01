import { describe, expect, it } from "vitest";
import type { StatementData, StatementTransaction } from "@/lib/statement-client";
import { feedRows, groupByMonth, matchesSearch, needsAction, rowState, unlinkMessage, unlinkedRowPatch } from "./bank-feed";

function row(overrides: Partial<StatementTransaction> = {}): StatementTransaction {
  return {
    id: "tx",
    date: "2026-09-10T00:00:00.000Z",
    counterparty: "Prisma",
    amount: -12.5,
    reference: null,
    message: null,
    type: "meno",
    matchStatus: "unmatched",
    receiptId: null,
    receipt: null,
    suggestedReceiptId: null,
    suggestedReceipt: null,
    ...overrides,
  };
}

function statement(id: string, periodMonth: string | null, transactions: StatementTransaction[]): StatementData {
  return {
    id,
    fileName: `${id}.csv`,
    fileType: "enablebanking",
    uploadedAt: "2026-09-30T00:00:00.000Z",
    periodMonth,
    bankAccountId: null,
    bankAccount: null,
    transactions,
    totals: { income: 0, expenses: 0, transfers: 0, net: 0, txCount: transactions.length },
  };
}

describe("rowState", () => {
  it("names a recognised sale apart from an ordinary suggestion", () => {
    const draft = { id: "r1", vendor: "MobilePay", totalAmount: 65, date: null, source: "auto_income" };
    expect(rowState(row({ matchStatus: "suggested", suggestedReceiptId: "r1", suggestedReceipt: draft }))).toBe("sale");
    expect(
      rowState(row({ matchStatus: "suggested", suggestedReceiptId: "r2", suggestedReceipt: { ...draft, source: "manual" } }))
    ).toBe("suggested");
  });

  it("never asks for a document for own transfers or wages", () => {
    expect(rowState(row({ type: "oma_siirto" }))).toBe("transfer");
    expect(needsAction(row({ type: "palkka" }))).toBe(false);
  });

  it("treats linked and ignored rows as done", () => {
    expect(needsAction(row({ matchStatus: "confirmed" }))).toBe(false);
    expect(needsAction(row({ matchStatus: "ignored" }))).toBe(false);
    expect(needsAction(row())).toBe(true);
  });
});

describe("feedRows and groupByMonth", () => {
  it("lists the newest month first and the newest row first inside it", () => {
    const rows = feedRows([
      statement("aug", "2026-08", [row({ id: "a1", date: "2026-08-02T00:00:00.000Z" })]),
      statement("sep", "2026-09", [
        row({ id: "s1", date: "2026-09-01T00:00:00.000Z", matchStatus: "confirmed" }),
        row({ id: "s2", date: "2026-09-20T00:00:00.000Z" }),
        row({ id: "s0", date: null }),
      ]),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["s2", "s1", "s0", "a1"]);

    const months = groupByMonth(rows);
    expect(months.map((m) => [m.month, m.rows.length, m.open])).toEqual([
      ["2026-09", 3, 2],
      ["2026-08", 1, 1],
    ]);
  });

  it("merges two accounts' statements of the same month into one group", () => {
    const months = groupByMonth(
      feedRows([
        statement("a", "2026-09", [row({ id: "1", date: "2026-09-05T00:00:00.000Z" })]),
        statement("b", "2026-09", [row({ id: "2", date: "2026-09-06T00:00:00.000Z" })]),
      ])
    );
    expect(months).toHaveLength(1);
    expect(months[0].rows.map((r) => r.id)).toEqual(["2", "1"]);
  });
});

describe("matchesSearch", () => {
  const [feedRow] = feedRows([statement("s", "2026-09", [row({ counterparty: "MobilePay", amount: 65 })])]);

  it("finds a row by name or by the amount written either way", () => {
    expect(matchesSearch(feedRow, "mobile")).toBe(true);
    expect(matchesSearch(feedRow, "65,00")).toBe(true);
    expect(matchesSearch(feedRow, "65.00")).toBe(true);
    expect(matchesSearch(feedRow, "prisma")).toBe(false);
  });
});

describe("V29: after Poista linkitys", () => {
  const receipt = { id: "r1", vendor: "MobilePay", totalAmount: 125.5, date: "2026-09-20" };

  it("a restored sale puts the row back to the state that offers Hyväksy", () => {
    const patch = unlinkedRowPatch(receipt, true);
    const after = { ...row({ matchStatus: "confirmed", receiptId: "r1", receipt }), ...patch };
    expect(rowState(after)).toBe("sale");
    expect(needsAction(after)).toBe(true);
  });

  it("an ordinary kuitti leaves the row open as a missing one", () => {
    const after = { ...row({ matchStatus: "confirmed", receiptId: "r1", receipt }), ...unlinkedRowPatch(receipt, false) };
    expect(rowState(after)).toBe("missing");
  });

  it("says in one sentence that the sale is out of the books", () => {
    expect(unlinkMessage(true)).toBe("Linkitys poistettu. Myynti ei ole kirjanpidossa, ennen kuin hyväksyt sen uudelleen.");
    expect(unlinkMessage(false)).toBe("Linkitys poistettu.");
  });
});
