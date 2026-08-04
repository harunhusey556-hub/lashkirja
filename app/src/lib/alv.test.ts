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
