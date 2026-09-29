import { describe, expect, it, beforeEach } from "vitest";
import {
  armNavigation,
  consumeDirection,
  currentTab,
  tabTarget,
  updateCurrentHref,
  fallbackBackPath,
  inAppPrevious,
  markHistoryBack,
  performInAppBack,
  previousAfterLanding,
  recordRoute,
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

  it("never infers the direction from URL depth: an unarmed landing is a push (IA-05, IA-06)", () => {
    expect(consumeDirection("/kuitit/uusi")).toBe("forward");
    // Shallower, but not a registry ancestor return: still a push.
    expect(consumeDirection("/raportit")).toBe("forward");
    // Same depth across branches (Täsmäytys -> Kuitti was "no animation").
    expect(consumeDirection("/pankki/taydennys")).toBe("forward");
  });

  it("pops only for a code return to a registry ancestor (delete -> list)", () => {
    const relate = (from: string, to: string) =>
      from === "/asiakkaat/asiakas" && to === "/asiakkaat" ? ("back" as const) : null;
    consumeDirection("/asiakkaat/asiakas", relate);
    expect(consumeDirection("/asiakkaat", relate)).toBe("back");
  });

  it("an armed forward to an ancestor stays a push (Asiakas -> Myynti link)", () => {
    consumeDirection("/asiakkaat/asiakas");
    armNavigation("/laskut", "forward");
    expect(consumeDirection("/laskut", () => "back")).toBe("forward");
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

describe("in-app back", () => {
  beforeEach(() => {
    resetNavigationForTests();
  });

  it("sends a deep link to the parent list", () => {
    recordRoute("/laskut/lasku", "none");
    expect(inAppPrevious("/laskut/lasku")).toBeNull();
    expect(fallbackBackPath("/laskut/lasku")).toBe("/laskut");
    expect(fallbackBackPath("/kuitit/kuitti")).toBe("/kuitit");
    expect(fallbackBackPath("/asetukset/profiili")).toBe("/asetukset");
  });

  it("returns to the previous in-app screen and pops on back", () => {
    recordRoute("/laskut", "none");
    recordRoute("/laskut/lasku", "forward");
    expect(inAppPrevious("/laskut/lasku")).toBe("/laskut");
    recordRoute("/laskut", "back");
    expect(inAppPrevious("/laskut")).toBeNull();
  });
});

describe("performInAppBack fallback", () => {
  it("replaces to the given parent when there is no in-app history", () => {
    resetNavigationForTests();
    const calls: string[] = [];
    performInAppBack("/asiakkaat", { back: () => calls.push("back"), replace: (href) => calls.push(href) }, "/laskut");
    expect(calls).toEqual(["/laskut"]);
  });

  it("still uses history when there is a previous in-app screen", () => {
    resetNavigationForTests();
    recordRoute("/laskut", "tab");
    recordRoute("/asiakkaat", "forward");
    const calls: string[] = [];
    performInAppBack("/asiakkaat", { back: () => calls.push("back"), replace: (href) => calls.push(href) }, "/laskut");
    expect(calls).toEqual(["back"]);
  });
});

describe("registry-aware direction and the back label source", () => {
  beforeEach(() => resetNavigationForTests());

  it("asks the registry only for an unarmed same-depth landing", () => {
    const relate = (from: string, to: string) => (from === "/kirjanpito" && to === "/kuitit" ? ("forward" as const) : null);
    consumeDirection("/kirjanpito", relate);
    expect(consumeDirection("/kuitit", relate)).toBe("forward");
    armNavigation("/kirjanpito", "tab");
    expect(consumeDirection("/kirjanpito", () => "back")).toBe("tab");
  });

  it("previousAfterLanding mirrors recordRoute without recording", () => {
    recordRoute("/dashboard", "none");
    expect(previousAfterLanding("/asetukset/sahkoposti", "forward")).toBe("/dashboard");
    recordRoute("/asetukset/sahkoposti", "forward");
    expect(previousAfterLanding("/asetukset/sahkoposti", "forward")).toBe("/dashboard");
    expect(previousAfterLanding("/dashboard", "back")).toBeNull();
  });
});

describe("per-tab stacks (IA-07, IA-25)", () => {
  beforeEach(() => resetNavigationForTests());

  it("a cross-tab push stays in the tab it started from, and back returns there", () => {
    recordRoute("/dashboard", "none");
    expect(currentTab()).toBe("etusivu");
    recordRoute("/kuitit", "forward");
    expect(currentTab()).toBe("etusivu");
    expect(inAppPrevious("/kuitit")).toBe("/dashboard");
  });

  it("a tab tap returns to that tab's last screen, and back from it is a replace", () => {
    recordRoute("/kirjanpito", "none");
    recordRoute("/kuitit", "forward");
    updateCurrentHref("/kuitit", "/kuitit?sort=date_desc");
    armNavigation("/dashboard", "tab", "etusivu");
    consumeDirection("/dashboard");
    recordRoute("/dashboard", "tab");
    expect(currentTab()).toBe("etusivu");
    expect(tabTarget("kirjanpito")).toBe("/kuitit?sort=date_desc");

    armNavigation("/kuitit", "tab", "kirjanpito");
    expect(consumeDirection("/kuitit")).toBe("tab");
    recordRoute("/kuitit", "tab");
    expect(currentTab()).toBe("kirjanpito");
    expect(inAppPrevious("/kuitit")).toBe("/kirjanpito");

    const calls: string[] = [];
    performInAppBack("/kuitit", { back: () => calls.push("back"), replace: (href) => calls.push(href) });
    expect(calls).toEqual(["/kirjanpito"]);
  });

  it("a tab with no history targets its root", () => {
    expect(tabTarget("raportit")).toBeNull();
  });
});
