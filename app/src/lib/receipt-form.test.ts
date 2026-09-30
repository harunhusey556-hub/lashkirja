import { describe, expect, it } from "vitest";
import { firstInvalidKey } from "./focus-field";
import { receiptFieldId, validateReceiptFields } from "./receipt-form";

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
