import { describe, expect, it } from "vitest";
import { formatUsageGaps, isUsageGap, tallyUsageGaps } from "./usage-gap";

describe("isUsageGap", () => {
  it("takes only the known buckets and screens", () => {
    expect(isUsageGap("1-3d", "launch")).toBe(true);
    expect(isUsageGap(">30d", "foreground")).toBe(true);
    expect(isUsageGap("2d", "launch")).toBe(false);
    expect(isUsageGap("1-3d", "settings")).toBe(false);
    expect(isUsageGap(undefined, "launch")).toBe(false);
  });
});

describe("tallyUsageGaps + formatUsageGaps", () => {
  const events = [
    { kind: "usage_gap", name: "<1h", screen: "foreground" },
    { kind: "usage_gap", name: "<1h", screen: "foreground" },
    { kind: "usage_gap", name: "<1h", screen: "launch" },
    { kind: "usage_gap", name: ">30d", screen: "launch" },
    { kind: "usage_gap", name: "bogus", screen: "launch" },
    { kind: "screen", name: "<1h", screen: "launch" },
  ];

  it("counts per bucket and screen and skips everything else", () => {
    const counts = tallyUsageGaps(events);
    expect(counts["<1h"]).toEqual({ launch: 1, foreground: 2 });
    expect(counts[">30d"]).toEqual({ launch: 1, foreground: 0 });
  });

  it("counts an event of a batch sent again once, by its eventId", () => {
    const resent = [
      { eventId: "a1", kind: "usage_gap", name: "1-3d", screen: "launch" },
      { eventId: "a2", kind: "usage_gap", name: "1-3d", screen: "foreground" },
      { eventId: "a1", kind: "usage_gap", name: "1-3d", screen: "launch" },
      { eventId: "a2", kind: "usage_gap", name: "1-3d", screen: "foreground" },
      { eventId: "a3", kind: "usage_gap", name: "1-3d", screen: "launch" },
    ];
    expect(tallyUsageGaps(resent)["1-3d"]).toEqual({ launch: 2, foreground: 1 });
  });

  it("prints counts with percentages of each column", () => {
    const lines = formatUsageGaps(tallyUsageGaps(events)).split("\n");
    expect(lines).toHaveLength(9);
    expect(lines[1]).toMatch(/^<1h\s+1\s+50\.0%\s+2\s+100\.0%$/);
    expect(lines[7]).toMatch(/^>30d\s+1\s+50\.0%\s+0\s+0\.0%$/);
    expect(lines[8]).toMatch(/^total\s+2\s+100\.0%\s+2\s+100\.0%$/);
  });

  it("prints dashes instead of dividing by zero", () => {
    expect(formatUsageGaps(tallyUsageGaps([])).split("\n")[1]).toMatch(/^<1h\s+0\s+-\s+0\s+-$/);
  });
});
