import { describe, expect, it } from "vitest";
import { firstInvalidKey } from "@/lib/focus-field";
import {
  EMPTY_LINE,
  invoiceFieldId,
  invoiceFieldOrder,
  newInvoiceLine,
  previewTotals,
  validateInvoiceForm,
  vatRateOptions,
  type InvoiceFormValues,
} from "./InvoiceForm";

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

function values(patch: Partial<InvoiceFormValues> = {}): InvoiceFormValues {
  return {
    customerId: "customer-1",
    issueDate: "2026-03-29",
    dueDate: "2026-04-12",
    notes: "",
    lines: [{ ...EMPTY_LINE, description: "Työ", quantity: "1", unitPrice: "12,50" }],
    ...patch,
  };
}

describe("validateInvoiceForm", () => {
  it("accepts comma, dot and a pasted euro sign as the same money", () => {
    for (const unitPrice of ["12,50", "12.50", "12,50 €", "€12.50"]) {
      const result = validateInvoiceForm(values({ lines: [{ ...EMPTY_LINE, description: "Työ", unitPrice }] }));
      expect(result.ok, unitPrice).toBe(true);
      if (result.ok) expect(result.payload.lines[0].unitPrice).toBe(12.5);
    }
  });

  it("rejects an empty, negative or huge price on the price field", () => {
    const empty = validateInvoiceForm(values({ lines: [{ ...EMPTY_LINE, description: "Työ", unitPrice: "" }] }));
    const negative = validateInvoiceForm(
      values({ lines: [{ ...EMPTY_LINE, description: "Työ", unitPrice: "-1,50" }] })
    );
    const huge = validateInvoiceForm(
      values({ lines: [{ ...EMPTY_LINE, description: "Työ", unitPrice: "999999999" }] })
    );
    const symbol = validateInvoiceForm(
      values({ lines: [{ ...EMPTY_LINE, description: "Työ", unitPrice: "€" }] })
    );
    expect(empty.ok).toBe(false);
    expect(negative.ok).toBe(false);
    expect(huge.ok).toBe(false);
    expect(symbol.ok).toBe(false);
    if (!empty.ok) expect(empty.errors["line-0-unitPrice"]).toMatch(/puuttuu/i);
    if (!negative.ok) expect(negative.errors["line-0-unitPrice"]).toMatch(/negatiivinen/i);
    if (!huge.ok) expect(huge.errors["line-0-unitPrice"]).toMatch(/kelvollinen/i);
  });

  it("rejects a due date before the issue date and an impossible day", () => {
    const due = validateInvoiceForm(values({ issueDate: "2026-04-12", dueDate: "2026-04-01" }));
    const leap = validateInvoiceForm(values({ issueDate: "2025-02-29", dueDate: "2025-03-01" }));
    expect(due.ok).toBe(false);
    expect(leap.ok).toBe(false);
    if (!due.ok) {
      expect(due.errors.dueDate).toMatch(/ennen laskun päivää/);
      expect(firstInvalidKey(due.errors, invoiceFieldOrder(1))).toBe("dueDate");
      expect(invoiceFieldId("dueDate")).toBe("if-due");
    }
    if (!leap.ok) expect(leap.errors.issueDate).toBeTruthy();
  });
});

describe("an invoice from a seller who is not VAT registered (F01)", () => {
  it("starts a new line at ALV 0 %", () => {
    expect(newInvoiceLine(false).vatRate).toBe(0);
    expect(newInvoiceLine(true).vatRate).toBe(25.5);
  });

  it("sends 0 % whatever the line holds", () => {
    const result = validateInvoiceForm(
      values({ lines: [{ ...EMPTY_LINE, description: "Työ", unitPrice: "100", vatRate: 25.5 }] }),
      { vatRegistered: false }
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.lines[0].vatRate).toBe(0);
  });

  it("previews no VAT", () => {
    const totals = previewTotals(
      [{ ...EMPTY_LINE, quantity: "1", unitPrice: "100", vatRate: 25.5 }],
      { vatRegistered: false }
    );
    expect(totals).toEqual({ netCents: 10_000, vatCents: 0, grossCents: 10_000 });
  });
});

describe("the VAT rates offered follow the invoice date (F44, F129)", () => {
  it("offers 13,5 % and not 14 % from 1.1.2026", () => {
    expect(vatRateOptions(25.5, "2026-09-30")).toEqual([255, 135, 100, 0]);
    expect(vatRateOptions(25.5, "2025-12-31")).toEqual([255, 140, 100, 0]);
  });

  it("keeps the line's own rate in the list so the select never shows another one", () => {
    expect(vatRateOptions(14, "2026-09-30")).toEqual([255, 135, 100, 0, 140]);
  });

  it("refuses 14 % on a 2026 invoice and says which rate to use", () => {
    const result = validateInvoiceForm(
      values({ lines: [{ ...EMPTY_LINE, description: "Työ", unitPrice: "10", vatRate: 14 }] })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors["line-0-vatRate"]).toContain("13,5");
      expect(invoiceFieldId("line-0-vatRate")).toBe("if-line-0-vat");
      expect(firstInvalidKey(result.errors, invoiceFieldOrder(1))).toBe("line-0-vatRate");
    }
  });

  it("accepts 14 % on an invoice dated in 2025 and 13,5 % in 2026", () => {
    const old = validateInvoiceForm(
      values({
        issueDate: "2025-12-31",
        dueDate: "2026-01-14",
        lines: [{ ...EMPTY_LINE, description: "Työ", unitPrice: "10", vatRate: 14 }],
      })
    );
    const current = validateInvoiceForm(
      values({ lines: [{ ...EMPTY_LINE, description: "Työ", unitPrice: "10", vatRate: 13.5 }] })
    );
    expect(old.ok).toBe(true);
    expect(current.ok).toBe(true);
  });
});
