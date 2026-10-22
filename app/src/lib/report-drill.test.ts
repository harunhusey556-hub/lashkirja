import { describe, expect, it } from "vitest";
import {
  drillFromSearch,
  expenseDrillTarget,
  expenseDrillTargets,
  incomeDrillTargets,
  invoiceDrillHref,
  receiptDrillHref,
  statementDrillHref,
} from "./report-drill";
import { DEFAULT_RECEIPT_COUNTS_QUERY, DEFAULT_RECEIPT_QUERY, receiptKindParam } from "./receipt-paging";

describe("report drill links", () => {
  it("round-trips the filters a report amount opens", () => {
    const href = receiptDrillHref({ month: "2026-03", type: "meno", category: "tarvikkeet" });
    expect(href).toBe("/kuitit?month=2026-03&type=meno&category=tarvikkeet&drill=1");
    expect(drillFromSearch(href.split("?")[1])).toEqual({
      month: "2026-03",
      type: "meno",
      category: "tarvikkeet",
      drill: true,
    });
  });

  it("skips an uncategorised label that is not a stored category", () => {
    expect(receiptDrillHref({ month: "2026-03", category: "Luokittelematon" })).toBe("/kuitit?month=2026-03&drill=1");
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
      expect.objectContaining({ id: "income-receipts", label: "Tulokuitit", href: "/kuitit?month=2026-09&type=tulo&drill=1" }),
    ]);
  });

  it("sends receipt-only income to the receipts list", () => {
    const targets = incomeDrillTargets({ month: "2026-03", invoiceCount: 0, creditNoteCount: 0, incomeByCategory: [cashRow] });
    expect(targets.map((target) => target.href)).toEqual(["/kuitit?month=2026-03&type=tulo&drill=1"]);
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
      "/kuitit?month=2026-09&type=meno&drill=1"
    );
    expect(expenseDrillTarget({ month: "2026-09", expenseByCategory: [] })).toBeNull();
  });

  it("sends purchase invoices to their own list, never to an empty receipts list", () => {
    // Four expense rows, one of them a purchase invoice: the receipts list holds three.
    const mixed = { month: "2026-09", purchaseInvoiceCount: 1, expenseByCategory: [{ category: "tarvikkeet", count: 3 }, { category: "vuokra", count: 1 }] };
    expect(expenseDrillTargets(mixed).map((target) => target.id)).toEqual(["expense-receipts", "purchase-invoices"]);
    expect(expenseDrillTargets(mixed).map((target) => target.href)).toEqual(["/kuitit?month=2026-09&type=meno&drill=1", "/kirjanpito/ostolaskut"]);
    // Rent and nothing else: no receipts to open.
    const rentOnly = { month: "2026-09", purchaseInvoiceCount: 1, expenseByCategory: [{ category: "vuokra", count: 1 }] };
    expect(expenseDrillTarget(rentOnly)).toBeNull();
    expect(expenseDrillTargets(rentOnly).map((target) => target.id)).toEqual(["purchase-invoices"]);
    // An older cached report has no purchase invoice count: receipts as before.
    expect(expenseDrillTargets({ month: "2026-09", expenseByCategory: [{ category: "vuokra", count: 1 }] }).map((target) => target.id)).toEqual(["expense-receipts"]);
    expect(expenseDrillTargets({ month: "2026-09", expenseByCategory: [] })).toEqual([]);
  });

  it("lets the invoice list reset a remembered status tab", () => {
    expect(invoiceDrillHref({ month: "2026-09", status: "all" })).toBe("/laskut?month=2026-09&status=all");
    expect(invoiceDrillHref({ status: "credited" })).toBe("/laskut?status=credited");
  });
});

describe("year-level drill links (V44, V45, R60)", () => {
  it("carries the selected year to the receipt and invoice lists", () => {
    expect(receiptDrillHref({ month: "2025", type: "meno" })).toBe("/kuitit?month=2025&type=meno&drill=1");
    expect(drillFromSearch("month=2025&type=tulo")).toEqual({ month: "2025", type: "tulo" });
    expect(invoiceDrillHref({ month: "2025", status: "all" })).toBe("/laskut?month=2025&status=all");
  });

  it("an income category row opens the invoice list on every status", () => {
    expect(invoiceDrillHref({ status: "all" })).toBe("/laskut?status=all");
  });
});

/**
 * X079 (B8): the Menot figure counts the bills filed as ostolaskut, so the list it opens asks for
 * every document. Kuitit then sends no `kind` for the rows or the chip counts (the phone's
 * ReceiptListQuery.drill); its own entry and the review queue still ask for the kuitit.
 */
describe("a figure's list holds every document it counts (X079)", () => {
  it("marks the link as a figure's list and reads that back", () => {
    const href = expenseDrillTarget({ month: "2026-09", expenseByCategory: [{ category: "vuokra", count: 35 }] })?.href ?? "";
    const params = new URLSearchParams(href.split("?")[1]);
    expect(params.get("drill")).toBe("1");
    expect(params.has("kind")).toBe(false);
    expect(drillFromSearch(href.split("?")[1])).toEqual({ month: "2026-09", type: "meno", drill: true });
    // A plain month link (a bookmark from before the flag) is not a figure's list.
    expect(drillFromSearch("month=2026-09").drill).toBeUndefined();
  });

  it("sends no kind for a figure's list or its counts; Kuitit's own entry sends kind=receipt", () => {
    expect(receiptKindParam("receipt", true)).toBeNull();
    expect(receiptKindParam("receipt", false)).toBe("receipt");
    // The Laskut chip lists the bills alone, opened from a figure or not.
    expect(receiptKindParam("invoice", true)).toBe("invoice");
    expect(receiptKindParam("invoice", false)).toBe("invoice");
    // The launch warm-up fills Kuitit's own entry, which still lists the kuitit.
    expect(new URLSearchParams(DEFAULT_RECEIPT_QUERY).get("kind")).toBe(receiptKindParam("receipt", false));
    expect(new URLSearchParams(DEFAULT_RECEIPT_COUNTS_QUERY).get("kind")).toBe(receiptKindParam("receipt", false));
  });
});
