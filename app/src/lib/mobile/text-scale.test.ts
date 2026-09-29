import { describe, expect, it } from "vitest";
import { TEXT_SCALE_MAX, TEXT_SCALE_MIN, textScaleFromPreferred } from "./text-scale";

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
