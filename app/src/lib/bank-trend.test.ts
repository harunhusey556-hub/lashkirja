import { describe, expect, it } from "vitest";
import { balanceTrendPoints, trendAriaLabel, trendCaption } from "./bank-trend";

const eur = (v: number) => `${v.toFixed(2).replace(".", ",")} €`;

describe("balanceTrendPoints", () => {
  it("returns nothing under three points", () => {
    expect(balanceTrendPoints([])).toEqual([]);
    expect(balanceTrendPoints([1, 2])).toEqual([]);
  });
  it("keeps the last six, oldest first", () => {
    expect(balanceTrendPoints([1, 2, 3, 4, 5, 6, 7, 8])).toEqual([3, 4, 5, 6, 7, 8]);
    expect(balanceTrendPoints([5, 6, 7])).toEqual([5, 6, 7]);
  });
});

describe("trend wording", () => {
  it("names the real month count", () => {
    expect(trendCaption(6)).toBe("6 kk saldo");
    expect(trendCaption(4)).toBe("4 kk saldo");
  });
  it("says rose, fell or stayed", () => {
    expect(trendAriaLabel([100, 150, 300], "EUR", eur)).toBe("Saldo 3 kuukauden ajalta: nousi 200,00 €.");
    expect(trendAriaLabel([300, 150, 100], "EUR", eur)).toBe("Saldo 3 kuukauden ajalta: laski 200,00 €.");
    expect(trendAriaLabel([100, 150, 100], "EUR", eur)).toBe("Saldo 3 kuukauden ajalta: pysyi ennallaan.");
    expect(trendAriaLabel([100, 150, 300], "USD", eur)).toBe("Saldo 3 kuukauden ajalta: nousi.");
  });
});
