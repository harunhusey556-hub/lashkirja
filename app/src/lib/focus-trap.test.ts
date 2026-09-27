import { describe, expect, it, beforeEach } from "vitest";
import { nextFocusable, pushTrap, resetTrapsForTests, topTrapId } from "./focus-trap";

describe("focus trap cycle", () => {
  const items = ["cancel", "confirm"];

  it("wraps Tab from the last control to the first", () => {
    expect(nextFocusable(items, "confirm", false)).toBe("cancel");
  });

  it("wraps Shift+Tab from the first control to the last", () => {
    expect(nextFocusable(items, "cancel", true)).toBe("confirm");
  });

  it("pulls a focus target outside the dialog back to the first control", () => {
    expect(nextFocusable(items, "page-button", false)).toBe("cancel");
    expect(nextFocusable(items, null, true)).toBe("cancel");
  });

  it("moves one step when focus is already inside", () => {
    expect(nextFocusable(items, "cancel", false)).toBe("confirm");
    expect(nextFocusable(items, "confirm", true)).toBe("cancel");
  });

  it("has nowhere to go when the dialog has no controls", () => {
    expect(nextFocusable([], "cancel", false)).toBeNull();
  });
});

describe("stacked overlays", () => {
  beforeEach(() => {
    resetTrapsForTests();
  });

  it("lets only the top dialog own Escape, then returns to the one below", () => {
    const lower = pushTrap();
    const upper = pushTrap();
    expect(topTrapId()).toBe(upper.id);
    expect(topTrapId()).not.toBe(lower.id);
    upper.release();
    expect(topTrapId()).toBe(lower.id);
    lower.release();
    expect(topTrapId()).toBeNull();
  });

  it("does not uncover a lower dialog when a middle one closes first", () => {
    const lower = pushTrap();
    const middle = pushTrap();
    const upper = pushTrap();
    middle.release();
    expect(topTrapId()).toBe(upper.id);
    upper.release();
    expect(topTrapId()).toBe(lower.id);
  });
});
