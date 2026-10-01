import { describe, expect, it } from "vitest";
import { lockChangeKind, lockMonthOptions, monthAfter, reopenedRangeLabel } from "./period-lock-copy";

describe("lockChangeKind", () => {
  it("tells locking, reopening and no change apart (F68)", () => {
    expect(lockChangeKind(null, "2026-06")).toBe("lock");
    expect(lockChangeKind("2026-06", "2026-08")).toBe("lock");
    expect(lockChangeKind("2026-09", "2026-06")).toBe("reopen");
    expect(lockChangeKind("2026-09", null)).toBe("reopen");
    expect(lockChangeKind("2026-09", "2026-09")).toBe("none");
    expect(lockChangeKind(null, null)).toBe("none");
  });
});

describe("monthAfter", () => {
  it("steps over a year boundary", () => {
    expect(monthAfter("2026-06")).toBe("2026-07");
    expect(monthAfter("2025-12")).toBe("2026-01");
  });
});

describe("reopenedRangeLabel", () => {
  it("names the months that become editable (F68)", () => {
    expect(reopenedRangeLabel("2026-06", "2026-09")).toBe("heinäkuu–syyskuu 2026");
    expect(reopenedRangeLabel("2026-08", "2026-09")).toBe("syyskuu 2026");
    expect(reopenedRangeLabel("2025-11", "2026-01")).toBe("joulukuu 2025–tammikuu 2026");
  });

  it("names everything up to the boundary when the lock is cleared", () => {
    expect(reopenedRangeLabel(null, "2026-09")).toBe("kaikki kuukaudet syyskuu 2026 asti");
  });
});

describe("lockMonthOptions (V46, R58)", () => {
  it("uses the Helsinki month: 01:30 on 1 October is already October there", () => {
    const options = lockMonthOptions(new Date("2026-09-30T22:30:00Z"), null);
    expect(options[0]).toBe("2026-09");
    expect(options).toHaveLength(24);
    expect(lockMonthOptions(new Date("2026-09-30T20:30:00Z"), null)[0]).toBe("2026-08");
  });

  it("never offers the running month, which the server refuses", () => {
    expect(lockMonthOptions(new Date("2026-10-15T09:00:00Z"), null)).not.toContain("2026-10");
  });

  it("still lists a lock month that is not among the finished months", () => {
    const running = lockMonthOptions(new Date("2026-10-15T09:00:00Z"), "2026-10");
    expect(running[0]).toBe("2026-10");
    const old = lockMonthOptions(new Date("2026-10-15T09:00:00Z"), "2020-01");
    expect(old[old.length - 1]).toBe("2020-01");
    expect(lockMonthOptions(new Date("2026-10-15T09:00:00Z"), "2026-06").filter((m) => m === "2026-06")).toHaveLength(1);
  });
});
