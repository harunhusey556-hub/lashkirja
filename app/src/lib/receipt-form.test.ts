import { describe, expect, it } from "vitest";
import { firstInvalidKey } from "./focus-field";
import { receiptCategoryFocusId, receiptFieldId, validateReceiptFields } from "./receipt-form";

describe("validateReceiptFields", () => {
  it("accepts the same money spellings as the invoice form", () => {
    for (const totalAmount of ["12,50", "12.50", "12,50 €", "1 234,50", "1.234,50", "1 234,50"]) {
      expect(
        validateReceiptFields({
          vendor: "Tukku",
          date: "2024-02-29",
          totalAmount,
          category: "tarvikkeet",
        }),
        totalAmount
      ).toEqual({});
    }
  });

  it("names the first bad field for an empty, negative or impossible value", () => {
    const errors = validateReceiptFields({
      vendor: "",
      date: "2025-02-29",
      totalAmount: "-1",
      category: "",
    });
    expect(firstInvalidKey(errors, ["vendor", "date", "totalAmount", "category"])).toBe("vendor");
    expect(receiptFieldId("vendor")).toBe("receipt-vendor");
    expect(errors.date).toBeTruthy();
    expect(errors.totalAmount).toMatch(/nolla|kelvollinen|pakollinen/);
  });
});

describe("receiptCategoryFocusId (V12)", () => {
  it("points at the chip group while no category is chosen, so the refusal can be focused and scrolled to", () => {
    expect(receiptCategoryFocusId({ useCustom: false, hasCategory: false })).toBe("receipt-category-group");
  });

  it("points at the select once a category is chosen, and at the free text for an own category", () => {
    expect(receiptCategoryFocusId({ useCustom: false, hasCategory: true })).toBe("receipt-category");
    expect(receiptCategoryFocusId({ useCustom: true, hasCategory: false })).toBe("receipt-custom-category");
  });
});

describe("validateReceiptFields length limits (F64)", () => {
  const ok = { vendor: "Tukku", date: "2026-01-02", totalAmount: "10", category: "x" };

  it("names the field and the limit the server enforces", () => {
    const errors = validateReceiptFields({
      ...ok,
      vendor: "v".repeat(301),
      reference: "r".repeat(41),
      invoiceNumber: "i".repeat(41),
      notes: "n".repeat(501),
    });
    expect(errors.vendor).toBe("Myyjä saa olla enintään 300 merkkiä.");
    expect(errors.reference).toBe("Viitenumero saa olla enintään 40 merkkiä.");
    expect(errors.invoiceNumber).toBe("Laskun numero saa olla enintään 40 merkkiä.");
    expect(errors.notes).toBe("Selite saa olla enintään 500 merkkiä.");
    expect(receiptFieldId("notes")).toBe("receipt-notes");
  });

  it("accepts values at the limit", () => {
    expect(validateReceiptFields({ ...ok, vendor: "v".repeat(300), notes: "n".repeat(500) })).toEqual({});
  });
});
