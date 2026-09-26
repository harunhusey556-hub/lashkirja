import { describe, expect, it } from "vitest";
import {
  buildReminderTotals,
  computeLateInterest,
  daysLate,
  STATUTORY_MARGIN,
} from "./late-interest";

describe("daysLate", () => {
  it("treats the due date itself as on time", () => {
    expect(daysLate("2026-01-31", "2026-01-31")).toBe(0);
    expect(daysLate("2026-01-31", "2026-01-31T23:59:59Z")).toBe(0);
  });

  it("counts whole days from the day after the due date", () => {
    expect(daysLate("2026-01-31", "2026-02-01")).toBe(1);
    expect(daysLate("2026-01-31", "2026-03-02")).toBe(30);
  });

  it("returns zero for a payment made early", () => {
    expect(daysLate("2026-01-31", "2026-01-01")).toBe(0);
  });

  it("crosses months, years and a leap day", () => {
    expect(daysLate("2025-12-31", "2026-01-01")).toBe(1);
    expect(daysLate("2028-02-28", "2028-03-01")).toBe(2); // 29 Feb exists in 2028
    expect(daysLate("2027-02-28", "2027-03-01")).toBe(1);
  });

  it("is unaffected by the time of day", () => {
    expect(daysLate("2026-01-31T00:00:00Z", "2026-02-05T18:30:00Z")).toBe(5);
  });

  it("rejects an unparsable date instead of returning a number", () => {
    expect(() => daysLate("not-a-date", "2026-01-01")).toThrow(RangeError);
  });
});

describe("computeLateInterest", () => {
  it("computes actual days over a 365-day year", () => {
    // 1000,00 € at 11,5 % for 365 days = 115,00 €
    expect(
      computeLateInterest({
        openCents: 100_000,
        dueDate: "2026-01-01",
        on: "2027-01-01",
        annualRatePercent: 11.5,
      })
    ).toMatchObject({ days: 365, interestCents: 11_500 });

    // ...and for 30 days = 9,45 €
    expect(
      computeLateInterest({
        openCents: 100_000,
        dueDate: "2026-01-01",
        on: "2026-01-31",
        annualRatePercent: 11.5,
      }).interestCents
    ).toBe(945);
  });

  it("charges nothing while the invoice is still on time", () => {
    expect(
      computeLateInterest({
        openCents: 100_000,
        dueDate: "2026-02-01",
        on: "2026-01-15",
        annualRatePercent: 11.5,
      })
    ).toMatchObject({ days: 0, interestCents: 0 });
  });

  it("charges nothing when no rate has been set", () => {
    for (const rate of [null, undefined, 0]) {
      expect(
        computeLateInterest({
          openCents: 100_000,
          dueDate: "2026-01-01",
          on: "2026-06-01",
          annualRatePercent: rate,
        }).interestCents
      ).toBe(0);
    }
  });

  it("ignores a negative or nonsensical rate rather than crediting the customer", () => {
    for (const rate of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        computeLateInterest({
          openCents: 100_000,
          dueDate: "2026-01-01",
          on: "2026-06-01",
          annualRatePercent: rate,
        }).interestCents
      ).toBe(0);
    }
  });

  it("charges nothing on a settled or overpaid invoice", () => {
    expect(
      computeLateInterest({
        openCents: 0,
        dueDate: "2026-01-01",
        on: "2026-06-01",
        annualRatePercent: 11.5,
      }).interestCents
    ).toBe(0);
    expect(
      computeLateInterest({
        openCents: -500,
        dueDate: "2026-01-01",
        on: "2026-06-01",
        annualRatePercent: 11.5,
      }).interestCents
    ).toBe(0);
  });

  it("rounds to whole cents", () => {
    // 100,00 € at 11,5 % for 1 day = 0,0315 € -> 0,03 €
    expect(
      computeLateInterest({
        openCents: 10_000,
        dueDate: "2026-01-01",
        on: "2026-01-02",
        annualRatePercent: 11.5,
      }).interestCents
    ).toBe(3);
    expect(
      computeLateInterest({
        openCents: 100,
        dueDate: "2026-01-01",
        on: "2026-01-02",
        annualRatePercent: 11.5,
      }).interestCents
    ).toBe(0);
  });

  it("grows linearly with time, so two halves equal the whole", () => {
    const base = { openCents: 250_000, annualRatePercent: 9 } as const;
    const first = computeLateInterest({ ...base, dueDate: "2026-01-01", on: "2026-02-01" });
    const whole = computeLateInterest({ ...base, dueDate: "2026-01-01", on: "2026-03-01" });
    const second = computeLateInterest({ ...base, dueDate: "2026-02-01", on: "2026-03-01" });
    expect(first.interestCents + second.interestCents).toBe(whole.interestCents);
  });

  it("documents the statutory margins without assuming a reference rate", () => {
    expect(STATUTORY_MARGIN.consumer).toBe(7);
    expect(STATUTORY_MARGIN.commercial).toBe(8);
  });
});

describe("buildReminderTotals", () => {
  it("adds principal, interest and fee into one demand", () => {
    const totals = buildReminderTotals({
      openCents: 100_000,
      dueDate: "2026-01-01",
      on: "2026-01-31",
      annualRatePercent: 11.5,
      feeCents: 500,
    });
    expect(totals).toEqual({
      openCents: 100_000,
      interestCents: 945,
      feeCents: 500,
      totalCents: 101_445,
      days: 30,
      annualRatePercent: 11.5,
    });
  });

  it("still charges the fee when no interest rate is configured", () => {
    const totals = buildReminderTotals({
      openCents: 100_000,
      dueDate: "2026-01-01",
      on: "2026-01-31",
      annualRatePercent: null,
      feeCents: 500,
    });
    expect(totals).toMatchObject({ interestCents: 0, feeCents: 500, totalCents: 100_500 });
  });

  it("supports a reminder with no fee at all", () => {
    expect(
      buildReminderTotals({
        openCents: 100_000,
        dueDate: "2026-01-01",
        on: "2026-01-31",
        annualRatePercent: null,
        feeCents: 0,
      }).totalCents
    ).toBe(100_000);
  });

  it("never turns a settled invoice into a negative demand", () => {
    expect(
      buildReminderTotals({
        openCents: -1_000,
        dueDate: "2026-01-01",
        on: "2026-06-01",
        annualRatePercent: 11.5,
        feeCents: 500,
      })
    ).toMatchObject({ openCents: 0, interestCents: 0, totalCents: 500 });
  });

  it("rejects a negative fee", () => {
    expect(() =>
      buildReminderTotals({
        openCents: 100,
        dueDate: "2026-01-01",
        on: "2026-06-01",
        annualRatePercent: null,
        feeCents: -1,
      })
    ).toThrow(RangeError);
  });
});
