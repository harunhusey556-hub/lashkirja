import { describe, expect, it } from "vitest";
import { EMPTY_LINE, previewTotals } from "./InvoiceForm";

describe("previewTotals", () => {
  it("prices a line written with a Finnish comma", () => {
    const totals = previewTotals([
      {
        ...EMPTY_LINE,
        description: "Ripsienpidennys",
        quantity: "1",
        unitPrice: "12,50",
        vatRate: 25.5,
      },
    ]);
    expect(totals.netCents).toBe(1250);
    expect(totals.vatCents).toBe(319);
    expect(totals.grossCents).toBe(1569);
  });

  it("stays at zero while the price field is empty", () => {
    expect(
      previewTotals([{ ...EMPTY_LINE, quantity: "1", unit: "kpl", unitPrice: "" }])
    ).toEqual({ netCents: 0, vatCents: 0, grossCents: 0 });
  });

  it("does not treat a currency placeholder as a price", () => {
    expect(previewTotals([{ ...EMPTY_LINE, quantity: "1", unitPrice: "€" }])).toEqual({
      netCents: 0,
      vatCents: 0,
      grossCents: 0,
    });
  });

  it("accepts a dot decimal and a zero VAT rate", () => {
    const totals = previewTotals([
      { ...EMPTY_LINE, quantity: "2", unitPrice: "10.00", vatRate: 0 },
    ]);
    expect(totals).toEqual({ netCents: 2000, vatCents: 0, grossCents: 2000 });
  });
});
