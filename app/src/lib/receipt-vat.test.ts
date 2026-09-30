import { describe, expect, it } from "vitest";
import {
  autoVatAmount,
  moneyField,
  parseReceiptAmount,
  syncAutoVat,
  vatMismatchHint,
  vatRowsFromSaved,
  vatLinesProblem,
} from "./receipt-vat";

const NBSP = " ";
const THIN = " ";
const NNBSP = " ";

describe("parseReceiptAmount", () => {
  it("reads every way a Finnish user writes a grouped amount", () => {
    for (const text of [
      "1 234,50",
      "1234,50",
      "1234.50",
      "1.234,50",
      `1${NBSP}234,50`,
      `1${THIN}234,50`,
      `1${NNBSP}234,50`,
      "1,234.50",
      "1 234,50 €",
    ]) {
      expect(parseReceiptAmount(text), text).toBe(1234.5);
    }
  });

  it("keeps empty, junk and ambiguous input null", () => {
    expect(parseReceiptAmount("")).toBeNull();
    expect(parseReceiptAmount("abc")).toBeNull();
    expect(parseReceiptAmount("1,2,3")).toBeNull();
  });

  it("reads several thousands groups", () => {
    expect(parseReceiptAmount("1.234.567,89")).toBe(1234567.89);
    expect(parseReceiptAmount("1 234 567,89")).toBe(1234567.89);
  });
});

describe("autoVatAmount", () => {
  it("computes the VAT inside a gross total, in Finnish format", () => {
    for (const total of ["1 234,50", "1 234.50", `1${NBSP}234,50`, "1234,50", "1.234,50"]) {
      expect(autoVatAmount(total, "25.5"), total).toBe("250,83");
    }
    expect(autoVatAmount("24,90", "13.5")).toBe("2,96");
    expect(autoVatAmount("30,00", "13.5")).toBe("3,57");
    expect(autoVatAmount("12,50", "0")).toBe("0,00");
  });

  it("is null while the total is empty or broken", () => {
    expect(autoVatAmount("", "25.5")).toBeNull();
    expect(autoVatAmount("abc", "25.5")).toBeNull();
    expect(autoVatAmount("10,00", "x")).toBeNull();
  });
});

describe("moneyField", () => {
  it("shows a stored amount the Finnish way", () => {
    expect(moneyField(24.9).replace(/\s/g, " ")).toBe("24,90");
    expect(moneyField(1234.5).replace(/\s/g, " ")).toBe("1 234,50");
    expect(moneyField(0.2)).toBe("0,20");
    expect(moneyField(6.1)).toBe("6,10");
  });

  it("is empty for a missing amount", () => {
    expect(moneyField(null)).toBe("");
    expect(moneyField(undefined)).toBe("");
    expect(moneyField(Number.NaN)).toBe("");
  });

  it("round-trips through the parser", () => {
    expect(parseReceiptAmount(moneyField(1234.5))).toBe(1234.5);
  });
});

describe("syncAutoVat", () => {
  it("makes a single untouched VAT row follow the total", () => {
    const rows = [{ rate: "13.5", amount: "", auto: true }];
    expect(syncAutoVat(rows, "24,90")).toEqual([{ rate: "13.5", amount: "2,96", auto: true }]);
    expect(syncAutoVat([{ rate: "13.5", amount: "2,96", auto: true }], "30,00")).toEqual([
      { rate: "13.5", amount: "3,57", auto: true },
    ]);
  });

  it("clears the VAT when the total is cleared", () => {
    expect(syncAutoVat([{ rate: "25.5", amount: "0,99", auto: true }], "")).toEqual([
      { rate: "25.5", amount: "", auto: true },
    ]);
  });

  it("leaves a hand-typed amount and several rows alone", () => {
    const typed = [{ rate: "25.5", amount: "5,00", auto: false }];
    expect(syncAutoVat(typed, "30,00")).toBe(typed);
    const two = [
      { rate: "25.5", amount: "1,00", auto: true },
      { rate: "10", amount: "", auto: false },
    ];
    expect(syncAutoVat(two, "30,00")).toBe(two);
  });
});

describe("vatRowsFromSaved", () => {
  it("marks a saved row that matches the total as following it", () => {
    expect(vatRowsFromSaved([{ rate: 13.5, amount: 2.96 }], "24,90")).toEqual([
      { rate: "13.5", amount: "2,96", auto: true },
    ]);
  });

  it("keeps a saved row that differs from the total as typed by hand", () => {
    expect(vatRowsFromSaved([{ rate: 25.5, amount: 0.2 }], "1 234,50")).toEqual([
      { rate: "25.5", amount: "0,20", auto: false },
    ]);
  });

  it("starts an empty receipt with the default rate and the computed VAT", () => {
    expect(vatRowsFromSaved(null, "12,50")).toEqual([{ rate: "25.5", amount: "2,54", auto: true }]);
    expect(vatRowsFromSaved([], "")).toEqual([{ rate: "25.5", amount: "", auto: true }]);
  });

  it("marks several saved rows as typed", () => {
    expect(
      vatRowsFromSaved(
        [
          { rate: 25.5, amount: 1 },
          { rate: 10, amount: 0.5 },
        ],
        "20,00"
      ).map((row) => row.auto)
    ).toEqual([false, false]);
  });
});

describe("vatMismatchHint", () => {
  it("names the expected amount when a typed VAT does not fit the total", () => {
    expect(vatMismatchHint([{ rate: "25.5", amount: "0,20", auto: false }], "1 234,50")).toMatch(
      /250,83/
    );
  });

  it("is quiet for a fitting, followed or multi-row VAT", () => {
    expect(vatMismatchHint([{ rate: "25.5", amount: "250,83", auto: false }], "1 234,50")).toBeNull();
    expect(vatMismatchHint([{ rate: "25.5", amount: "250,80", auto: false }], "1 234,50")).toBeNull();
    expect(vatMismatchHint([{ rate: "25.5", amount: "", auto: true }], "1 234,50")).toBeNull();
    expect(
      vatMismatchHint(
        [
          { rate: "25.5", amount: "1,00", auto: false },
          { rate: "10", amount: "1,00", auto: false },
        ],
        "100,00"
      )
    ).toBeNull();
  });
});

describe("vatLinesProblem", () => {
  it("accepts VAT that fits the total and known rates", () => {
    expect(vatLinesProblem([{ rate: 25.5, amount: 2.03 }], 10)).toBeNull();
    expect(vatLinesProblem([{ rate: 14, amount: 1.5 }], 12.5)).toBeNull();
    expect(vatLinesProblem([{ rate: 0, amount: 0 }], 12.5)).toBeNull();
    expect(vatLinesProblem([], 10)).toBeNull();
    expect(vatLinesProblem([{ rate: 25.5, amount: 2 }], null)).toBeNull();
  });

  it("refuses a VAT larger than the receipt total", () => {
    expect(vatLinesProblem([{ rate: 25.5, amount: 50 }], 10)).toBe(
      "ALV-summa ei voi olla suurempi kuin kuitin summa."
    );
    expect(
      vatLinesProblem(
        [
          { rate: 25.5, amount: 6 },
          { rate: 10, amount: 5 },
        ],
        10
      )
    ).toMatch(/suurempi/);
  });

  it("refuses a rate the VAT return does not know", () => {
    expect(vatLinesProblem([{ rate: 99, amount: 0.5 }], 10)).toMatch(/99 %/);
    expect(vatLinesProblem([{ rate: 12.5, amount: 0.5 }], 10)).toMatch(/12,5 %/);
  });
});
