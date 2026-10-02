import { describe, expect, it } from "vitest";
import { edgeReleaseTiming, edgeSwipeCommits, rubberBand, sheetDragCommits, VelocityTracker } from "./gesture";

function trackerAt(times: number[], values: number[]): VelocityTracker {
  let index = 0;
  const tracker = new VelocityTracker(() => times[index]);
  tracker.reset(values[0]);
  for (index = 1; index < times.length; index += 1) tracker.add(values[index]);
  index = times.length - 1;
  return tracker;
}

describe("VelocityTracker (C8: last 100 ms, not the whole gesture)", () => {
  it("a slow drag that ends in a flick reports the flick", () => {
    // 0-1000 ms: 100 px (0.1 px/ms), then 60 px in the last 60 ms (1 px/ms).
    const tracker = trackerAt([0, 500, 1000, 1030, 1060], [0, 50, 100, 130, 160]);
    expect(tracker.velocity()).toBeGreaterThan(0.9);
  });

  it("a fast start that stops before release reports almost nothing", () => {
    const tracker = trackerAt([0, 50, 100, 400, 500], [0, 100, 200, 201, 201]);
    expect(Math.abs(tracker.velocity())).toBeLessThan(0.05);
  });
});

describe("shared thresholds", () => {
  it("edge swipe: 32% of the width, or a flick over 0.45 px/ms", () => {
    expect(edgeSwipeCommits(130, 390, 0)).toBe(true);
    expect(edgeSwipeCommits(100, 390, 0.2)).toBe(false);
    expect(edgeSwipeCommits(60, 390, 0.6)).toBe(true);
    expect(edgeSwipeCommits(160, 390, -0.8)).toBe(false);
  });

  it("sheet: 35% of the height, or a flick over 80 px at 0.5 px/ms", () => {
    expect(sheetDragCommits(300, 800, 0)).toBe(true);
    expect(sheetDragCommits(100, 800, 0.6)).toBe(true);
    expect(sheetDragCommits(70, 800, 2)).toBe(false);
    expect(sheetDragCommits(-50, 800, 2)).toBe(false);
  });

  it("rubber band approaches but never reaches the limit", () => {
    expect(rubberBand(-60)).toBeCloseTo(-30);
    expect(Math.abs(rubberBand(-5000))).toBeLessThan(60);
  });
});


describe("edge release continuity", () => {
  it("a held finger has no stale flick velocity", () => {
    let now = 0;
    const tracker = new VelocityTracker(() => now);
    tracker.reset(0);
    now = 50;
    tracker.add(90);
    expect(tracker.velocity()).toBeGreaterThan(1);
    now = 300;
    expect(tracker.velocity()).toBe(0);
    expect(edgeSwipeCommits(90, 390, tracker.velocity())).toBe(false);
  });

  it("finishes a quick flick sooner than a held long remainder", () => {
    expect(edgeReleaseTiming(150, 390, 2, true).duration).toBeLessThan(edgeReleaseTiming(150, 390, 0, true).duration);
    expect(edgeReleaseTiming(380, 390, 0, true).duration).toBe(120);
    expect(edgeReleaseTiming(40, 390, 0, true).duration).toBeLessThanOrEqual(320);
  });

  it("begins a held release at rest and keeps a backward cancel's velocity", () => {
    expect(edgeReleaseTiming(100, 390, 0, false).easing).toContain("0.3, 0,");
    expect(edgeReleaseTiming(100, 390, -1, false).easing).not.toContain("0.3, 0,");
  });
});
