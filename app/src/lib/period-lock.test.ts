import { describe, expect, it } from "vitest";
import { isDateLocked, isMonthLocked, PeriodLockedError } from "./period-lock";

describe("isMonthLocked", () => {
  it("locks the watermark month and everything before it", () => {
    expect(isMonthLocked("2026-03", "2026-01")).toBe(true);
    expect(isMonthLocked("2026-03", "2026-03")).toBe(true);
    expect(isMonthLocked("2026-03", "2025-12")).toBe(true);
  });

  it("leaves later months open", () => {
    expect(isMonthLocked("2026-03", "2026-04")).toBe(false);
    expect(isMonthLocked("2026-03", "2027-01")).toBe(false);
  });

  it("locks nothing when no period has been closed", () => {
    expect(isMonthLocked(null, "2020-01")).toBe(false);
    expect(isMonthLocked(undefined, "2020-01")).toBe(false);
    expect(isMonthLocked("", "2020-01")).toBe(false);
  });

  it("ignores a malformed watermark or month rather than locking everything", () => {
    expect(isMonthLocked("2026-13", "2026-01")).toBe(false);
    expect(isMonthLocked("nonsense", "2026-01")).toBe(false);
    expect(isMonthLocked("2026-03", "not-a-month")).toBe(false);
  });

  it("compares across a year boundary correctly", () => {
    expect(isMonthLocked("2026-01", "2025-12")).toBe(true);
    expect(isMonthLocked("2025-12", "2026-01")).toBe(false);
  });
});

describe("isDateLocked", () => {
  it("uses the UTC month of the date", () => {
    expect(isDateLocked("2026-03", "2026-03-31T23:59:59.000Z")).toBe(true);
    expect(isDateLocked("2026-03", "2026-04-01T00:00:00.000Z")).toBe(false);
    expect(isDateLocked("2026-03", new Date(Date.UTC(2026, 0, 15)))).toBe(true);
  });

  it("treats a missing date as belonging to no period", () => {
    expect(isDateLocked("2026-03", null)).toBe(false);
    expect(isDateLocked("2026-03", undefined)).toBe(false);
  });
});

describe("PeriodLockedError", () => {
  it("names both the blocked month and the watermark", () => {
    const error = new PeriodLockedError("2026-01", "2026-03");
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe("PERIOD_LOCKED");
    expect(error.message).toContain("2026-01");
    expect(error.message).toContain("2026-03");
  });
});
