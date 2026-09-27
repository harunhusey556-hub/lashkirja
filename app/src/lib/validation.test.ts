import { describe, expect, it } from "vitest";
import { isDateLocked } from "./period-lock";
import { helsinkiCalendarDate, isoDateToUtc, isStrictIsoDate } from "./validation";

describe("date boundaries", () => {
  it("rejects a day that is not on the calendar", () => {
    expect(isStrictIsoDate("2026-02-31")).toBe(false);
    expect(isStrictIsoDate("2026-04-31")).toBe(false);
    expect(isStrictIsoDate("2026-13-01")).toBe(false);
  });

  it("accepts 29 February only in a leap year", () => {
    expect(isStrictIsoDate("2024-02-29")).toBe(true);
    expect(isStrictIsoDate("2025-02-29")).toBe(false);
    expect(isoDateToUtc("2024-02-29").toISOString()).toBe("2024-02-29T00:00:00.000Z");
  });

  it("locks the leap day in its UTC month and leaves the next day open", () => {
    expect(isDateLocked("2024-02", isoDateToUtc("2024-02-29"))).toBe(true);
    expect(isDateLocked("2024-02", isoDateToUtc("2024-03-01"))).toBe(false);
  });

  it("uses the Helsinki calendar date around local midnight", () => {
    expect(helsinkiCalendarDate(new Date("2026-03-28T21:30:00.000Z"))).toBe("2026-03-28");
    expect(helsinkiCalendarDate(new Date("2026-03-28T22:30:00.000Z"))).toBe("2026-03-29");
  });
});
