import { describe, expect, it } from "vitest";
import { easterSunday, finnishHolidays, vatDeadline, vatDeadlineIso } from "./vat-deadline";

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

describe("easterSunday", () => {
  it("matches the historical record", () => {
    expect(iso(easterSunday(2026))).toBe("2026-04-05");
    expect(iso(easterSunday(2027))).toBe("2027-03-28");
    expect(iso(easterSunday(2004))).toBe("2004-04-11");
  });
});

describe("finnishHolidays", () => {
  it("includes every fixed date once", () => {
    const holidays = finnishHolidays(2026).map(iso);
    expect(holidays).toEqual(
      expect.arrayContaining([
        "2026-01-01",
        "2026-01-06",
        "2026-05-01",
        "2026-12-06",
        "2026-12-24",
        "2026-12-25",
        "2026-12-26",
      ])
    );
  });

  it("derives the movable feasts from Easter Sunday (2026-04-05)", () => {
    const holidays = finnishHolidays(2026).map(iso);
    expect(holidays).toContain("2026-04-03"); // Good Friday (Easter - 2)
    expect(holidays).toContain("2026-04-06"); // Easter Monday (Easter + 1)
    expect(holidays).toContain("2026-05-14"); // Ascension Day (Easter + 39)
  });

  it("Midsummer Eve is the Friday between 19 and 25 June", () => {
    for (const year of [2024, 2025, 2026, 2027, 2028]) {
      const midsummerEve = finnishHolidays(year).find((d) => d.getUTCMonth() === 5);
      expect(midsummerEve).toBeDefined();
      expect(midsummerEve!.getUTCDay()).toBe(5); // Friday
      expect(midsummerEve!.getUTCDate()).toBeGreaterThanOrEqual(19);
      expect(midsummerEve!.getUTCDate()).toBeLessThanOrEqual(25);
    }
  });
});

describe("vatDeadline", () => {
  it("monthly: 12th of the second month after the period, a plain business day", () => {
    // September 2026 -> due 12 November 2026, a Thursday.
    const due = vatDeadline({ kind: "month", year: 2026, month: 9 });
    expect(iso(due)).toBe("2026-11-12");
    expect(due.getUTCDay()).toBe(4); // Thursday
  });

  it("monthly: rolls a Saturday forward past the Sunday to Monday", () => {
    // October 2026 -> 12 December 2026 is a Saturday -> 14 December 2026 (Monday).
    expect(vatDeadlineIso({ kind: "month", year: 2026, month: 10 })).toBe("2026-12-14");
  });

  it("monthly: rolls forward off a public holiday (Easter Monday), not just off weekends", () => {
    // February 2004 -> due 12 April 2004, which is Easter Monday 2004
    // (Easter Sunday was 11 April 2004) -> the next business day is Tuesday 13 April 2004.
    const due = vatDeadline({ kind: "month", year: 2004, month: 2 });
    expect(iso(due)).toBe("2004-04-13");
    expect(due.getUTCDay()).toBe(2); // Tuesday
  });

  it("monthly: rolls over into the next year", () => {
    // November 2026 -> due 12 January 2027.
    expect(vatDeadlineIso({ kind: "month", year: 2026, month: 11 })).toBe("2027-01-12");
  });

  it("quarterly: 12th of the second month after the quarter's last month", () => {
    // Q3 2026 (Jul-Aug-Sep) -> same due date as the September monthly case.
    expect(vatDeadlineIso({ kind: "quarter", year: 2026, quarter: 3 })).toBe("2026-11-12");
  });

  it("yearly: 28 February of the following year, rolled off a Sunday to Monday", () => {
    // 2026 -> 28 February 2027 is a Sunday -> 1 March 2027.
    const due = vatDeadline({ kind: "year", year: 2026 });
    expect(iso(due)).toBe("2027-03-01");
    expect(due.getUTCDay()).toBe(1); // Monday
  });

  it("throws on a malformed period rather than silently computing a wrong date", () => {
    expect(() => vatDeadline({ kind: "month", year: 2026 })).toThrow();
    expect(() => vatDeadline({ kind: "quarter", year: 2026 })).toThrow();
  });
});
