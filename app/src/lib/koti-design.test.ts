import { describe, expect, it } from "vitest";
import { moneyTrend, monthIsComplete } from "./koti-design";

describe("Koti design: figures remain tied to the displayed month and accounting basis", () => {
  it("compares the displayed month with its immediate predecessor across a year boundary", () => {
    const trend = moneyTrend([
      { month: "2025-12", income: 100, expenses: 50, source: "kuitit" },
      { month: "2026-01", income: 125, expenses: 40, source: "kuitit" },
      { month: "2026-02", income: 999, expenses: 999, source: "kuitit" },
    ], "2026-01", "kuitit", "income", 150);
    expect(trend).toEqual({ previousMonth: "2025-12", points: [100, 150], percent: 50 });
  });
  it("rounds half percentages correctly despite floating-point division", () => {
    expect(moneyTrend([{ month: "2026-09", income: 1000, expenses: 0, source: "tiliote" }], "2026-10", "tiliote", "income", 1565).percent).toBe(57);
  });
  it("does not compare bank cash with document revenue", () => {
    const trend = moneyTrend([
      { month: "2026-08", income: 100, expenses: 50, source: "tiliote" },
      { month: "2026-09", income: 150, expenses: 40, source: "kuitit" },
    ], "2026-09", "kuitit", "income", 150);
    expect(trend.percent).toBeNull();
    expect(trend.points).toEqual([]);
  });
  it("does not invent percentages for absent history or a zero baseline", () => {
    expect(moneyTrend(null, "2026-09", "kuitit", "income", 150).percent).toBeNull();
    expect(moneyTrend([{ month: "2026-08", income: 0, expenses: 0, source: "kuitit" }], "2026-09", "kuitit", "income", 150).percent).toBeNull();
  });
});

describe("Koti completion state", () => {
  const ready = { done: 41, total: 41, blocking: 0, otherOpen: false, hasErrors: false, hasStatement: true };
  it("celebrates a fully reconciled month", () => expect(monthIsComplete(ready)).toBe(true));
  it("never celebrates an empty account or missing bank evidence", () => {
    expect(monthIsComplete({ ...ready, done: 0, total: 0 })).toBe(false);
    expect(monthIsComplete({ ...ready, hasStatement: false })).toBe(false);
  });
  it("keeps unresolved tasks and failures visible even when every event is matched", () => {
    expect(monthIsComplete({ ...ready, blocking: 1 })).toBe(false);
    expect(monthIsComplete({ ...ready, otherOpen: true })).toBe(false);
    expect(monthIsComplete({ ...ready, hasErrors: true })).toBe(false);
    expect(monthIsComplete({ ...ready, done: 38 })).toBe(false);
  });
});
