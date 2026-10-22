import { describe, expect, it } from "vitest";
import { buildProfitLoss, periodToEuros, UNCATEGORISED, type ReportPurchaseInvoice, type ReportReceipt } from "./reports";

const vat = (rate: number, amount: number) => JSON.stringify([{ rate, amount }]);

const receipt = (overrides: Partial<ReportReceipt> = {}): ReportReceipt => ({
  type: "meno",
  date: "2026-01-15T00:00:00.000Z",
  totalAmountCents: 12_550,
  category: "tarvikkeet",
  vatDetails: vat(25.5, 25.5),
  ...overrides,
});

describe("buildProfitLoss", () => {
  it("separates income from expenses and nets out VAT", () => {
    const result = buildProfitLoss([
      receipt({ type: "tulo", totalAmountCents: 125_50, vatDetails: vat(25.5, 25.5) }),
      receipt({ type: "meno", totalAmountCents: 62_75, vatDetails: vat(25.5, 12.75) }),
    ]);

    expect(result.total.incomeGrossCents).toBe(125_50);
    expect(result.total.incomeVatCents).toBe(25_50);
    expect(result.total.incomeNetCents).toBe(100_00);
    expect(result.total.expenseGrossCents).toBe(62_75);
    expect(result.total.expenseNetCents).toBe(50_00);
    expect(result.total.profitNetCents).toBe(50_00);
    expect(result.total.profitGrossCents).toBe(62_75);
  });

  it("counts a receipt with no VAT breakdown at gross and flags it", () => {
    const result = buildProfitLoss([
      receipt({ type: "meno", totalAmountCents: 100_00, vatDetails: null }),
    ]);
    expect(result.total.expenseGrossCents).toBe(100_00);
    expect(result.total.expenseVatCents).toBe(0);
    expect(result.total.expenseNetCents).toBe(100_00);
    expect(result.total.missingVatCount).toBe(1);
  });

  it("ignores unparsable VAT details rather than throwing", () => {
    const result = buildProfitLoss([
      receipt({ vatDetails: "{not json" }),
      receipt({ vatDetails: "[]" }),
      receipt({ vatDetails: JSON.stringify([{ rate: "x", amount: "y" }]) }),
    ]);
    expect(result.total.missingVatCount).toBe(3);
    expect(result.total.expenseVatCents).toBe(0);
  });

  it("sums several VAT rates on one receipt", () => {
    const result = buildProfitLoss([
      receipt({
        totalAmountCents: 200_00,
        vatDetails: JSON.stringify([
          { rate: 25.5, amount: 25.5 },
          { rate: 14, amount: 7 },
        ]),
      }),
    ]);
    expect(result.total.expenseVatCents).toBe(32_50);
  });

  it("treats a negative stored amount as its magnitude", () => {
    const result = buildProfitLoss([
      receipt({ totalAmountCents: -50_00, vatDetails: null }),
    ]);
    expect(result.total.expenseGrossCents).toBe(50_00);
  });

  it("skips receipts with no amount at all", () => {
    const result = buildProfitLoss([receipt({ totalAmountCents: null })]);
    expect(result.total.receiptCount).toBe(0);
  });

  it("groups by category, biggest first, and labels the missing ones", () => {
    const result = buildProfitLoss([
      receipt({ category: "vuokra", totalAmountCents: 500_00, vatDetails: null }),
      receipt({ category: "tarvikkeet", totalAmountCents: 100_00, vatDetails: null }),
      receipt({ category: "tarvikkeet", totalAmountCents: 50_00, vatDetails: null }),
      receipt({ category: "   ", totalAmountCents: 10_00, vatDetails: null }),
      receipt({ category: null, totalAmountCents: 5_00, vatDetails: null }),
    ]);

    expect(result.total.expenseByCategory.map((row) => row.category)).toEqual([
      "vuokra",
      "tarvikkeet",
      UNCATEGORISED,
    ]);
    expect(result.total.expenseByCategory[1]).toMatchObject({
      grossCents: 150_00,
      count: 2,
    });
    expect(result.total.uncategorisedCount).toBe(2);
  });

  it("splits into months in chronological order and keeps the totals consistent", () => {
    const result = buildProfitLoss([
      receipt({ date: "2026-03-01", totalAmountCents: 30_00, vatDetails: null }),
      receipt({ date: "2026-01-31", totalAmountCents: 10_00, vatDetails: null }),
      receipt({ date: "2026-02-15", totalAmountCents: 20_00, vatDetails: null }),
      receipt({ date: "2026-02-20", type: "tulo", totalAmountCents: 100_00, vatDetails: null }),
    ]);

    expect(result.months.map((month) => month.month)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
    ]);
    expect(result.months[1]).toMatchObject({
      expenseGrossCents: 20_00,
      incomeGrossCents: 100_00,
      profitGrossCents: 80_00,
    });
    const summed = result.months.reduce((sum, month) => sum + month.expenseGrossCents, 0);
    expect(summed).toBe(result.total.expenseGrossCents);
  });

  it("counts undated receipts in the total but in no month", () => {
    const result = buildProfitLoss([
      receipt({ date: null, totalAmountCents: 40_00, vatDetails: null }),
      receipt({ date: "2026-01-05", totalAmountCents: 10_00, vatDetails: null }),
    ]);
    expect(result.undatedCount).toBe(1);
    expect(result.total.expenseGrossCents).toBe(50_00);
    expect(result.months).toHaveLength(1);
    expect(result.months[0].expenseGrossCents).toBe(10_00);
  });

  it("returns an empty but well-formed report for no receipts", () => {
    const result = buildProfitLoss([]);
    expect(result.months).toEqual([]);
    expect(result.total.profitNetCents).toBe(0);
    expect(result.total.expenseByCategory).toEqual([]);
  });

  it("uses UTC month boundaries", () => {
    const result = buildProfitLoss([
      receipt({ date: "2026-01-31T23:59:59.000Z", vatDetails: null }),
      receipt({ date: "2026-02-01T00:00:00.000Z", vatDetails: null }),
    ]);
    expect(result.months.map((month) => month.month)).toEqual(["2026-01", "2026-02"]);
  });
});

describe("buildProfitLoss with purchase invoices", () => {
  const purchase = (overrides: Partial<ReportPurchaseInvoice> = {}): ReportPurchaseInvoice => ({
    issueDate: "2026-03-01T00:00:00.000Z",
    category: "vuokra",
    grossCents: 80_000,
    vatCents: 0,
    ...overrides,
  });

  it("counts a purchase invoice as an expense of its invoice month, in its category", () => {
    const result = buildProfitLoss([], [], [purchase(), purchase({ issueDate: "2026-04-02T00:00:00.000Z", grossCents: 12_400, vatCents: 2_519, category: "tarvikkeet" })]);
    expect(result.total).toMatchObject({
      expenseGrossCents: 92_400,
      expenseVatCents: 2_519,
      expenseNetCents: 89_881,
      profitNetCents: -89_881,
      purchaseInvoiceCount: 2,
      receiptCount: 0,
    });
    expect(result.months.map((month) => [month.month, month.expenseNetCents, month.purchaseInvoiceCount])).toEqual([
      ["2026-03", 80_000, 1],
      ["2026-04", 9_881, 1],
    ]);
    expect(result.total.expenseByCategory.map((row) => [row.category, row.netCents, row.count])).toEqual([
      ["vuokra", 80_000, 1],
      ["tarvikkeet", 9_881, 1],
    ]);
  });

  it("adds them to the receipts of the same category and keeps the document counts apart", () => {
    const result = buildProfitLoss([receipt({ category: "vuokra", totalAmountCents: 10_000, vatDetails: null })], [], [purchase()]);
    expect(result.total.expenseByCategory).toEqual([{ category: "vuokra", grossCents: 90_000, vatCents: 0, netCents: 90_000, count: 2 }]);
    expect(result.total.receiptCount).toBe(1);
    expect(result.total.purchaseInvoiceCount).toBe(1);
  });

  it("takes a supplier credit note off the expenses and puts a missing category under Luokittelematon", () => {
    const result = buildProfitLoss([], [], [
      purchase({ category: null, grossCents: 12_550, vatCents: 2_550 }),
      purchase({ category: " ", grossCents: -2_510, vatCents: -510 }),
    ]);
    expect(result.total).toMatchObject({ expenseGrossCents: 10_040, expenseVatCents: 2_040, expenseNetCents: 8_000, uncategorisedCount: 2 });
    expect(result.total.expenseByCategory[0]).toMatchObject({ category: UNCATEGORISED, netCents: 8_000, count: 2 });
    expect(result.total.incomeGrossCents).toBe(0);
  });

  it("reports the purchase invoice count in euros-facing shape", () => {
    expect(periodToEuros(buildProfitLoss([], [], [purchase()]).total).purchaseInvoiceCount).toBe(1);
  });
});

describe("periodToEuros", () => {
  it("converts every cent field to euros", () => {
    const result = buildProfitLoss([
      receipt({ type: "tulo", totalAmountCents: 125_50, vatDetails: vat(25.5, 25.5) }),
    ]);
    const euros = periodToEuros(result.total);
    expect(euros.incomeGross).toBe(125.5);
    expect(euros.incomeVat).toBe(25.5);
    expect(euros.incomeNet).toBe(100);
    expect(euros.incomeByCategory[0]).toMatchObject({ gross: 125.5, net: 100 });
  });
});
