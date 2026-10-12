import { describe, it, expect } from "vitest";
import { computeAlvReport, ReceiptLike } from "./alv";

function receipt(
  type: "tulo" | "meno",
  totalAmount: number | null,
  vatDetails: { rate: number; amount: number }[] | null
): ReceiptLike {
  return {
    type,
    totalAmount,
    vatDetails: vatDetails ? JSON.stringify(vatDetails) : null,
  };
}

describe("computeAlvReport", () => {
  it("maps 25,5 % sales to field 301", () => {
    // 125.50 gross = 100 net + 25.50 VAT
    const r = computeAlvReport([
      receipt("tulo", 125.5, [{ rate: 25.5, amount: 25.5 }]),
    ]);
    expect(r.field301).toEqual({ netSales: 100, vat: 25.5 });
    expect(r.field302.vat).toBe(0);
    expect(r.field303.vat).toBe(0);
  });

  it("maps 13,5 % to field 302 and 10 % to field 303 (not 303/305)", () => {
    const r = computeAlvReport([
      receipt("tulo", 113.5, [{ rate: 13.5, amount: 13.5 }]),
      receipt("tulo", 110, [{ rate: 10, amount: 10 }]),
    ]);
    expect(r.field302).toEqual({ netSales: 100, vat: 13.5 });
    expect(r.field303).toEqual({ netSales: 100, vat: 10 });
  });

  it("maps legacy rates 24 % and 14 % into fields 301 and 302", () => {
    const r = computeAlvReport([
      receipt("tulo", 124, [{ rate: 24, amount: 24 }]),
      receipt("tulo", 114, [{ rate: 14, amount: 14 }]),
    ]);
    expect(r.field301.vat).toBe(24);
    expect(r.field302.vat).toBe(14);
  });

  it("puts zero-rated sales turnover into field 309", () => {
    const r = computeAlvReport([
      receipt("tulo", 500, [{ rate: 0, amount: 0 }]),
    ]);
    expect(r.field309.turnover).toBe(500);
    expect(r.field301.vat).toBe(0);
  });

  it("does NOT assume 25,5 % for sales without VAT breakdown — flags for review", () => {
    const r = computeAlvReport([receipt("tulo", 200, null)]);
    expect(r.field301.vat).toBe(0);
    expect(r.review.salesGross).toBe(200);
    expect(r.review.count).toBe(1);
  });

  it("sums deductible VAT from meno receipts into field 307", () => {
    const r = computeAlvReport([
      receipt("meno", 125.5, [{ rate: 25.5, amount: 25.5 }]),
      receipt("meno", 110, [{ rate: 10, amount: 10 }]),
    ]);
    expect(r.field307.amount).toBe(35.5);
  });

  it("flags meno without VAT breakdown for review instead of guessing", () => {
    const r = computeAlvReport([receipt("meno", 99.9, null)]);
    expect(r.field307.amount).toBe(0);
    expect(r.review.purchasesGross).toBe(99.9);
  });

  it("computes 308 = sales VAT − 307 (payable)", () => {
    const r = computeAlvReport([
      receipt("tulo", 251, [{ rate: 25.5, amount: 51 }]),
      receipt("meno", 125.5, [{ rate: 25.5, amount: 25.5 }]),
    ]);
    expect(r.field308).toEqual({ amount: 25.5, isRefund: false });
  });

  it("marks 308 as refund when deductible exceeds sales VAT", () => {
    const r = computeAlvReport([
      receipt("tulo", 125.5, [{ rate: 25.5, amount: 25.5 }]),
      receipt("meno", 502, [{ rate: 25.5, amount: 102 }]),
    ]);
    expect(r.field308).toEqual({ amount: 76.5, isRefund: true });
  });

  it("sends unknown VAT rates to review", () => {
    const r = computeAlvReport([
      receipt("tulo", 121, [{ rate: 21, amount: 21 }]),
    ]);
    expect(r.field301.vat).toBe(0);
    expect(r.review.count).toBe(1);
  });

  it("handles malformed vatDetails JSON as missing", () => {
    const r = computeAlvReport([
      { type: "meno", totalAmount: 50, vatDetails: "not-json" },
    ]);
    expect(r.field307.amount).toBe(0);
    expect(r.review.purchasesGross).toBe(50);
  });

  it("ignores oma_siirto and unknown types", () => {
    const r = computeAlvReport([
      { type: "oma_siirto", totalAmount: 1000, vatDetails: null },
    ]);
    expect(r.review.count).toBe(0);
    expect(r.field308.amount).toBe(0);
  });
});

describe("computeAlvReport with sales invoices", () => {
  const invoice = (lines: Array<[number, number, number]>) => ({
    breakdown: lines.map(([ratePermille, netCents, vatCents]) => ({
      ratePermille,
      netCents,
      vatCents,
    })),
  });

  it("adds invoice VAT to the matching OmaVero field", () => {
    const report = computeAlvReport([], [invoice([[255, 10_000, 2_550]])]);
    expect(report.field301).toEqual({ netSales: 100, vat: 25.5 });
    expect(report.field308).toEqual({ amount: 25.5, isRefund: false });
    expect(report.sources).toEqual({
      receiptSalesVat: 0,
      invoiceSalesVat: 25.5,
      invoiceCount: 1,
      purchaseInvoiceVat: 0,
      purchaseInvoiceCount: 0,
      reverseChargeVat: 0,
      foreignVatNotDeducted: 0,
    });
  });

  it("splits several rates across fields 301, 302 and 303", () => {
    const report = computeAlvReport(
      [],
      [invoice([[255, 10_000, 2_550], [135, 10_000, 1_350], [100, 10_000, 1_000]])]
    );
    expect(report.field301.vat).toBe(25.5);
    expect(report.field302.vat).toBe(13.5);
    expect(report.field303.vat).toBe(10);
    expect(report.field308.amount).toBe(49);
  });

  it("counts a zero-rated invoice line as turnover, not as VAT", () => {
    const report = computeAlvReport([], [invoice([[0, 50_000, 0]])]);
    expect(report.field309.turnover).toBe(500);
    expect(report.field301.vat).toBe(0);
    expect(report.field308.amount).toBe(0);
  });

  it("still maps the legacy 24 % rate to field 301", () => {
    const report = computeAlvReport([], [invoice([[240, 10_000, 2_400]])]);
    expect(report.field301).toEqual({ netSales: 100, vat: 24 });
    expect(report.review.count).toBe(0);
  });

  it("sends an unmappable rate to review instead of a total", () => {
    const report = computeAlvReport([], [invoice([[175, 10_000, 1_750]])]);
    expect(report.review.count).toBe(1);
    expect(report.review.salesGross).toBe(117.5);
    expect(report.field301.vat).toBe(0);
  });

  it("sums receipts and invoices into one return and keeps the origin visible", () => {
    const report = computeAlvReport(
      [
        {
          type: "tulo",
          totalAmount: 125.5,
          vatDetails: JSON.stringify([{ rate: 25.5, amount: 25.5 }]),
        },
        {
          type: "meno",
          totalAmount: 62.75,
          vatDetails: JSON.stringify([{ rate: 25.5, amount: 12.75 }]),
        },
      ],
      [invoice([[255, 20_000, 5_100]])]
    );

    expect(report.sources.receiptSalesVat).toBe(25.5);
    expect(report.sources.invoiceSalesVat).toBe(51);
    expect(report.field301.vat).toBe(76.5);
    expect(report.field307.amount).toBe(12.75);
    expect(report.field308.amount).toBe(63.75);
  });

  it("turns a VAT-heavy purchase month into a refund", () => {
    const report = computeAlvReport(
      [
        {
          type: "meno",
          totalAmount: 1_000,
          vatDetails: JSON.stringify([{ rate: 25.5, amount: 200 }]),
        },
      ],
      [invoice([[255, 10_000, 2_550]])]
    );
    expect(report.field308).toEqual({ amount: 174.5, isRefund: true });
  });

  it("behaves exactly as before when no invoices are passed", () => {
    const receipts = [
      {
        type: "tulo",
        totalAmount: 125.5,
        vatDetails: JSON.stringify([{ rate: 25.5, amount: 25.5 }]),
      },
    ];
    const withoutArgument = computeAlvReport(receipts);
    const withEmptyArray = computeAlvReport(receipts, []);
    expect(withoutArgument).toEqual(withEmptyArray);
    expect(withoutArgument.sources.invoiceCount).toBe(0);
  });
});

describe("computeAlvReport with purchase invoices (F39)", () => {
  it("adds a purchase invoice's VAT to the deductible VAT (field 307)", () => {
    const report = computeAlvReport(
      [receipt("meno", 125.5, [{ rate: 25.5, amount: 25.5 }])],
      [{ breakdown: [{ ratePermille: 255, netCents: 100_000, vatCents: 25_500 }] }],
      [{ vatCents: 2_519 }]
    );
    expect(report.field307.amount).toBe(50.69);
    expect(report.field308).toEqual({ amount: 204.31, isRefund: false });
    expect(report.sources).toMatchObject({ purchaseInvoiceVat: 25.19, purchaseInvoiceCount: 1 });
  });

  it("is unchanged without purchase invoices", () => {
    const receipts = [receipt("meno", 125.5, [{ rate: 25.5, amount: 25.5 }])];
    expect(computeAlvReport(receipts)).toEqual(computeAlvReport(receipts, [], []));
    expect(computeAlvReport(receipts).sources.purchaseInvoiceCount).toBe(0);
  });

  it("can turn a return into a refund", () => {
    const report = computeAlvReport([], [], [{ vatCents: 1_000 }]);
    expect(report.field308).toEqual({ amount: 10, isRefund: true });
  });
});

describe("computeAlvReport — foreign purchases", () => {
  const foreign = (treatment: string, total: number, vat: { rate: number; amount: number }[], date = "2026-09-10"): ReceiptLike => ({
    ...receipt("meno", total, vat),
    vatTreatment: treatment,
    date,
  });

  it("self-assesses EU service VAT into 306 and 314 and deducts it in 307: net zero", () => {
    // Shopify International 305,42 € with reverse charge.
    const r = computeAlvReport([foreign("eu_service", 305.42, [{ rate: 0, amount: 0 }])]);
    expect(r.field306.amount).toBe(77.88);
    expect(r.field314.amount).toBe(305.42);
    expect(r.field307.amount).toBe(77.88);
    expect(r.field308).toEqual({ amount: 0, isRefund: false });
    expect(r.sources.reverseChargeVat).toBe(77.88);
  });

  it("puts EU goods into 305 and 313", () => {
    const r = computeAlvReport([foreign("eu_goods", 100, [])]);
    expect(r.field305.amount).toBe(25.5);
    expect(r.field313.amount).toBe(100);
    expect(r.field306.amount).toBe(0);
    expect(r.field308.amount).toBe(0);
  });

  it("puts tax on non-EU services into 301 without a base", () => {
    const r = computeAlvReport([foreign("non_eu_service", 10, [{ rate: 0, amount: 0 }])]);
    expect(r.field301).toEqual({ netSales: 0, vat: 2.55 });
    expect(r.field307.amount).toBe(2.55);
    expect(r.field308.amount).toBe(0);
  });

  it("uses 24 % for purchases before 1.9.2024", () => {
    const r = computeAlvReport([foreign("eu_service", 100, [], "2024-08-31")]);
    expect(r.field306.amount).toBe(24);
  });

  it("never deducts Finnish VAT a foreign seller charged through OSS", () => {
    // Anthropic Ireland: 180 € + VAT – Finland 25.5 % 45,90 €.
    const r = computeAlvReport([foreign("foreign_vat_charged", 225.9, [{ rate: 25.5, amount: 45.9 }])]);
    expect(r.field307.amount).toBe(0);
    expect(r.sources.foreignVatNotDeducted).toBe(45.9);
    expect(r.review.count).toBe(0);
  });

  it("sends non-EU goods to review instead of guessing import VAT", () => {
    const r = computeAlvReport([foreign("non_eu_goods", 80, [])]);
    expect(r.field307.amount).toBe(0);
    expect(r.review).toEqual({ salesGross: 0, purchasesGross: 80, count: 1 });
  });

  it("treats purchase invoices the same way, and domestic ones as before", () => {
    const r = computeAlvReport([], [], [
      { vatCents: 0, grossCents: 50_00, vatTreatment: "eu_service", date: "2026-09-01" },
      { vatCents: 2_55, grossCents: 12_55 },
    ]);
    expect(r.field306.amount).toBe(12.75);
    expect(r.field307.amount).toBe(15.3);
    expect(r.sources.purchaseInvoiceVat).toBe(2.55);
    expect(r.field308).toEqual({ amount: 2.55, isRefund: true });
  });
});
