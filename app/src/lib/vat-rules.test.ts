import { describe, it, expect } from "vitest";
import { extractReminderFees, guessVatForReceipt } from "./vat-rules";

describe("extractReminderFees", () => {
  it("finds muistutusmaksu lines", () => {
    const text = `
Lasku yhteensä 125,40 €
Muistutusmaksu 8,00 €
Maksettava 133,40 €
`;
    expect(extractReminderFees(text)).toBe(8);
  });
});

describe("guessVatForReceipt", () => {
  it("does not override explicit VAT breakdown", () => {
    expect(
      guessVatForReceipt({
        category: "tarvikkeet",
        vendor: "Prisma",
        text: "",
        totalAmount: 100,
        existingVatDetails: [{ rate: 25.5, amount: 20.32 }],
      })
    ).toBeNull();
  });

  it("guesses 25.5% for standard purchases", () => {
    const guess = guessVatForReceipt({
      category: "tarvikkeet",
      vendor: "Bauhaus",
      text: "Ostolasku",
      totalAmount: 125.5,
      existingVatDetails: [],
    });
    expect(guess?.vatDetails).toEqual([{ rate: 25.5, amount: 25.5 }]);
    expect(guess?.treatment).toBe("STANDARD_25_5");
  });

  it("marks YEL/insurance as exempt with zero VAT", () => {
    const guess = guessVatForReceipt({
      category: "työeläke",
      vendor: "Varma",
      text: "YEL-vakuutus",
      totalAmount: 149.5,
      existingVatDetails: [],
    });
    expect(guess?.vatDetails).toEqual([{ rate: 0, amount: 0 }]);
    expect(guess?.treatment).toBe("EXEMPT_NO_DEDUCTION");
  });

  it("excludes reminder fees from VAT base", () => {
    const text = `
Helen sähkölasku 62,00 €
Muistutusmaksu 7,50 €
Yhteensä 69,50 €
`;
    const guess = guessVatForReceipt({
      category: "sähkö",
      vendor: "Helen",
      text,
      totalAmount: 69.5,
      existingVatDetails: [],
    });
    expect(guess?.nonDeductibleFee).toBe(7.5);
    expect(guess?.vatDetails[0].amount).toBeCloseTo(12.6, 1);
    expect(guess?.note).toMatch(/Muistutusmaksu/i);
  });
});
