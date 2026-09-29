import { describe, expect, it } from "vitest";
import { TEXT_SCALE_MAX, TEXT_SCALE_MIN, textScaleCss, textScaleFromPreferred } from "./text-scale";

describe("textScaleFromPreferred (AX-01)", () => {
  it("keeps the default iOS size at 1", () => {
    expect(textScaleFromPreferred(1)).toBe(1);
  });

  it("maps the larger sizes and rounds to two decimals", () => {
    expect(textScaleFromPreferred(23 / 17)).toBe(1.35);
    expect(textScaleFromPreferred(28 / 17)).toBe(1.65);
  });

  it("clamps to the verified range", () => {
    expect(textScaleFromPreferred(53 / 17)).toBe(TEXT_SCALE_MAX);
    expect(textScaleFromPreferred(0.5)).toBe(TEXT_SCALE_MIN);
  });

  it("treats a missing or bad value as 1", () => {
    expect(textScaleFromPreferred(undefined)).toBe(1);
    expect(textScaleFromPreferred(Number.NaN)).toBe(1);
    expect(textScaleFromPreferred(0)).toBe(1);
    expect(textScaleFromPreferred("1.2")).toBe(1);
  });
});

describe("textScaleCss (AX-26)", () => {
  it("keeps two-line clamps at the default and small sizes", () => {
    expect(textScaleCss(1.1)).toBe(":root{--text-scale:1.1}");
  });

  it("lifts the clamps from 130% up so secondary lines are never cut", () => {
    expect(textScaleCss(1.35)).toContain(".clamp-lines{display:block;-webkit-line-clamp:unset;overflow:visible}");
    expect(textScaleCss(2)).toContain("--text-scale:2");
  });
});
