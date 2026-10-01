import { describe, expect, it } from "vitest";
import {
  checkLockChange,
  isDateLocked,
  isMonthLocked,
  PeriodLockedError,
  PeriodReopenRequiredError,
} from "./period-lock";

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
    expect(error.message).toContain("tammikuu 2026");
    expect(error.message).toContain("maaliskuu 2026");
  });

  it("points to Kirjanpito > Suljetut kaudet, not to Asetukset, and shows no raw month key (F67)", () => {
    const error = new PeriodLockedError("2026-07", "2026-07");
    expect(error.message).not.toMatch(/\d{4}-\d{2}/);
    expect(error.message).not.toMatch(/asetuksista/i);
    expect(error.message).toContain("Kirjanpito > Suljetut kaudet");
    expect(error.code).toBe("PERIOD_LOCKED");
  });
});

describe("checkLockChange", () => {
  // 30.9.2026 in Helsinki: the running month is 2026-09.
  const now = new Date("2026-09-30T10:00:00.000Z");

  it("accepts locking a finished month and raising the boundary (F69)", () => {
    expect(() => checkLockChange(null, "2026-08", { now })).not.toThrow();
    expect(() => checkLockChange("2026-06", "2026-08", { now })).not.toThrow();
    expect(() => checkLockChange("2026-08", "2026-08", { now })).not.toThrow();
  });

  it("refuses the running month with the same rule as the Kuukausi page (F69)", () => {
    expect(() => checkLockChange("2026-07", "2026-09", { now })).toThrow(/kesken/);
    expect(() => checkLockChange(null, "2026-10", { now })).toThrow(/Tulevaa/);
  });

  it("uses the Helsinki month at the boundary, not the UTC month (F69)", () => {
    // 21:00 UTC on 30.9. is already 1.10. in Helsinki (EEST, UTC+3).
    expect(() => checkLockChange(null, "2026-09", { now: new Date("2026-09-30T20:59:59.000Z") })).toThrow(/kesken/);
    expect(() => checkLockChange(null, "2026-09", { now: new Date("2026-09-30T21:00:00.000Z") })).not.toThrow();
  });

  it("refuses a malformed month", () => {
    expect(() => checkLockChange(null, "2026-13", { now })).toThrow(/YYYY-MM/);
  });

  it("does not let an earlier month silently reopen later locked months (F68)", () => {
    expect(() => checkLockChange("2026-08", "2026-06", { now })).toThrow(PeriodReopenRequiredError);
    expect(() => checkLockChange("2026-08", null, { now })).toThrow(PeriodReopenRequiredError);
    try {
      checkLockChange("2026-08", "2026-06", { now });
    } catch (error) {
      expect((error as PeriodReopenRequiredError).code).toBe("PERIOD_REOPEN_REQUIRED");
      expect((error as PeriodReopenRequiredError).statusCode).toBe(409);
      expect((error as Error).message).not.toMatch(/\d{4}-\d{2}/);
    }
  });

  it("allows lowering or clearing the boundary only on an explicit reopen choice (F68)", () => {
    expect(() => checkLockChange("2026-08", "2026-06", { now, reopen: true })).not.toThrow();
    expect(() => checkLockChange("2026-08", null, { now, reopen: true })).not.toThrow();
  });

  it("treats clearing an already open ledger as nothing to reopen", () => {
    expect(() => checkLockChange(null, null, { now })).not.toThrow();
  });
});
