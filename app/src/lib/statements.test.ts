import { describe, it, expect } from "vitest";
import {
  computeStatementTotals,
  inferTransactionType,
} from "./statements";

describe("computeStatementTotals", () => {
  it("splits tulo, meno and oma_siirto correctly", () => {
    const totals = computeStatementTotals([
      { amount: 1500, type: "tulo" },
      { amount: 345.6, type: "tulo" },
      { amount: -200.25, type: "meno" },
      { amount: -99.75, type: "meno" },
      { amount: -500, type: "oma_siirto" },
    ]);
    expect(totals).toEqual({
      income: 1845.6,
      expenses: 300,
      transfers: -500,
      net: 1545.6,
      txCount: 5,
    });
  });

  it("uses absolute values for meno amounts", () => {
    const totals = computeStatementTotals([{ amount: -50.5, type: "meno" }]);
    expect(totals.expenses).toBe(50.5);
    expect(totals.net).toBe(-50.5);
  });

  it("classifies negative amounts as meno", () => {
    expect(inferTransactionType(-197.72)).toBe("meno");
  });

  it("detects salary payments as palkka", () => {
    expect(
      inferTransactionType(-400, {
        message: "Palkka itselleni. 400e kesä/heinäku u.",
      })
    ).toBe("palkka");
    expect(
      inferTransactionType(-70, {
        counterparty: "Vilma Hartikainen",
        message: "Palkka",
      })
    ).toBe("palkka");
    expect(
      inferTransactionType(-70, {
        counterparty: "Vilma Hartikainen",
        message: "palkka",
      })
    ).toBe("palkka");
  });

  it("detects non-salary owner transfers as oma_siirto", () => {
    expect(
      inferTransactionType(-500, {
        message: "Oma siirto säästöön",
      })
    ).toBe("oma_siirto");
  });

  it("does not classify payroll provider payments as palkka", () => {
    expect(
      inferTransactionType(-500, {
        counterparty: "Accountor Oy",
        message: "palkka",
      })
    ).toBe("meno");
  });

  it("excludes palkka and oma_siirto from net", () => {
    const totals = computeStatementTotals([
      { amount: -70, type: "palkka" },
      { amount: 8500, type: "oma_siirto" },
      { amount: 100, type: "tulo" },
    ]);
    expect(totals.net).toBe(100);
    expect(totals.transfers).toBe(8430);
  });

  it("handles empty statements", () => {
    expect(computeStatementTotals([])).toEqual({
      income: 0,
      expenses: 0,
      transfers: 0,
      net: 0,
      txCount: 0,
    });
  });

  it("avoids floating point drift in sums", () => {
    const totals = computeStatementTotals([
      { amount: 0.1, type: "tulo" },
      { amount: 0.2, type: "tulo" },
    ]);
    expect(totals.income).toBe(0.3);
  });
});
