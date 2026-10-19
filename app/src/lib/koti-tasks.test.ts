import { describe, expect, it } from "vitest";
import { bankRowAmount, pendingReceiptSecondary } from "./koti-tasks";

describe("Koti task rows", () => {
  it("names the category by its label and says when the receipt is a credit note", () => {
    expect(pendingReceiptSecondary({ amount: 12.4, category: "tarvikkeet", vatRate: 25.5, gaps: [] })).toBe(
      "Tarvikkeet & ostot · ALV 25,5 %"
    );
    expect(pendingReceiptSecondary({ amount: -18.9, category: "tarvikkeet", vatRate: 25.5, gaps: [] })).toBe(
      "Hyvityslasku · Tarvikkeet & ostot · ALV 25,5 %"
    );
    // A category the app does not know shows as stored.
    expect(pendingReceiptSecondary({ amount: 3, category: "Kukat", vatRate: null })).toBe("Kukat");
    expect(pendingReceiptSecondary({ amount: null, category: null, vatRate: null, gaps: ["amount", "vendor"] })).toBe(
      "Lisää summa ja myyjä"
    );
    expect(pendingReceiptSecondary({ amount: 3, category: null, vatRate: null })).toBe("Tarkista luokka ja ALV");
  });

  it("keeps a bank row's sign: money out reads with a minus, money in without", () => {
    expect(bankRowAmount(-5)).toMatch(/^[−-]5,00\s€$/);
    expect(bankRowAmount(401.27)).toMatch(/^401,27\s€$/);
  });
});
