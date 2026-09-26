import { describe, expect, it } from "vitest";
import { usableArea } from "./usable-area";

describe("usableArea", () => {
  it("fills the webview when the visual viewport already matches it", () => {
    const area = usableArea({
      innerHeight: 956,
      offsetTop: 0,
      viewportHeight: 956,
      editableFocused: false,
    });
    expect(area.frameTop).toBe(0);
    expect(area.frameBottom).toBe(0);
    expect(area.safeTopFallback).toBe(0);
    expect(area.safeBottomFallback).toBe(0);
    expect(area.keyboardOpen).toBe(false);
  });

  it("keeps a full frame when the visual viewport stops above the home indicator", () => {
    const area = usableArea({
      innerHeight: 956,
      offsetTop: 0,
      viewportHeight: 922,
      editableFocused: false,
    });
    expect(area.frameTop).toBe(0);
    expect(area.frameBottom).toBe(0);
    expect(area.keyboardOpen).toBe(false);
    expect(area.safeBottomFallback).toBe(34);
    expect(area.safeTopFallback).toBe(0);
  });

  it("does not shift the frame when offsetTop already equals the notch", () => {
    const area = usableArea({
      innerHeight: 956,
      offsetTop: 62,
      viewportHeight: 860,
      editableFocused: false,
    });
    expect(area.frameTop).toBe(0);
    expect(area.frameBottom).toBe(0);
    expect(area.keyboardOpen).toBe(false);
    expect(area.safeTopFallback).toBe(62);
    expect(area.safeBottomFallback).toBe(34);
  });

  it("lifts the frame above a keyboard and clears the home-indicator pad", () => {
    const area = usableArea({
      innerHeight: 956,
      offsetTop: 0,
      viewportHeight: 520,
      editableFocused: true,
    });
    expect(area.keyboardOpen).toBe(true);
    expect(area.frameTop).toBe(0);
    expect(area.frameBottom).toBe(436);
    expect(area.safeTopFallback).toBe(0);
    expect(area.safeBottomFallback).toBe(0);
  });

  it("does not treat a keyboard-sized gap as a keyboard when nothing is focused", () => {
    const area = usableArea({
      innerHeight: 956,
      offsetTop: 0,
      viewportHeight: 520,
      editableFocused: false,
    });
    expect(area.keyboardOpen).toBe(false);
    expect(area.frameTop).toBe(0);
    expect(area.frameBottom).toBe(0);
    expect(area.safeBottomFallback).toBe(0);
  });

  it("does not pad the notch twice when the keyboard also shifts offsetTop", () => {
    const area = usableArea({
      innerHeight: 956,
      offsetTop: 62,
      viewportHeight: 480,
      editableFocused: true,
    });
    expect(area.keyboardOpen).toBe(true);
    expect(area.frameTop).toBe(62);
    expect(area.frameBottom).toBe(956 - 62 - 480);
    expect(area.safeTopFallback).toBe(0);
    expect(area.safeBottomFallback).toBe(0);
  });

  it("ignores a focused gap that is still shorter than a keyboard", () => {
    const area = usableArea({
      innerHeight: 844,
      offsetTop: 0,
      viewportHeight: 844 - 119,
      editableFocused: true,
    });
    expect(area.keyboardOpen).toBe(false);
    expect(area.frameBottom).toBe(0);
    expect(area.safeBottomFallback).toBe(0);
  });
});
