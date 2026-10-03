import { describe, expect, it } from "vitest";
import { CODE128_PATTERNS, code128cBars, code128cValues } from "./code128";

/** Decodes bar widths back to code values, to prove what the bars carry. */
function decode(bars: number[]): number[] {
  const values: number[] = [];
  let i = 0;
  while (i < bars.length) {
    const take = values.length > 0 && bars.length - i === 7 ? 7 : 6;
    const chunk = bars.slice(i, i + take).join("");
    const value = CODE128_PATTERNS.indexOf(chunk);
    expect(value).toBeGreaterThanOrEqual(0);
    values.push(value);
    i += take;
  }
  return values;
}

describe("Code 128 subset C", () => {
  it("has a well-formed pattern table", () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    CODE128_PATTERNS.forEach((pattern, value) => {
      const modules = [...pattern].reduce((sum, digit) => sum + Number(digit), 0);
      expect(modules).toBe(value === 106 ? 13 : 11);
    });
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
  });

  it("encodes digit pairs with start C, the checksum and stop", () => {
    // (105 + 1·12 + 2·34) mod 103 = 82
    expect(code128cValues("1234")).toEqual([105, 12, 34, 82, 106]);
  });

  it("draws bars that decode back to the same values", () => {
    const barcode = "421123456000007850000488315000000000000000012345612606 12".replace(/\s/g, "");
    const digits = barcode.slice(0, 54);
    const bars = code128cBars(digits);
    expect(decode(bars)).toEqual(code128cValues(digits));
    // 1 start + 27 pairs + checksum = 29 symbols × 11 modules, plus the 13-module stop.
    expect(bars.reduce((sum, w) => sum + w, 0)).toBe(29 * 11 + 13);
  });

  it("refuses anything but an even number of digits", () => {
    expect(() => code128cValues("123")).toThrow();
    expect(() => code128cValues("12a4")).toThrow();
  });
});

describe("barcodeRects", () => {
  const digits = "421123456000007850000488315000000000000000012345612606".slice(0, 54);

  it("lays the bars out inside the given width with quiet zones", async () => {
    const { barcodeRects } = await import("./code128");
    const layout = barcodeRects(digits, { x: 50, y: 100, maxWidth: 495, height: 36 });
    // 29 six-element symbols × 3 bars + the stop's 4 bars.
    expect(layout.rects).toHaveLength(29 * 3 + 4);
    const first = layout.rects[0];
    const last = layout.rects[layout.rects.length - 1];
    expect(first.x).toBeGreaterThanOrEqual(50 + 10 * layout.module - 0.001);
    expect(last.x + last.width).toBeLessThanOrEqual(50 + 495);
    expect(layout.module).toBeLessThanOrEqual(1.42); // never wider than 0.5 mm
    expect(layout.rects.every((r) => r.height === 36 && r.y === 100)).toBe(true);
  });
});
