import { describe, expect, it, beforeEach } from "vitest";
import {
  armNavigation,
  consumeDirection,
  markHistoryBack,
  resetNavigationForTests,
} from "./nav-direction";

describe("consumeDirection", () => {
  beforeEach(() => {
    resetNavigationForTests();
    consumeDirection("/dashboard");
  });

  it("plays an armed tab even if a back was marked earlier", () => {
    markHistoryBack();
    armNavigation("/kuitit", "tab");
    expect(consumeDirection("/kuitit")).toBe("tab");
  });

  it("keeps each destination's direction when two taps land in order", () => {
    armNavigation("/kuitit", "tab");
    armNavigation("/laskut", "tab");
    expect(consumeDirection("/kuitit")).toBe("tab");
    expect(consumeDirection("/laskut")).toBe("tab");
  });

  it("treats a deeper path as forward and a shallower path as back", () => {
    expect(consumeDirection("/kuitit/uusi")).toBe("forward");
    expect(consumeDirection("/kuitit")).toBe("back");
  });

  it("uses history-back when nothing was armed for the landing path", () => {
    markHistoryBack();
    expect(consumeDirection("/tiliotteet")).toBe("back");
  });

  it("returns the same direction when the same landing is read twice", () => {
    armNavigation("/kuitit", "tab");
    expect(consumeDirection("/kuitit")).toBe("tab");
    expect(consumeDirection("/kuitit")).toBe("tab");
  });
});
