import { describe, expect, it } from "vitest";
import { lockChangeKind, monthAfter, reopenedRangeLabel } from "./period-lock-copy";

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
