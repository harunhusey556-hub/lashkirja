import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  NAV,
  avatarRoot,
  backTarget,
  matchNav,
  navigationViolations,
  shellShowsBack,
  statementListHref,
  tabRoots,
  type NavEntry,
} from "./navigation";

const APP_DIR = path.resolve(__dirname, "../app");

/** Signed-out or bank-return screens. They are not product navigation. */
const BARE_ROUTES = new Set([
  "/",
  "/login",
  "/bank/callback",
  "/unohtunut-salasana",
  "/palauta-salasana",
  "/vahvista-sahkoposti",
]);

function pagesIn(dir: string, prefix: string): string[] {
  const routes: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      const segment = name.startsWith("[") && name.endsWith("]") ? `:${name.slice(1, -1)}` : name;
      routes.push(...pagesIn(full, `${prefix}/${segment}`));
      continue;
    }
    if (name === "page.tsx") routes.push(prefix || "/");
  }
  return routes;
}

describe("navigation registry", () => {
  it("accepts the locked product map", () => {
    expect(navigationViolations()).toEqual([]);
  });

  it("has four tab roots in order and Asetukset behind the avatar", () => {
    expect(tabRoots().map((entry) => entry.label)).toEqual(["Koti", "Myynti", "Kirjanpito", "Raportit"]);
    expect(tabRoots().map((entry) => entry.path)).toEqual(["/dashboard", "/laskut", "/kirjanpito", "/raportit"]);
    expect(avatarRoot().id).toBe("asetukset");
    expect(avatarRoot().path).toBe("/asetukset");
  });

  it("fails when a fifth tab root is added", () => {
    const extra: NavEntry = { id: "pankki", kind: "root", label: "Pankki", path: "/pankki", placement: "tab" };
    expect(navigationViolations([...NAV, extra]).some((error) => error.includes("tab roots"))).toBe(true);
  });

  it("fails when a non-root claims a placement", () => {
    const planted: NavEntry = {
      id: "saannot",
      kind: "workspace",
      label: "Säännöt",
      path: "/kirjanpito/saannot",
      parent: "kirjanpito",
      placement: "tab",
    };
    expect(navigationViolations([...NAV, planted]).some((error) => error.includes("placement"))).toBe(true);
  });

  it("fails on a third menu level", () => {
    const nested: NavEntry = {
      id: "kuitit-saannot",
      kind: "workspace",
      label: "Säännöt",
      path: "/kuitit/saannot",
      parent: "kuitit",
    };
    expect(navigationViolations([...NAV, nested]).some((error) => error.includes("3-level"))).toBe(true);
  });

  it("fails when a detail has no parent", () => {
    const orphan: NavEntry = { id: "irrallinen", kind: "detail", label: "Irrallinen", path: "/irrallinen/:id" };
    expect(navigationViolations([...NAV, orphan]).some((error) => error.includes("without parent"))).toBe(true);
  });

  it("fails when one route has two canonical nav paths", () => {
    const alias: NavEntry = { id: "alv-alias", kind: "workspace", label: "ALV", path: "/kirjanpito/alv", parent: "raportit" };
    expect(navigationViolations([...NAV, alias]).some((error) => error.includes("duplicate path"))).toBe(true);
  });

  it("classifies every product page", () => {
    const missing = pagesIn(APP_DIR, "").filter((route) => !BARE_ROUTES.has(route) && !matchNav(route));
    expect(missing).toEqual([]);
  });

  it("keeps the statement list query across detail", () => {
    expect(statementListHref("?month=2026-03&account=acc-1&q=holvi&unrelated=1")).toBe(
      "/pankki/tapahtumat?month=2026-03&account=acc-1&q=holvi"
    );
    expect(statementListHref("")).toBe("/pankki/tapahtumat");
  });

  it("shows the shell back on every non-root page, never on a root", () => {
    for (const root of [...tabRoots(), avatarRoot()]) {
      expect(shellShowsBack(root.path)).toBe(false);
    }
    expect(shellShowsBack("/kirjanpito/alv")).toBe(true);
    expect(shellShowsBack("/pankki/tapahtumat")).toBe(true);
    expect(shellShowsBack("/asiakkaat")).toBe(true);
    expect(shellShowsBack("/asetukset/profiili")).toBe(true);
  });

  it("labels back with the registry parent", () => {
    expect(backTarget("/kirjanpito/alv")).toEqual({ label: "Kirjanpito", href: "/kirjanpito" });
    expect(backTarget("/pankki/tapahtumat/abc")).toEqual({ label: "Tapahtumat", href: "/pankki/tapahtumat" });
    expect(backTarget("/asiakkaat/42")).toEqual({ label: "Asiakkaat", href: "/asiakkaat" });
    expect(backTarget("/asiakkaat")).toEqual({ label: "Myynti", href: "/laskut" });
    expect(backTarget("/asetukset/tili/salasana")).toEqual({ label: "Tili", href: "/asetukset/tili" });
    expect(backTarget("/dashboard")).toBeNull();
  });

  it("returns null when the parent chain ends on a parameterised parent with no parent of its own", () => {
    const planted: NavEntry[] = [
      { id: "x-parent", kind: "workspace", label: "X", path: "/x/:pid" },
      { id: "x-detail", kind: "detail", label: "X-detail", path: "/x/:pid/:id", parent: "x-parent" },
    ];
    // x-parent's own path still has a `:param` and it has no parent to climb
    // to, so there is no registry-derivable back target left.
    expect(backTarget("/x/5/9", [...NAV, ...planted])).toBeNull();
  });
});
