import { describe, expect, it } from "vitest";
import { postAll, postDocument, UnbalancedEntryError, type SourceDocument } from "./posting";
import { balanceSheet, generalLedger, incomeStatement, trialBalance } from "./reports";

const sum = (doc: SourceDocument) => {
  const entry = postDocument(doc);
  return {
    entry,
    debit: entry.lines.reduce((total, line) => total + line.debitCents, 0),
    credit: entry.lines.reduce((total, line) => total + line.creditCents, 0),
    by: Object.fromEntries(entry.lines.map((line) => [line.account, line.debitCents - line.creditCents])),
  };
};

describe("postDocument", () => {
  it("books a sales invoice to receivables, sales per rate and output VAT", () => {
    const { debit, credit, by } = sum({
      kind: "sales_invoice", id: "i1", date: "2026-09-01", label: "Lasku 1",
      breakdown: [{ rate: 25.5, netCents: 10_000, vatCents: 2_550 }, { rate: 13.5, netCents: 1_000, vatCents: 135 }],
    });
    expect(debit).toBe(credit);
    expect(by).toEqual({ "1700": 13_685, "3000": -10_000, "3001": -1_000, "2939": -2_685 });
  });

  it("reverses a credit note's negative rows", () => {
    const { by } = sum({ kind: "sales_invoice", id: "c1", date: "2026-09-02", label: "Hyvitys", breakdown: [{ rate: 25.5, netCents: -1_000, vatCents: -255 }] });
    expect(by).toEqual({ "1700": -1_255, "3000": 1_000, "2939": 255 });
  });

  it("books a domestic receipt paid from the bank: expense, deductible VAT, bank", () => {
    const { by } = sum({
      kind: "receipt", id: "r1", date: "2026-09-03", label: "K-Market", type: "meno", category: "tarvikkeet",
      grossCents: 12_550, vatLines: [{ rate: 25.5, amountCents: 2_550 }], vatTreatment: "domestic", paidFromBank: true,
    });
    expect(by).toEqual({ "4000": 10_000, "1763": 2_550, "1910": -12_550 });
  });

  it("puts a receipt with no known payment on the suspense account", () => {
    const { by } = sum({
      kind: "receipt", id: "r2", date: "2026-09-03", label: "Kahvila", type: "meno", category: null,
      grossCents: 500, vatLines: null, vatTreatment: "domestic", paidFromBank: false,
    });
    expect(by).toEqual({ "7999": 500, "2990": -500 });
  });

  it("self-assesses reverse charge on both sides, and never deducts OSS VAT", () => {
    expect(sum({
      kind: "receipt", id: "r3", date: "2026-08-07", label: "Shopify", type: "meno", category: "ohjelmistot",
      grossCents: 30_542, vatLines: [{ rate: 0, amountCents: 0 }], vatTreatment: "eu_service", paidFromBank: true,
    }).by).toEqual({ "7680": 30_542, "1763": 7_788, "2939": -7_788, "1910": -30_542 });
    expect(sum({
      kind: "receipt", id: "r4", date: "2026-09-27", label: "Anthropic", type: "meno", category: "ohjelmistot",
      grossCents: 22_590, vatLines: [{ rate: 25.5, amountCents: 4_590 }], vatTreatment: "foreign_vat_charged", paidFromBank: false,
    }).by).toEqual({ "7680": 22_590, "2990": -22_590 });
  });

  it("books income receipts per rate with the rounding rest on the largest line", () => {
    const { debit, credit, by } = sum({
      kind: "receipt", id: "r5", date: "2026-09-04", label: "Myynti", type: "tulo", category: "myynti",
      grossCents: 10_001, vatLines: [{ rate: 25.5, amountCents: 2_032 }], vatTreatment: "domestic", paidFromBank: true,
    });
    expect(debit).toBe(credit);
    expect(by["1910"]).toBe(10_001);
    expect(by["2939"]).toBe(-2_032);
    expect(by["3000"]).toBe(-7_969);
  });

  it("books a purchase invoice and its payment through payables", () => {
    expect(sum({ kind: "purchase_invoice", id: "p1", date: "2026-09-05", label: "Tukku", category: "tarvikkeet", grossCents: 12_400, vatCents: 2_519, vatTreatment: "domestic" }).by)
      .toEqual({ "4000": 9_881, "1763": 2_519, "2871": -12_400 });
    expect(sum({ kind: "purchase_payment", id: "pp1", date: "2026-09-20", label: "Tukku", amountCents: 12_400 }).by)
      .toEqual({ "2871": 12_400, "1910": -12_400 });
    expect(sum({ kind: "invoice_payment", id: "ip1", date: "2026-09-21", label: "Lasku 1", amountCents: 13_685 }).by)
      .toEqual({ "1910": 13_685, "1700": -13_685 });
  });

  it("refuses an entry that would not balance", () => {
    expect(() => postDocument({
      kind: "receipt", id: "bad", date: "2026-09-01", label: "x", type: "tulo", category: null,
      grossCents: Number.NaN, vatLines: null, vatTreatment: "domestic", paidFromBank: true,
    })).toThrow();
    expect(new UnbalancedEntryError("e", 1).message).toContain("ei täsmää");
  });
});

describe("reports", () => {
  const entries = postAll([
    { kind: "sales_invoice", id: "i1", date: "2025-12-15", label: "Lasku 0", breakdown: [{ rate: 25.5, netCents: 5_000, vatCents: 1_275 }] },
    { kind: "sales_invoice", id: "i2", date: "2026-09-01", label: "Lasku 1", breakdown: [{ rate: 25.5, netCents: 10_000, vatCents: 2_550 }] },
    { kind: "invoice_payment", id: "ip", date: "2026-09-10", label: "Lasku 1", amountCents: 12_550 },
    { kind: "receipt", id: "r1", date: "2026-09-03", label: "K-Market", type: "meno", category: "tarvikkeet", grossCents: 1_255, vatLines: [{ rate: 25.5, amountCents: 255 }], vatTreatment: "domestic", paidFromBank: true },
  ]);

  it("the trial balance balances", () => {
    const rows = trialBalance(entries);
    expect(rows.reduce((total, row) => total + row.balanceCents, 0)).toBe(0);
  });

  it("the income statement and the balance sheet agree, and the sheet balances", () => {
    const income = incomeStatement(entries.filter((entry) => entry.date >= "2026-01-01"));
    expect(income.revenueCents).toBe(10_000);
    expect(income.expensesCents).toBe(1_000);
    expect(income.resultCents).toBe(9_000);
    const sheet = balanceSheet(entries, "2026-01-01", "2027-01-01");
    expect(sheet.assetsCents).toBe(sheet.liabilitiesAndEquityCents);
    expect(sheet.equity.find((line) => line.code === "2250")?.cents).toBe(5_000);
    expect(sheet.equity.find((line) => line.code === "2370")?.cents).toBe(9_000);
  });

  it("the general ledger keeps a running balance per account", () => {
    const bank = generalLedger(entries).find((account) => account.code === "1910")!;
    expect(bank.lines.map((line) => line.runningCents)).toEqual([-1_255, 11_295]);
    expect(bank.balanceCents).toBe(11_295);
  });
});
