import { describe, expect, it } from "vitest";
import { nextRotation, nextZoom } from "./document-viewer";

describe("document viewer", () => {
  it("cycles zoom and rotation", () => {
    expect(nextZoom(1)).toBe(1.5);
    expect(nextZoom(1.5)).toBe(2);
    expect(nextZoom(2)).toBe(1);
    expect(nextZoom(9)).toBe(1);
    expect(nextRotation(0)).toBe(90);
    expect(nextRotation(270)).toBe(0);
    expect(nextRotation(-90)).toBe(0);
  });
});
