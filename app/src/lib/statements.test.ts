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
      // The bank's own figures: every row in or out, the transfer too.
      moneyIn: 1845.6,
      moneyOut: 800,
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
      moneyIn: 0,
      moneyOut: 0,
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

describe("printed balances (Holvi PDF, 2026-10-09)", () => {
  it("reads SALDO lines and turns them into month-end balances", async () => {
    const { monthEndBalances, parsePrintedBalances } = await import("./parsers");
    const text = [
      "IBAN            FI03 7997 7996 7647 62           Y-tunnus: 3628546-6",
      " SALDO 1.9.2026                                                  + 367,10",
      "   15.9.2026  Kauppa Oy                                           -12,00",
      "SALDO 30.9.2026                                                  + 357,31",
      "SALDO 15.10.2026                                                 - 1 204,50",
    ].join("\n");
    const printed = parsePrintedBalances(text);
    expect(printed).toEqual([
      { date: "2026-09-01", balance: 367.1 },
      { date: "2026-09-30", balance: 357.31 },
      { date: "2026-10-15", balance: -1204.5 },
    ]);
    // The 1st closes the month before; a mid-month balance closes nothing.
    expect(monthEndBalances(printed)).toEqual([
      { month: "2026-08", closingBalance: 367.1 },
      { month: "2026-09", closingBalance: 357.31 },
    ]);
  });
});

describe("month-end balances counted from a whole-period statement (Holvi, 2026-10-09)", () => {
  it("adds the rows to the opening balance up to each month end, only when they reach the closing one", async () => {
    const { derivedMonthEndBalances } = await import("./parsers");
    const printed = [
      { date: "2026-06-05", balance: 83.01 },
      { date: "2026-08-09", balance: 101.51 },
    ];
    const rows = [
      { date: "2026-06-05", amount: 75 },
      { date: "2026-06-30", amount: -2.5 },
      { date: "2026-07-14", amount: -60 },
      { date: "2026-08-09", amount: 6 },
    ];
    expect(derivedMonthEndBalances(printed, rows)).toEqual([
      { month: "2026-06", closingBalance: 155.51 },
      { month: "2026-07", closingBalance: 95.51 },
    ]);
    // A row missing (not the whole period): nothing is counted.
    expect(derivedMonthEndBalances(printed, rows.slice(1))).toEqual([]);
    expect(derivedMonthEndBalances(printed.slice(0, 1), rows)).toEqual([]);
  });
});


describe("camt balances (audit 2026-10-09, Holvi camt.052)", () => {
  it("reads the opening and closing balance a camt file states", async () => {
    const { parseCamtBalances, derivedMonthEndBalances, monthEndBalances } = await import("./parsers");
    const xml = `<Document><BkToCstmrAcctRpt><Rpt><Acct><Id><IBAN>FI2112345600000785</IBAN></Id></Acct>
      <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">1307.58</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-03-01</Dt></Dt></Bal>
      <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">12.40</Amt><CdtDbtInd>DBIT</CdtDbtInd><Dt><Dt>2026-08-31</Dt></Dt></Bal>
      <Ntry></Ntry></Rpt></BkToCstmrAcctRpt></Document>`;
    const printed = parseCamtBalances(xml);
    expect(printed).toEqual([
      { date: "2026-03-01", balance: 1307.58 },
      { date: "2026-08-31", balance: -12.4 },
    ]);
    expect(monthEndBalances(printed)).toEqual([
      { month: "2026-02", closingBalance: 1307.58 },
      { month: "2026-08", closingBalance: -12.4 },
    ]);
    expect(derivedMonthEndBalances(printed, [{ date: "2026-05-02", amount: -1319.98 }]).map((r) => r.month)).toEqual([
      "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08",
    ]);
    // Two accounts in one file: whose balance it is cannot be told, so none.
    expect(parseCamtBalances(xml.replace("<Rpt>", "<Rpt><Acct></Acct></Rpt><Rpt>"))).toEqual([]);
  });
});
