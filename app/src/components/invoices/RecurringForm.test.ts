import { describe, expect, it } from "vitest";
import {
  emptyRecurringForm,
  newRecurringLine,
  recurringFieldOrder,
  recurringVatOptions,
  validateRecurringForm,
  type RecurringFormValues,
} from "./RecurringForm";

function values(patch: Partial<RecurringFormValues> = {}): RecurringFormValues {
  const base = emptyRecurringForm();
  return {
    ...base,
    customerId: "customer-1",
    startDate: "2026-09-01",
    lines: [{ description: "Ylläpito", quantity: "1", unit: "kpl", unitPrice: "100", vatRate: 25.5 }],
    ...patch,
  };
}

describe("a recurring template and the seller's VAT status (F01)", () => {
  it("starts a new line at ALV 0 % for a seller who is not VAT registered", () => {
    expect(newRecurringLine(false).vatRate).toBe(0);
    expect(newRecurringLine(true).vatRate).toBe(25.5);
    expect(emptyRecurringForm(false).lines[0].vatRate).toBe(0);
    expect(emptyRecurringForm().lines[0].vatRate).toBe(25.5);
  });

  it("saves 0 % whatever the line holds", () => {
    const result = validateRecurringForm(values(), { vatRegistered: false });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.lines[0].vatRate).toBe(0);
  });
});

describe("a recurring template and the end of 14 % (F44)", () => {
  const line14 = [{ description: "Ylläpito", quantity: "1", unit: "kpl", unitPrice: "10", vatRate: 14 }];

  it("refuses 14 % when the first invoice is dated in 2026", () => {
    const result = validateRecurringForm(values({ lines: line14 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors["line-0-vatRate"]).toContain("13,5");
      expect(recurringFieldOrder(1)).toContain("line-0-vatRate");
    }
  });

  it("accepts 14 % when the first invoice is dated in 2025", () => {
    expect(validateRecurringForm(values({ startDate: "2025-12-01", lines: line14 })).ok).toBe(true);
  });

  it("follows the first run, not only the start date", () => {
    // Starts 20.12.2025 but bills on the 5th: the first invoice is 5.1.2026.
    const result = validateRecurringForm(
      values({ startDate: "2025-12-20", anchorDay: "5", lines: line14 })
    );
    expect(result.ok).toBe(false);
  });

  it("offers 13,5 % and not 14 % for a 2026 schedule, but keeps a saved 14 % visible", () => {
    expect(recurringVatOptions(25.5, values())).toEqual([255, 135, 100, 0]);
    expect(recurringVatOptions(14, values())).toEqual([255, 135, 100, 0, 140]);
    expect(recurringVatOptions(25.5, values({ startDate: "2025-12-01" }))).toEqual([255, 140, 100, 0]);
  });
});
