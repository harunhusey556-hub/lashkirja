import { describe, expect, it } from "vitest";
import { buildReceiptWhere } from "./receipt-filters";
import { periodScopeBoundsUtc, periodScopeSchema } from "./validation";

describe("period scope: a month or a whole year (V45, R60)", () => {
  it("accepts YYYY and YYYY-MM only", () => {
    expect(periodScopeSchema.safeParse("2025").success).toBe(true);
    expect(periodScopeSchema.safeParse("2025-09").success).toBe(true);
    expect(periodScopeSchema.safeParse("2025-13").success).toBe(false);
    expect(periodScopeSchema.safeParse("25").success).toBe(false);
  });

  it("bounds a year from 1 Jan to 1 Jan and a month as before", () => {
    expect(periodScopeBoundsUtc("2025")).toEqual({
      start: new Date(Date.UTC(2025, 0, 1)),
      end: new Date(Date.UTC(2026, 0, 1)),
    });
    expect(periodScopeBoundsUtc("2025-12")).toEqual({
      start: new Date(Date.UTC(2025, 11, 1)),
      end: new Date(Date.UTC(2026, 0, 1)),
    });
  });

  it("scopes the receipt list to the whole year", () => {
    const where = buildReceiptWhere("u1", { month: "2025" });
    expect(where.date).toEqual({ gte: new Date(Date.UTC(2025, 0, 1)), lt: new Date(Date.UTC(2026, 0, 1)) });
  });
});
