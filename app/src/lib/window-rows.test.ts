import { describe, expect, it } from "vitest";
import { WINDOW_THRESHOLD, computeWindow } from "./window-rows";

describe("computeWindow", () => {
  it("renders a short list whole", () => {
    expect(computeWindow({ count: WINDOW_THRESHOLD, rowHeight: 64, listTop: 0, viewportHeight: 800 })).toEqual({
      start: 0,
      end: WINDOW_THRESHOLD,
      padTop: 0,
      padBottom: 0,
    });
  });

  it("mounts the first screenful and an overscan of a long list", () => {
    const w = computeWindow({ count: 1000, rowHeight: 64, listTop: 0, viewportHeight: 640, overscan: 5 });
    expect(w.start).toBe(0);
    expect(w.end).toBe(10 + 5);
    expect(w.padTop).toBe(0);
    expect(w.padBottom).toBe((1000 - 15) * 64);
  });

  it("moves the window with the scroll and keeps the scroll height constant", () => {
    const w = computeWindow({ count: 1000, rowHeight: 64, listTop: -6400, viewportHeight: 640, overscan: 5 });
    expect(w.start).toBe(100 - 5);
    expect(w.end).toBe(110 + 5);
    expect(w.padTop + (w.end - w.start) * 64 + w.padBottom).toBe(1000 * 64);
  });

  it("stays inside the list at the end", () => {
    const w = computeWindow({ count: 300, rowHeight: 50, listTop: -50_000, viewportHeight: 800 });
    expect(w.end).toBe(300);
    expect(w.start).toBeLessThan(300);
    expect(w.padBottom).toBe(0);
  });
});
