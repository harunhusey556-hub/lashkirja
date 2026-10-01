import { describe, expect, it } from "vitest";
import { alvKeyForKind, alvKeyKind, alvPeriodOptions, periodOfKey, resolveAlvPeriod } from "./alv-period-choice";
import { alvPeriodBoundsUtc, alvPeriodSchema } from "./validation";
import { nextVatDue, vatPeriodKindOf } from "./vat-deadline";
import { vatDueSecondary } from "./vat-due";

// 1 October 2026: August is the monthly return due (12.10.), Q3 the quarterly one (12.11.), 2026 the yearly one (the running year, due 1.3.2027).
const now = new Date("2026-10-01T10:00:00Z");

describe("the ALV page opens on the period the profile makes due (F13)", () => {
  it("follows the profile's period setting when nothing was chosen", () => {
    expect(resolveAlvPeriod({ link: null, choice: null, vatPeriod: "month", now })).toBe("2026-08");
    expect(resolveAlvPeriod({ link: null, choice: null, vatPeriod: "quarter", now })).toBe("2026-Q3");
    expect(resolveAlvPeriod({ link: null, choice: null, vatPeriod: "year", now })).toBe("2026");
  });

  it("names the same period as Koti and the month close for every setting", () => {
    for (const setting of ["month", "quarter", "year"]) {
      const kind = vatPeriodKindOf(setting);
      const due = nextVatDue(now, kind);
      expect(resolveAlvPeriod({ link: null, choice: null, vatPeriod: setting, now })).toBe(due.key);
      // Every screen words the row from the same VatDue: the label carries the period.
      expect(vatDueSecondary(due, null)).toContain(due.label);
    }
  });

  it("lets a link win, then a choice made under the same setting, never a stale one", () => {
    expect(resolveAlvPeriod({ link: "2026-Q2", choice: null, vatPeriod: "month", now })).toBe("2026-Q2");
    expect(resolveAlvPeriod({ link: null, choice: { key: "2026-06", kind: "month" }, vatPeriod: "month", now })).toBe("2026-06");
    // The owner changed the setting to quarters after picking a month: back to the due quarter.
    expect(resolveAlvPeriod({ link: null, choice: { key: "2026-06", kind: "month" }, vatPeriod: "quarter", now })).toBe("2026-Q3");
    expect(resolveAlvPeriod({ link: "oops", choice: null, vatPeriod: "year", now })).toBe("2026");
  });

  it("reads and offers a year as a period of its own", () => {
    expect(alvKeyKind("2026")).toBe("year");
    expect(alvKeyKind("2026-Q3")).toBe("quarter");
    expect(alvKeyKind("2026-08")).toBe("month");
    expect(periodOfKey("2026")).toEqual({ kind: "year", year: 2026 });
    expect(alvKeyForKind("year", now)).toBe("2026");
  });

  it("lists the periods of the unit, the previous year included, and never loses the shown one", () => {
    const months = alvPeriodOptions("month", 2026, "2026-08");
    expect(months).toHaveLength(24);
    expect(months.some((option) => option.value === "2025-12")).toBe(true);
    expect(alvPeriodOptions("quarter", 2026, "2026-Q3").map((option) => option.value)).toContain("2025-Q4");
    expect(alvPeriodOptions("year", 2026, "2025").map((option) => option.value)).toEqual(["2025", "2026"]);
    expect(alvPeriodOptions("year", 2026, "2023").map((option) => option.value)).toEqual(["2023", "2025", "2026"]);
  });
});

describe("the API takes a year as a VAT period (F13)", () => {
  it("accepts a bare year and covers the calendar year", () => {
    expect(alvPeriodSchema.safeParse("2026").success).toBe(true);
    expect(alvPeriodSchema.safeParse("20266").success).toBe(false);
    const { start, end } = alvPeriodBoundsUtc("2026");
    expect(start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(alvPeriodBoundsUtc("2026-Q3").start.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });
});
