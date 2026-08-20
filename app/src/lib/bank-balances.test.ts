import { describe, it, expect } from "vitest";
import {
  addMonths,
  balanceAtMonthEnd,
  buildRollforward,
  compareMonths,
  isMonthKey,
  MAX_ROLLFORWARD_MONTHS,
  monthKey,
  monthRange,
  totalPosition,
  type BalanceTransactionInput,
} from "./bank-balances";

const account = (openingDate: string, openingBalanceCents = 0) => ({
  openingBalanceCents,
  openingDate,
});

const tx = (date: string | null, amountCents: number): BalanceTransactionInput => ({
  date,
  amountCents,
});

describe("month helpers", () => {
  it("validates month keys", () => {
    expect(isMonthKey("2026-01")).toBe(true);
    expect(isMonthKey("2026-12")).toBe(true);
    expect(isMonthKey("2026-00")).toBe(false);
    expect(isMonthKey("2026-13")).toBe(false);
    expect(isMonthKey("2026-1")).toBe(false);
    expect(isMonthKey("not-a-month")).toBe(false);
  });

  it("derives the month key in UTC", () => {
    expect(monthKey("2026-03-01T00:00:00.000Z")).toBe("2026-03");
    expect(monthKey("2026-03-31T23:59:59.999Z")).toBe("2026-03");
    expect(monthKey(new Date(Date.UTC(2026, 0, 1)))).toBe("2026-01");
  });

  it("adds months across year boundaries in both directions", () => {
    expect(addMonths("2026-01", 1)).toBe("2026-02");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-06", -18)).toBe("2024-12");
    expect(addMonths("2026-01", 24)).toBe("2028-01");
    expect(addMonths("2026-01", 0)).toBe("2026-01");
  });

  it("rejects malformed month arithmetic instead of returning nonsense", () => {
    expect(() => addMonths("2026-13", 1)).toThrow(RangeError);
  });

  it("builds inclusive ranges and empty ranges when reversed", () => {
    expect(monthRange("2025-11", "2026-02")).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
    expect(monthRange("2026-02", "2026-02")).toEqual(["2026-02"]);
    expect(monthRange("2026-03", "2026-01")).toEqual([]);
  });

  it("compares months lexicographically as chronological order", () => {
    expect(compareMonths("2025-12", "2026-01")).toBe(-1);
    expect(compareMonths("2026-01", "2026-01")).toBe(0);
    expect(compareMonths("2026-02", "2026-01")).toBe(1);
  });
});

describe("buildRollforward - movement math", () => {
  it("splits income and expense and keeps the net signed", () => {
    const result = buildRollforward(account("2026-01-01", 100_00), [
      tx("2026-01-05", 500_00),
      tx("2026-01-09", -120_50),
      tx("2026-01-20", -79_50),
    ]);

    expect(result.months).toHaveLength(1);
    const [january] = result.months;
    expect(january.incomeCents).toBe(500_00);
    expect(january.expenseCents).toBe(200_00);
    expect(january.netCents).toBe(300_00);
    expect(january.txCount).toBe(3);
    expect(january.openingCents).toBe(100_00);
    expect(january.openingSource).toBe("opening_balance");
    expect(january.computedClosingCents).toBe(400_00);
    expect(result.currentBalanceCents).toBe(400_00);
  });

  it("returns a single opening row when nothing ever happened", () => {
    const result = buildRollforward(account("2026-01-01", 250_00), []);
    expect(result.months).toEqual([
      expect.objectContaining({
        month: "2026-01",
        openingCents: 250_00,
        computedClosingCents: 250_00,
        txCount: 0,
        status: "unreported",
      }),
    ]);
    expect(result.currentBalanceCents).toBe(250_00);
  });

  it("carries the balance through months with no transactions", () => {
    const result = buildRollforward(account("2026-01-01", 1_000_00), [
      tx("2026-01-15", -200_00),
      tx("2026-04-02", 50_00),
    ]);

    expect(result.months.map((m) => m.month)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
    ]);
    expect(result.months[1]).toMatchObject({
      openingCents: 800_00,
      txCount: 0,
      netCents: 0,
      computedClosingCents: 800_00,
      openingSource: "computed",
    });
    expect(result.months[3].computedClosingCents).toBe(850_00);
  });

  it("rolls forward across a year boundary", () => {
    const result = buildRollforward(account("2025-11-01", 0), [
      tx("2025-11-10", 100_00),
      tx("2025-12-10", 100_00),
      tx("2026-01-10", -50_00),
    ]);
    expect(result.months.map((m) => m.month)).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
    ]);
    expect(result.currentBalanceCents).toBe(150_00);
  });

  it("stays exact in integer cents over many small movements", () => {
    const transactions = Array.from({ length: 1000 }, (_, index) =>
      tx("2026-01-05", index % 2 === 0 ? 10_01 : -10_01)
    );
    const result = buildRollforward(account("2026-01-01", 0), transactions);
    expect(result.currentBalanceCents).toBe(0);
    expect(Number.isSafeInteger(result.currentBalanceCents)).toBe(true);
    expect(result.months[0].incomeCents).toBe(500 * 10_01);
    expect(result.months[0].expenseCents).toBe(500 * 10_01);
  });
});

describe("buildRollforward - coverage boundaries", () => {
  it("excludes transactions dated before the opening date, in the opening month too", () => {
    const result = buildRollforward(account("2026-01-15", 500_00), [
      tx("2026-01-02", -1_000_00), // before the opening balance was taken
      tx("2026-01-20", -100_00),
    ]);

    expect(result.months[0].txCount).toBe(1);
    expect(result.months[0].computedClosingCents).toBe(400_00);
    expect(result.excluded.preOpeningTxCount).toBe(1);
    expect(result.excluded.preOpeningAmountCents).toBe(-1_000_00);
  });

  it("includes a transaction dated exactly on the opening date", () => {
    const result = buildRollforward(account("2026-01-15", 0), [
      tx("2026-01-15", 42_00),
    ]);
    expect(result.months[0].txCount).toBe(1);
    expect(result.excluded.preOpeningTxCount).toBe(0);
  });

  it("counts undated transactions separately instead of dropping them silently", () => {
    const result = buildRollforward(account("2026-01-01", 0), [
      tx(null, -50_00),
      tx("", -25_00),
      tx("2026-01-10", 75_00),
    ]);
    expect(result.excluded.undatedTxCount).toBe(2);
    expect(result.months[0].computedClosingCents).toBe(75_00);
  });

  it("extends the table to throughMonth even with no activity", () => {
    const result = buildRollforward(account("2026-01-01", 300_00), [], [], {
      throughMonth: "2026-05",
    });
    expect(result.months).toHaveLength(5);
    expect(result.months.at(-1)).toMatchObject({
      month: "2026-05",
      openingCents: 300_00,
      computedClosingCents: 300_00,
    });
  });

  it("ignores a throughMonth earlier than the data", () => {
    const result = buildRollforward(
      account("2026-03-01", 0),
      [tx("2026-04-01", 10_00)],
      [],
      { throughMonth: "2026-01" }
    );
    expect(result.months.map((m) => m.month)).toEqual(["2026-03", "2026-04"]);
  });

  it("caps absurd ranges instead of building an unbounded table", () => {
    const result = buildRollforward(account("1900-01-01", 0), [], [], {
      throughMonth: "2099-12",
    });
    expect(result.months).toHaveLength(MAX_ROLLFORWARD_MONTHS);
  });
});

describe("buildRollforward - reconciliation", () => {
  it("marks a month reconciled when the bank agrees to the cent", () => {
    const result = buildRollforward(
      account("2026-01-01", 100_00),
      [tx("2026-01-05", 400_00)],
      [{ month: "2026-01", closingBalanceCents: 500_00 }]
    );
    expect(result.months[0]).toMatchObject({
      reportedClosingCents: 500_00,
      differenceCents: 0,
      status: "reconciled",
    });
    expect(result.lastReconciledMonth).toBe("2026-01");
    expect(result.mismatchMonths).toEqual([]);
  });

  it("reports the signed difference when the bank disagrees", () => {
    const result = buildRollforward(
      account("2026-01-01", 0),
      [tx("2026-01-05", 100_00)],
      [{ month: "2026-01", closingBalanceCents: 130_00 }]
    );
    expect(result.months[0].differenceCents).toBe(30_00); // bank holds more
    expect(result.months[0].status).toBe("mismatch");
    expect(result.mismatchMonths).toEqual(["2026-01"]);
    expect(result.lastReconciledMonth).toBeNull();
  });

  it("anchors the next month on the reported balance so one bad month does not poison the rest", () => {
    const result = buildRollforward(
      account("2026-01-01", 0),
      [tx("2026-01-05", 100_00), tx("2026-02-05", 10_00)],
      [
        { month: "2026-01", closingBalanceCents: 130_00 },
        { month: "2026-02", closingBalanceCents: 140_00 },
      ]
    );

    const february = result.months[1];
    expect(february.openingCents).toBe(130_00);
    expect(february.openingSource).toBe("reported");
    expect(february.computedClosingCents).toBe(140_00);
    expect(february.status).toBe("reconciled");
    expect(result.mismatchMonths).toEqual(["2026-01"]);
  });

  it("uses the computed closing as the next opening when no balance was reported", () => {
    const result = buildRollforward(account("2026-01-01", 0), [
      tx("2026-01-05", 100_00),
      tx("2026-02-05", 10_00),
    ]);
    expect(result.months[1].openingCents).toBe(100_00);
    expect(result.months[1].openingSource).toBe("computed");
  });

  it("prefers the reported balance for the current position", () => {
    const result = buildRollforward(
      account("2026-01-01", 0),
      [tx("2026-01-05", 100_00)],
      [{ month: "2026-01", closingBalanceCents: 130_00 }]
    );
    expect(result.currentBalanceCents).toBe(130_00);
  });

  it("lets a later entry for the same month win", () => {
    const result = buildRollforward(account("2026-01-01", 0), [], [
      { month: "2026-01", closingBalanceCents: 10_00 },
      { month: "2026-01", closingBalanceCents: 20_00 },
    ]);
    expect(result.months[0].reportedClosingCents).toBe(20_00);
  });

  it("extends the range to a reported month with no transactions", () => {
    const result = buildRollforward(account("2026-01-01", 500_00), [], [
      { month: "2026-03", closingBalanceCents: 500_00 },
    ]);
    expect(result.months.map((m) => m.month)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
    ]);
    expect(result.months[2].status).toBe("reconciled");
  });

  it("rejects reported balances outside the account's life instead of shifting the books", () => {
    const result = buildRollforward(account("2026-02-01", 0), [], [
      { month: "2026-01", closingBalanceCents: 999_00 },
      { month: "2026-1", closingBalanceCents: 1_00 },
      { month: "not-a-month", closingBalanceCents: 1_00 },
    ]);
    expect(result.excluded.outOfRangeReportedMonths).toEqual([
      "2026-01",
      "2026-1",
      "not-a-month",
    ]);
    expect(result.months).toHaveLength(1);
    expect(result.months[0].reportedClosingCents).toBeNull();
  });

  it("tracks unreported months so the UI can ask for the missing statement", () => {
    const result = buildRollforward(
      account("2026-01-01", 0),
      [tx("2026-01-05", 10_00), tx("2026-03-05", 10_00)],
      [{ month: "2026-01", closingBalanceCents: 10_00 }]
    );
    expect(result.unreportedMonths).toEqual(["2026-02", "2026-03"]);
  });
});

describe("balanceAtMonthEnd", () => {
  const result = buildRollforward(
    account("2026-01-01", 0),
    [tx("2026-01-05", 100_00), tx("2026-02-05", 25_00)],
    [{ month: "2026-01", closingBalanceCents: 130_00 }]
  );

  it("returns the reported balance when there is one", () => {
    expect(balanceAtMonthEnd(result, "2026-01")).toBe(130_00);
  });

  it("falls back to the computed balance", () => {
    expect(balanceAtMonthEnd(result, "2026-02")).toBe(155_00);
  });

  it("returns null for a month outside the table", () => {
    expect(balanceAtMonthEnd(result, "2025-12")).toBeNull();
  });
});

describe("totalPosition", () => {
  const position = (
    bankAccountId: string,
    balanceCents: number,
    currency = "EUR"
  ) => ({ bankAccountId, name: bankAccountId, currency, balanceCents, status: "reconciled" as const });

  it("sums accounts of the requested currency", () => {
    const total = totalPosition([
      position("a", 100_00),
      position("b", -25_00),
      position("c", 5_00),
    ]);
    expect(total).toEqual({
      totalCents: 80_00,
      includedAccounts: 3,
      excludedCurrencies: [],
    });
  });

  it("never mixes currencies into one number", () => {
    const total = totalPosition([
      position("a", 100_00),
      position("b", 900_00, "SEK"),
      position("c", 50_00, "USD"),
    ]);
    expect(total.totalCents).toBe(100_00);
    expect(total.includedAccounts).toBe(1);
    expect(total.excludedCurrencies).toEqual(["SEK", "USD"]);
  });

  it("handles an empty portfolio", () => {
    expect(totalPosition([])).toEqual({
      totalCents: 0,
      includedAccounts: 0,
      excludedCurrencies: [],
    });
  });
});
