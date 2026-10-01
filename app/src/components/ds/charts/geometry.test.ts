import { describe, expect, it } from "vitest";
import {
  barMetrics, barRect, columnIndexAt, groupTopN, labelMode, niceScale, relativeFractions,
  segmentFill, shareLabel, shortLabel, sparkGeometry, stackShares, valueFraction, OTHER_KEY,
} from "./geometry";

describe("niceScale", () => {
  it("rounds the maximum up to a nice step with at most three gridlines", () => {
    for (const max of [0.37, 1, 7, 99, 100, 101, 1234, 5000, 5001, 87654, 1_234_567]) {
      const scale = niceScale([max, max / 3]);
      expect(scale.ticks.length).toBeLessThanOrEqual(3);
      expect(scale.max).toBeGreaterThanOrEqual(max - 1e-9);
      expect(scale.min).toBe(0);
      // the ticks end at the axis maximum
      expect(scale.ticks[scale.ticks.length - 1]).toBe(scale.max);
    }
  });

  it("keeps the axis tight: under 2.5 times the data", () => {
    for (const max of [3, 12, 55, 130, 420, 999, 1001, 2600, 40000]) {
      const scale = niceScale([max]);
      expect(scale.max / max).toBeLessThan(2.5);
    }
  });

  it("gives 0..1 and no gridlines for empty and all-zero data", () => {
    expect(niceScale([])).toEqual({ min: 0, max: 1, step: 1, ticks: [] });
    expect(niceScale([0, 0, 0])).toEqual({ min: 0, max: 1, step: 1, ticks: [] });
  });

  it("ignores NaN and Infinity", () => {
    const scale = niceScale([Number.NaN, Infinity, 200]);
    expect(scale.max).toBeGreaterThanOrEqual(200);
    expect(Number.isFinite(scale.max)).toBe(true);
  });

  it("extends below zero for negative values and never exceeds the line budget", () => {
    const scale = niceScale([400, -150]);
    expect(scale.min).toBeLessThanOrEqual(-150);
    expect(scale.max).toBeGreaterThanOrEqual(400);
    expect(scale.ticks.length).toBeLessThanOrEqual(3);
    expect(scale.ticks).not.toContain(0);
    const onlyNegative = niceScale([-80, -20]);
    expect(onlyNegative.max).toBe(0);
    expect(onlyNegative.min).toBeLessThanOrEqual(-80);
  });

  it("handles a single equal value", () => {
    const scale = niceScale([500, 500, 500]);
    expect(scale.max).toBeGreaterThanOrEqual(500);
    expect(scale.ticks.length).toBeGreaterThan(0);
  });

  it("handles cent-sized values without float noise", () => {
    const scale = niceScale([0.07]);
    expect(scale.max).toBeGreaterThanOrEqual(0.07);
    for (const tick of scale.ticks) expect(String(tick).length).toBeLessThan(8);
  });
});

describe("valueFraction and barRect", () => {
  it("clamps to the axis and survives a flat axis", () => {
    expect(valueFraction(50, 0, 100)).toBe(0.5);
    expect(valueFraction(500, 0, 100)).toBe(1);
    expect(valueFraction(-5, 0, 100)).toBe(0);
    expect(valueFraction(5, 10, 10)).toBe(0);
    expect(valueFraction(Number.NaN, 0, 100)).toBe(0);
  });

  it("draws a positive bar up from zero and a negative one down from it", () => {
    expect(barRect(50, 0, 100)).toEqual({ bottom: 0, height: 0.5 });
    const up = barRect(50, -100, 100);
    expect(up.bottom).toBeCloseTo(0.5);
    expect(up.height).toBeCloseTo(0.25);
    const down = barRect(-50, -100, 100);
    expect(down.bottom).toBeCloseTo(0.25);
    expect(down.height).toBeCloseTo(0.25);
    expect(barRect(0, -100, 100).height).toBe(0);
  });
});

describe("barMetrics", () => {
  it("keeps a pair inside its column and bars between 3 and 14 px", () => {
    for (const [width, count] of [[204, 12], [256, 12], [320, 6], [900, 6], [60, 12], [0, 12]] as const) {
      const m = barMetrics(width, count);
      expect(m.barWidth).toBeGreaterThanOrEqual(3);
      expect(m.barWidth).toBeLessThanOrEqual(14);
      if (m.columnWidth >= 14) expect(m.barWidth * 2 + m.gap).toBeLessThanOrEqual(m.columnWidth);
    }
    expect(barMetrics(900, 6).barWidth).toBe(14);
    expect(barMetrics(204, 12).barWidth).toBe(5);
  });

  it("copes with zero items and bad widths", () => {
    expect(barMetrics(Number.NaN, 0).columnWidth).toBe(0);
    expect(barMetrics(-10, 3).columnWidth).toBe(0);
  });
});

describe("labels and hit testing", () => {
  it("shows full labels only when the column is wide enough", () => {
    expect(labelMode(17, 4, 11)).toBe("short");
    expect(labelMode(36, 4, 11)).toBe("full");
    expect(labelMode(30, 4, 11)).toBe("short");
    expect(labelMode(40, 4, 17)).toBe("short");
  });

  it("shortens to one uppercase letter", () => {
    expect(shortLabel("syys")).toBe("S");
    expect(shortLabel("  äh")).toBe("Ä");
    expect(shortLabel("")).toBe("");
  });

  it("maps x to the column under it, clamped", () => {
    expect(columnIndexAt(0, 120, 6)).toBe(0);
    expect(columnIndexAt(19.9, 120, 6)).toBe(0);
    expect(columnIndexAt(20, 120, 6)).toBe(1);
    expect(columnIndexAt(-30, 120, 6)).toBe(0);
    expect(columnIndexAt(500, 120, 6)).toBe(5);
    expect(columnIndexAt(10, 0, 6)).toBe(0);
    expect(columnIndexAt(10, 120, 0)).toBe(-1);
  });
});

describe("groupTopN", () => {
  const item = (key: string, valueCents: number) => ({ key, label: key, valueCents });

  it("sorts descending and drops zero and negative", () => {
    const rows = groupTopN([item("b", 100), item("a", 300), item("z", 0), item("n", -5)], 5);
    expect(rows.map((r) => r.key)).toEqual(["a", "b"]);
  });

  it("collapses the tail into one Muut row that sums it", () => {
    const rows = groupTopN(
      [item("a", 700), item("b", 600), item("c", 500), item("d", 400), item("e", 300), item("f", 200), item("g", 100)],
      5,
    );
    expect(rows).toHaveLength(6);
    expect(rows[5]).toMatchObject({ key: OTHER_KEY, label: "Muut", valueCents: 300, isOther: true });
  });

  it("shows a single leftover as itself instead of a lone Muut", () => {
    const rows = groupTopN([item("a", 6), item("b", 5), item("c", 4), item("d", 3), item("e", 2), item("f", 1)], 5);
    expect(rows).toHaveLength(6);
    expect(rows.some((r) => r.isOther)).toBe(false);
  });

  it("breaks ties by label and handles an empty list", () => {
    expect(groupTopN([item("b", 1), item("a", 1)], 5).map((r) => r.key)).toEqual(["a", "b"]);
    expect(groupTopN([], 5)).toEqual([]);
  });
});

describe("relativeFractions and shareLabel", () => {
  it("scales to the largest row", () => {
    expect(relativeFractions([50, 100, 25])).toEqual([0.5, 1, 0.25]);
    expect(relativeFractions([0, 0])).toEqual([0, 0]);
    expect(relativeFractions([])).toEqual([]);
  });

  it("prints a fi-FI percentage with a non-breaking space", () => {
    expect(shareLabel(50, 200)).toBe("25 %");
    expect(shareLabel(1, 1000)).toBe("< 1 %");
    expect(shareLabel(0, 100)).toBe("");
    expect(shareLabel(5, 0)).toBe("");
    expect(shareLabel(100, 100)).toBe("100 %");
  });
});

describe("segmentFill", () => {
  it("never lies at the ends", () => {
    expect(segmentFill(41, 41)).toEqual({ segments: 12, filled: 12 });
    expect(segmentFill(0, 41)).toEqual({ segments: 12, filled: 0 });
    expect(segmentFill(1, 41).filled).toBe(1);
    expect(segmentFill(40, 41).filled).toBe(11);
  });

  it("matches the mockup proportion", () => {
    expect(segmentFill(38, 41)).toEqual({ segments: 12, filled: 11 });
  });

  it("uses one pill per item up to 12 and draws nothing for no items", () => {
    expect(segmentFill(3, 5)).toEqual({ segments: 5, filled: 3 });
    expect(segmentFill(0, 0)).toEqual({ segments: 0, filled: 0 });
    expect(segmentFill(1, 1)).toEqual({ segments: 1, filled: 1 });
    expect(segmentFill(0, 1)).toEqual({ segments: 1, filled: 0 });
  });

  it("clamps bad input", () => {
    expect(segmentFill(99, 10)).toEqual({ segments: 10, filled: 10 });
    expect(segmentFill(-4, 10)).toEqual({ segments: 10, filled: 0 });
    expect(segmentFill(Number.NaN, 10)).toEqual({ segments: 10, filled: 0 });
  });
});

describe("stackShares", () => {
  it("sums to 1 and follows the values", () => {
    expect(stackShares([50, 25, 25])).toEqual([0.5, 0.25, 0.25]);
  });

  it("keeps a tiny non-zero part visible and still sums to 1", () => {
    const shares = stackShares([10000, 1, 5000]);
    expect(shares[1]).toBeCloseTo(0.03);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it("gives zero and negative nothing and handles an all-zero stack", () => {
    expect(stackShares([100, 0, -5])).toEqual([1, 0, 0]);
    expect(stackShares([0, 0])).toEqual([0, 0]);
    expect(stackShares([])).toEqual([]);
  });
});

describe("sparkGeometry", () => {
  it("returns null without points and a dot for one", () => {
    expect(sparkGeometry([])).toBeNull();
    expect(sparkGeometry([Number.NaN])).toBeNull();
    expect(sparkGeometry([5])).toEqual({ path: "", last: { x: 50, y: 50 } });
  });

  it("draws a flat line through the middle for equal values", () => {
    const g = sparkGeometry([7, 7, 7]);
    expect(g?.path).toBe("M3 50 L50 50 L97 50");
    expect(g?.last).toEqual({ x: 97, y: 50 });
  });

  it("puts higher values higher up and ends at the last point", () => {
    const g = sparkGeometry([0, 10, 5]);
    expect(g?.path).toBe("M3 86 L50 14 L97 50");
    expect(g?.last).toEqual({ x: 97, y: 50 });
  });

  it("skips non-finite points", () => {
    expect(sparkGeometry([1, Number.NaN, 3])?.path).toBe("M3 86 L97 14");
  });
});
