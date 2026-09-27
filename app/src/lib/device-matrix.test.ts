import { describe, expect, it } from "vitest";
import { DEVICE_PROFILES, contentClearsChrome, profileLayout } from "./device-matrix";

describe("device matrix", () => {
  it("covers compact and large phones in portrait, landscape, and with a keyboard", () => {
    expect(DEVICE_PROFILES.map((profile) => profile.id)).toEqual([
      "compact-portrait",
      "large-portrait",
      "compact-landscape",
      "large-landscape",
      "compact-keyboard",
      "large-keyboard",
    ]);
    expect(DEVICE_PROFILES.find((profile) => profile.id === "compact-portrait")?.width).toBe(390);
    expect(DEVICE_PROFILES.find((profile) => profile.id === "large-portrait")?.width).toBe(430);
  });

  it("keeps the frame full under a notch or Dynamic Island", () => {
    for (const id of ["compact-portrait", "large-portrait"] as const) {
      const profile = DEVICE_PROFILES.find((item) => item.id === id)!;
      const layout = profileLayout(profile);
      expect(layout.frameTop).toBe(0);
      expect(layout.frameBottom).toBe(0);
      expect(layout.keyboardOpen).toBe(false);
      expect(layout.safeTopFallback).toBe(profile.offsetTop);
      expect(layout.safeBottomFallback).toBe(34);
      expect(contentClearsChrome(layout.contentWidth)).toBe(true);
    }
  });

  it("keeps a full frame in landscape and leaves room beside the side insets", () => {
    for (const id of ["compact-landscape", "large-landscape"] as const) {
      const profile = DEVICE_PROFILES.find((item) => item.id === id)!;
      const layout = profileLayout(profile);
      expect(layout.keyboardOpen).toBe(false);
      expect(layout.frameTop).toBe(0);
      expect(layout.frameBottom).toBe(0);
      expect(layout.safeBottomFallback).toBe(21);
      expect(layout.contentWidth).toBe(profile.width - profile.safeLeft - profile.safeRight);
      expect(contentClearsChrome(layout.contentWidth)).toBe(true);
    }
  });

  it("lifts the frame for a keyboard and does not store that gap as a home indicator", () => {
    for (const id of ["compact-keyboard", "large-keyboard"] as const) {
      const profile = DEVICE_PROFILES.find((item) => item.id === id)!;
      const layout = profileLayout(profile);
      expect(layout.keyboardOpen).toBe(true);
      expect(layout.frameBottom).toBeGreaterThanOrEqual(120);
      expect(layout.safeTopFallback).toBe(0);
      expect(layout.safeBottomFallback).toBe(0);
      expect(contentClearsChrome(layout.contentWidth)).toBe(true);
    }
  });
});
