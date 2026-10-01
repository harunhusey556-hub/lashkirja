import { describe, expect, it } from "vitest";
import {
  drillFromSearch,
  expenseDrillTarget,
  incomeDrillTargets,
  invoiceDrillHref,
  receiptDrillHref,
  statementDrillHref,
} from "./report-drill";

describe("report drill links", () => {
  it("round-trips the filters a report amount opens", () => {
    const href = receiptDrillHref({ month: "2026-03", type: "meno", category: "tarvikkeet" });
    expect(href).toBe("/kuitit?month=2026-03&type=meno&category=tarvikkeet");
    expect(drillFromSearch(href.split("?")[1])).toEqual({
      month: "2026-03",
      type: "meno",
      category: "tarvikkeet",
    });
  });

  it("skips an uncategorised label that is not a stored category", () => {
    expect(receiptDrillHref({ month: "2026-03", category: "Luokittelematon" })).toBe("/kuitit?month=2026-03");
    expect(statementDrillHref("2026-03")).toBe("/pankki/tapahtumat?month=2026-03");
    expect(invoiceDrillHref({ month: "2026-03", status: "draft" })).toBe("/laskut?month=2026-03&status=draft");
  });
});

describe("income drill targets (F71)", () => {
  const invoiceRow = { category: "Myyntilaskut", count: 3 };
  const cashRow = { category: "käteismyynti", count: 2 };

  it("sends invoice-only income to the invoice list for that month, never to receipts", () => {
    const targets = incomeDrillTargets({ month: "2026-09", invoiceCount: 3, creditNoteCount: 0, incomeByCategory: [invoiceRow] });
    expect(targets.map((target) => target.href)).toEqual(["/laskut?month=2026-09&status=all"]);
  });

  it("counts a credit note as invoice-list income too", () => {
    const targets = incomeDrillTargets({
      month: "2026-09",
      invoiceCount: 0,
      creditNoteCount: 1,
      incomeByCategory: [{ category: "Hyvityslaskut", count: 1 }],
    });
    expect(targets.map((target) => target.id)).toEqual(["invoices"]);
  });

  it("offers two labelled destinations when income is invoices and cash-sale receipts", () => {
    const targets = incomeDrillTargets({ month: "2026-09", invoiceCount: 3, creditNoteCount: 0, incomeByCategory: [invoiceRow, cashRow] });
    expect(targets).toEqual([
      expect.objectContaining({ id: "invoices", label: "Laskut", href: "/laskut?month=2026-09&status=all" }),
      expect.objectContaining({ id: "income-receipts", label: "Tulokuitit", href: "/kuitit?month=2026-09&type=tulo" }),
    ]);
  });

  it("sends receipt-only income to the receipts list", () => {
    const targets = incomeDrillTargets({ month: "2026-03", invoiceCount: 0, creditNoteCount: 0, incomeByCategory: [cashRow] });
    expect(targets.map((target) => target.href)).toEqual(["/kuitit?month=2026-03&type=tulo"]);
  });

  it("links nothing when there is no income, so no list can claim emptiness", () => {
    expect(incomeDrillTargets({ month: "2026-03", invoiceCount: 0, creditNoteCount: 0, incomeByCategory: [] })).toEqual([]);
    expect(incomeDrillTargets({ month: "2026-03" })).toEqual([]);
  });

  it("drills a whole year without a month parameter", () => {
    const targets = incomeDrillTargets({ invoiceCount: 13, creditNoteCount: 0, incomeByCategory: [{ category: "Myyntilaskut", count: 13 }] });
    expect(targets.map((target) => target.href)).toEqual(["/laskut?status=all"]);
  });

  it("falls back to the category rows when an older cached report has no invoice counts", () => {
    const targets = incomeDrillTargets({ month: "2026-09", incomeByCategory: [invoiceRow] });
    expect(targets.map((target) => target.id)).toEqual(["invoices"]);
  });

  it("keeps expenses on receipts and only when there are some", () => {
    expect(expenseDrillTarget({ month: "2026-09", expenseByCategory: [{ category: "tarvikkeet", count: 4 }] })?.href).toBe(
      "/kuitit?month=2026-09&type=meno"
    );
    expect(expenseDrillTarget({ month: "2026-09", expenseByCategory: [] })).toBeNull();
  });

  it("lets the invoice list reset a remembered status tab", () => {
    expect(invoiceDrillHref({ month: "2026-09", status: "all" })).toBe("/laskut?month=2026-09&status=all");
    expect(invoiceDrillHref({ status: "credited" })).toBe("/laskut?status=credited");
  });
});
