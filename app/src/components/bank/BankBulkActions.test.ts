import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// vi.mock is hoisted above the imports, so the factory loads React itself.
vi.mock("next/link", async () => {
  const react = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      react.createElement("a", { href, ...rest }, children as never),
  };
});

import { BankBulkBar, approvableCount, confirmCount } from "./BankBulkActions";
import { BankFeedRow } from "./BankFeedRow";
import { planBulk, type BulkPlan } from "@/lib/bank-bulk";
import { feedRows } from "@/lib/bank-feed";
import type { StatementData, StatementTransaction } from "@/lib/statement-client";

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

const receipt = (id: string) => ({ id, vendor: "K", totalAmount: 10, date: null });

function plannedFor(...transactions: StatementTransaction[]): { plan: BulkPlan; rows: ReturnType<typeof feedRows> } {
  const statement: StatementData = {
    id: "s1",
    fileName: "s.csv",
    fileType: "csv",
    uploadedAt: "2026-10-01T00:00:00.000Z",
    periodMonth: "2026-09",
    bankAccountId: null,
    bankAccount: null,
    transactions,
    totals: { income: 0, expenses: 0, transfers: 0, net: 0, txCount: transactions.length },
  };
  const rows = feedRows([statement]);
  return { plan: planBulk(rows), rows };
}

const bar = (plan: BulkPlan, count: number, busy: "approve" | null = null) =>
  renderToStaticMarkup(
    createElement(BankBulkBar, { visible: true, count, plan, busy, onCancel: () => {}, onRequest: () => {} })
  );

describe("BankBulkBar", () => {
  const suggested = (id: string, receiptId: string) =>
    tx(id, { matchStatus: "suggested", suggestedReceiptId: receiptId, suggestedReceipt: receipt(receiptId) });

  it("shows the selection count and the approve action with the number of suggestions it will accept", () => {
    const { plan } = plannedFor(suggested("a", "r1"), suggested("b", "r2"), tx("c"));
    const out = bar(plan, 3);
    expect(out).toContain("3 valittu");
    expect(out).toContain("Hyväksy ehdotukset (2)");
    expect(out).toContain("Hylkää valitut (2)");
    // "c" is an open row: it can be marked an own transfer, but it has no suggestion or candidate.
    expect(out).toContain("Oma siirto (3)");
    expect(out).not.toContain("Kohdista valitut");
    expect(out).toContain('aria-label="Valitut pankkitapahtumat"');
    expect(out).toContain("Peruuta");
  });

  it("offers Kohdista valitut only when a selected row has a candidate", () => {
    const candidate = { score: 80, reasons: [], receipt: receipt("r9") };
    const { plan } = plannedFor(tx("a", { matchCandidates: [candidate] }));
    expect(bar(plan, 1)).toContain("Kohdista valitut (1)");
  });

  it("says so when nothing selected can be acted on, instead of showing dead buttons", () => {
    const { plan } = plannedFor(tx("done", { matchStatus: "confirmed", receiptId: "r1", receipt: receipt("r1") }));
    const out = bar(plan, 1);
    expect(out).toContain("Valituille ei ole toimintoa.");
    expect(out).not.toContain("Hyväksy ehdotukset");
  });

  it("shows the busy label on the running action and disables the rest", () => {
    const { plan } = plannedFor(suggested("a", "r1"));
    const out = bar(plan, 1, "approve");
    expect(out).toContain("Hyväksytään…");
    expect(out).toContain("disabled");
  });

  it("renders nothing when no row is selected", () => {
    const { plan } = plannedFor();
    const out = renderToStaticMarkup(
      createElement(BankBulkBar, { visible: false, count: 0, plan, busy: null, onCancel: () => {}, onRequest: () => {} })
    );
    expect(out).toBe("");
  });
});

describe("confirmCount", () => {
  it("counts what each confirmation will touch", () => {
    const { plan } = plannedFor(
      tx("a", { matchStatus: "suggested", suggestedReceiptId: "r1", suggestedReceipt: receipt("r1") }),
      tx("b", { type: "tulo", amount: 20, matchStatus: "suggested", suggestedReceiptId: "r2", suggestedReceipt: { ...receipt("r2"), source: "auto_income" } }),
      tx("c")
    );
    expect(approvableCount(plan)).toBe(2);
    expect(confirmCount("approve", plan)).toBe(2);
    expect(confirmCount("reject", plan)).toBe(2);
    expect(confirmCount("transfer", plan)).toBe(3);
    expect(confirmCount("match", plan)).toBe(0);
  });
});

describe("BankFeedRow", () => {
  const row = feedRows([
    {
      id: "s1",
      fileName: "s.csv",
      fileType: "csv",
      uploadedAt: "2026-10-01T00:00:00.000Z",
      periodMonth: "2026-09",
      bankAccountId: null,
      bankAccount: null,
      transactions: [tx("a", { counterparty: "Kahvila Oy", amount: -12.5 })],
      totals: { income: 0, expenses: 0, transfers: 0, net: 0, txCount: 1 },
    },
  ])[0];
  const render = (selectMode: boolean, selected = false) =>
    renderToStaticMarkup(
      createElement(BankFeedRow, {
        row,
        leaving: false,
        done: false,
        swap: false,
        selectMode,
        selected,
        onOpen: () => {},
        onToggle: () => {},
      })
    );

  it("is a plain row outside select mode", () => {
    const out = render(false);
    expect(out).toContain("Kahvila Oy");
    expect(out).not.toContain('type="checkbox"');
  });

  it("carries a named checkbox in select mode, checked when selected", () => {
    const off = render(true, false);
    expect(off).toContain('type="checkbox"');
    expect(off).toContain('aria-label="Valitse Kahvila Oy"');
    expect(off).not.toContain('checked=""');
    expect(render(true, true)).toContain('checked=""');
  });
});
