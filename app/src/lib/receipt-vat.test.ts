import { describe, expect, it } from "vitest";
import {
  addVatRow,
  autoVatAmount,
  defaultVatRateForDate,
  defaultVatRows,
  followDateRate,
  newReceiptVatRows,
  vatPayload,
  vatRateChoicesForDate,
  vatRowsChanged,
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

  it("opens a receipt with no saved VAT with an empty VAT section, never a prefill (V8, R53, R57)", () => {
    expect(vatRowsFromSaved(null, "12,50")).toEqual([]);
    expect(vatRowsFromSaved([], "12,50")).toEqual([]);
    expect(vatRowsFromSaved(undefined, "")).toEqual([]);
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

describe("default rate by receipt date (V9)", () => {
  it("is 25,5 from 1.9.2024 and 24 before it, and 25,5 while the date is unknown", () => {
    expect(defaultVatRateForDate("")).toBe("25.5");
    expect(defaultVatRateForDate("2026-09-20")).toBe("25.5");
    expect(defaultVatRateForDate("2024-09-01")).toBe("25.5");
    expect(defaultVatRateForDate("2024-08-31")).toBe("24");
    expect(defaultVatRateForDate("2023-05-10")).toBe("24");
  });

  it("offers 14 % as the reduced rate until 31.12.2025 and 13,5 % after it", () => {
    expect(vatRateChoicesForDate("2026-01-01")).toEqual(["25.5", "13.5", "10", "0"]);
    expect(vatRateChoicesForDate("")).toEqual(["25.5", "13.5", "10", "0"]);
    expect(vatRateChoicesForDate("2025-12-31")).toEqual(["25.5", "14", "10", "0"]);
    expect(vatRateChoicesForDate("2023-05-10")).toEqual(["24", "14", "10", "0"]);
  });
});

describe("a new receipt prefills the VAT, an existing one never does", () => {
  it("prefills the default row of the date for manual entry and follows the total", () => {
    expect(defaultVatRows("124,00", "2023-05-10")).toEqual([
      { rate: "24", amount: "24,00", auto: true, defaulted: true },
    ]);
    expect(defaultVatRows("", "")).toEqual([{ rate: "25.5", amount: "", auto: true, defaulted: true }]);
  });

  it("keeps what extraction read, and prefills only when it read no VAT", () => {
    expect(newReceiptVatRows([{ rate: 10, amount: 1 }], "11,00", "2026-09-20")).toEqual([
      { rate: "10", amount: "1,00", auto: true },
    ]);
    expect(newReceiptVatRows([], "12,50", "2026-09-20")).toEqual([
      { rate: "25.5", amount: "2,54", auto: true, defaulted: true },
    ]);
  });

  it("moves the rate of a row nobody set by hand when the date moves, and leaves a chosen rate", () => {
    const prefilled = defaultVatRows("124,00", "2026-09-20");
    expect(followDateRate(prefilled, "2023-05-10", "124,00")).toEqual([
      { rate: "24", amount: "24,00", auto: true, defaulted: true },
    ]);
    const chosen = [{ rate: "10", amount: "11,27", auto: true }];
    expect(followDateRate(chosen, "2023-05-10", "124,00")).toBe(chosen);
    const typed = [{ rate: "25.5", amount: "5,00", auto: false, defaulted: true }];
    expect(followDateRate(typed, "2023-05-10", "124,00")).toBe(typed);
  });
});

describe("adding VAT rows", () => {
  it("adds the first row from the empty state with the VAT of the total, on the user's tap", () => {
    expect(addVatRow([], "12,50", "2026-09-20")).toEqual([
      { rate: "25.5", amount: "2,54", auto: true, defaulted: true },
    ]);
  });

  it("adds a further row blank and freezes the others", () => {
    expect(addVatRow([{ rate: "25.5", amount: "2,54", auto: true }], "12,50", "2026-09-20")).toEqual([
      { rate: "25.5", amount: "2,54", auto: false },
      { rate: "25.5", amount: "", auto: false },
    ]);
  });
});

describe("vatRowsChanged", () => {
  it("compares rate and amount, not the following flag", () => {
    const stored = vatRowsFromSaved([{ rate: 25.5, amount: 2.54 }], "12,50");
    expect(vatRowsChanged(stored, [{ rate: "25.5", amount: "2,54", auto: false }])).toBe(false);
    expect(vatRowsChanged(stored, [{ rate: "25.5", amount: "2,50", auto: false }])).toBe(true);
    expect(vatRowsChanged(stored, [{ rate: "13.5", amount: "2,54", auto: false }])).toBe(true);
    expect(vatRowsChanged([], [])).toBe(false);
    expect(vatRowsChanged([], defaultVatRows("12,50", ""))).toBe(true);
    expect(vatRowsChanged(stored, [])).toBe(true);
  });
});

describe("vatPayload", () => {
  it("is an empty list for no VAT rows, so nothing is invented", () => {
    expect(vatPayload([], "12,50")).toEqual({ lines: [] });
  });

  it("turns the rows into lines in euros", () => {
    expect(vatPayload([{ rate: "25.5", amount: "2,54", auto: true }], "12,50")).toEqual({
      lines: [{ rate: 25.5, amount: 2.54 }],
    });
  });

  it("refuses a row with an empty amount, on any row count, instead of filling it (V10)", () => {
    expect(vatPayload([{ rate: "25.5", amount: "", auto: true }], "12,50")).toEqual({
      errorKey: "vat-0",
      message: "Anna ALV-summa tai poista rivi.",
    });
    expect(
      vatPayload(
        [
          { rate: "25.5", amount: "1,00", auto: false },
          { rate: "10", amount: " ", auto: false },
        ],
        "12,50"
      )
    ).toEqual({ errorKey: "vat-1", message: "Anna ALV-summa tai poista rivi." });
  });

  it("refuses a bad amount and a VAT larger than the total", () => {
    expect(vatPayload([{ rate: "25.5", amount: "x", auto: false }], "12,50")).toMatchObject({
      errorKey: "vat-0",
      message: "ALV-summa ei ole kelvollinen.",
    });
    expect(vatPayload([{ rate: "25.5", amount: "20,00", auto: false }], "12,50")).toMatchObject({
      errorKey: "vat-0",
      message: "ALV-summa ei voi olla suurempi kuin kuitin summa.",
    });
  });
});
