import { describe, expect, it } from "vitest";
import { formatEur } from "@/lib/format";
import { balanceChange, balanceTrendSummary, lineGeometry, monthShort, monthTitle, nearestIndex } from "./trend";

describe("lineGeometry", () => {
  it("needs two finite points", () => {
    expect(lineGeometry([], 100, 50)).toBeNull();
    expect(lineGeometry([5], 100, 50)).toBeNull();
    expect(lineGeometry([1, Number.NaN], 100, 50)).toBeNull();
  });

  it("spans the width and puts the highest value highest", () => {
    const g = lineGeometry([10_000, 11_000, 10_500], 206, 100)!;
    expect(g.points[0].x).toBe(6);
    expect(g.points[2].x).toBe(200);
    expect(g.points[1].y).toBeLessThan(g.points[2].y);
    expect(g.points[2].y).toBeLessThan(g.points[0].y);
    // The range is the data's own, not zero-based: the low point is near the bottom.
    expect(g.points[0].y).toBeGreaterThan(70);
    expect(g.area.endsWith("Z")).toBe(true);
  });

  it("draws a flat series in the middle", () => {
    const g = lineGeometry([3, 3, 3], 100, 100)!;
    expect(new Set(g.points.map((p) => p.y))).toEqual(new Set([50]));
  });
});

describe("nearestIndex", () => {
  it("snaps to the closest column and clamps at the ends", () => {
    expect(nearestIndex(-20, 112, 6)).toBe(0);
    expect(nearestIndex(6 + 20 * 2.4, 112, 6)).toBe(2);
    expect(nearestIndex(500, 112, 6)).toBe(5);
  });
});

describe("balance words", () => {
  const points = [
    { month: "2026-04", balance: 11_100 },
    { month: "2026-09", balance: 12_300 },
  ];

  it("names the months", () => {
    expect(monthTitle("2026-09")).toBe("Syyskuu");
    expect(monthShort("2026-01")).toBe("Tam");
  });

  it("says the change with a sign", () => {
    expect(balanceChange(points)?.text).toBe(`+${formatEur(1200)} kuukaudessa`);
    expect(balanceChange([...points].reverse())?.text.startsWith("−")).toBe(true);
    expect(balanceChange([{ balance: 1 }])).toBeNull();
  });

  it("gives VoiceOver one sentence", () => {
    expect(balanceTrendSummary(points)).toBe(
      `Pankkitilien saldo huhtikuu–syyskuu: nousi ${formatEur(1200)}, nyt ${formatEur(12_300)}.`
    );
  });
});
