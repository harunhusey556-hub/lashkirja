import { describe, expect, it } from "vitest";
import {
  addMonthsKeepingAnchor,
  daysInMonth,
  dueRuns,
  firstRun,
  MAX_CATCH_UP_RUNS,
  nextRunAfter,
  parseIsoDate,
  type Schedule,
} from "./recurrence";

const monthly = (overrides: Partial<Schedule> = {}): Schedule => ({
  interval: "monthly",
  anchorDay: 1,
  startDate: "2026-01-01",
  ...overrides,
});

describe("parseIsoDate", () => {
  it("accepts a valid date and rejects junk", () => {
    expect(parseIsoDate("2026-02-15")).toEqual({ year: 2026, month: 2, day: 15 });
    for (const bad of ["", "2026-2-15", "15.2.2026", "2026-13-01", "2026-01-32", "nope"]) {
      expect(() => parseIsoDate(bad), bad).toThrow(RangeError);
    }
  });
});

describe("daysInMonth", () => {
  it("knows month lengths and leap years", () => {
    expect(daysInMonth(2026, 1)).toBe(31);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29); // leap
    expect(daysInMonth(2100, 2)).toBe(28); // century, not a leap year
    expect(daysInMonth(2026, 4)).toBe(30);
  });
});

describe("addMonthsKeepingAnchor", () => {
  it("advances by whole months", () => {
    expect(addMonthsKeepingAnchor("2026-01-15", 1, 15)).toBe("2026-02-15");
    expect(addMonthsKeepingAnchor("2026-01-15", 3, 15)).toBe("2026-04-15");
    expect(addMonthsKeepingAnchor("2026-01-15", 12, 15)).toBe("2027-01-15");
  });

  it("clamps to the target month but never forgets the anchor", () => {
    // The whole point: 31 -> 28 in February, then back to 31 in March.
    const february = addMonthsKeepingAnchor("2026-01-31", 1, 31);
    expect(february).toBe("2026-02-28");
    expect(addMonthsKeepingAnchor(february, 1, 31)).toBe("2026-03-31");
    expect(addMonthsKeepingAnchor("2028-01-31", 1, 31)).toBe("2028-02-29"); // leap
    expect(addMonthsKeepingAnchor("2026-01-31", 3, 31)).toBe("2026-04-30");
  });

  it("crosses year boundaries in both directions", () => {
    expect(addMonthsKeepingAnchor("2026-12-15", 1, 15)).toBe("2027-01-15");
    expect(addMonthsKeepingAnchor("2026-01-15", -1, 15)).toBe("2025-12-15");
  });

  it("rejects an impossible anchor day", () => {
    expect(() => addMonthsKeepingAnchor("2026-01-15", 1, 0)).toThrow(RangeError);
    expect(() => addMonthsKeepingAnchor("2026-01-15", 1, 32)).toThrow(RangeError);
    expect(() => addMonthsKeepingAnchor("2026-01-15", 1, 1.5)).toThrow(RangeError);
  });
});

describe("firstRun", () => {
  it("uses the anchor day in the starting month when it has not passed", () => {
    expect(firstRun(monthly({ startDate: "2026-01-01", anchorDay: 15 }))).toBe("2026-01-15");
    expect(firstRun(monthly({ startDate: "2026-01-15", anchorDay: 15 }))).toBe("2026-01-15");
  });

  it("moves to the next interval when the anchor has already passed", () => {
    expect(firstRun(monthly({ startDate: "2026-01-20", anchorDay: 15 }))).toBe("2026-02-15");
    expect(
      firstRun(monthly({ startDate: "2026-01-20", anchorDay: 15, interval: "quarterly" }))
    ).toBe("2026-04-15");
  });

  it("clamps the anchor in a short starting month", () => {
    expect(firstRun(monthly({ startDate: "2026-02-01", anchorDay: 31 }))).toBe("2026-02-28");
  });
});

describe("nextRunAfter", () => {
  it("steps by the interval", () => {
    expect(nextRunAfter(monthly({ anchorDay: 10 }), "2026-01-10")).toBe("2026-02-10");
    expect(nextRunAfter(monthly({ interval: "quarterly", anchorDay: 10 }), "2026-01-10")).toBe(
      "2026-04-10"
    );
    expect(nextRunAfter(monthly({ interval: "yearly", anchorDay: 10 }), "2026-01-10")).toBe(
      "2027-01-10"
    );
  });
});

describe("dueRuns", () => {
  it("returns nothing before the first run is due", () => {
    const result = dueRuns(monthly({ anchorDay: 15 }), "2026-01-15", "2026-01-14");
    expect(result.dates).toEqual([]);
    expect(result.nextRun).toBe("2026-01-15");
    expect(result.truncated).toBe(false);
  });

  it("returns the run due today", () => {
    const result = dueRuns(monthly({ anchorDay: 15 }), "2026-01-15", "2026-01-15");
    expect(result.dates).toEqual(["2026-01-15"]);
    expect(result.nextRun).toBe("2026-02-15");
  });

  it("catches up every missed month, oldest first", () => {
    const result = dueRuns(monthly({ anchorDay: 1 }), "2026-01-01", "2026-04-15");
    expect(result.dates).toEqual(["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"]);
    expect(result.nextRun).toBe("2026-05-01");
  });

  it("keeps the anchor across a short month while catching up", () => {
    const result = dueRuns(monthly({ anchorDay: 31 }), "2026-01-31", "2026-04-01");
    expect(result.dates).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect(result.nextRun).toBe("2026-04-30");
  });

  it("stops at the end date and reports the schedule as finished", () => {
    const schedule = monthly({ anchorDay: 1, endDate: "2026-03-31" });
    const result = dueRuns(schedule, "2026-01-01", "2026-06-01");
    expect(result.dates).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
    expect(result.nextRun).toBeNull();
  });

  it("reports a schedule that has already ended without emitting anything", () => {
    const schedule = monthly({ anchorDay: 1, endDate: "2025-12-31" });
    const result = dueRuns(schedule, "2026-01-01", "2026-06-01");
    expect(result.dates).toEqual([]);
    expect(result.nextRun).toBeNull();
  });

  it("caps a runaway catch-up and says so", () => {
    const result = dueRuns(monthly({ anchorDay: 1 }), "2000-01-01", "2026-01-01");
    expect(result.dates).toHaveLength(MAX_CATCH_UP_RUNS);
    expect(result.truncated).toBe(true);
    // The cursor stops on the first ungenerated date, so nothing is lost.
    expect(result.nextRun).toBe("2002-01-01");
  });

  it("honours a smaller cap for a single pass", () => {
    const result = dueRuns(monthly({ anchorDay: 1 }), "2026-01-01", "2026-12-01", 3);
    expect(result.dates).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
    expect(result.truncated).toBe(true);
    expect(result.nextRun).toBe("2026-04-01");
  });

  it("handles quarterly and yearly catch-up", () => {
    expect(
      dueRuns(monthly({ interval: "quarterly", anchorDay: 1 }), "2026-01-01", "2026-12-31").dates
    ).toEqual(["2026-01-01", "2026-04-01", "2026-07-01", "2026-10-01"]);
    expect(
      dueRuns(monthly({ interval: "yearly", anchorDay: 1 }), "2026-01-01", "2028-06-01").dates
    ).toEqual(["2026-01-01", "2027-01-01", "2028-01-01"]);
  });

  it("rejects malformed dates instead of looping", () => {
    expect(() => dueRuns(monthly(), "not-a-date", "2026-01-01")).toThrow(RangeError);
    expect(() => dueRuns(monthly(), "2026-01-01", "nope")).toThrow(RangeError);
  });
});
