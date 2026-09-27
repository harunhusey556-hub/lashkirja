import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  NAV,
  bankTabs,
  matchNav,
  moreRoots,
  navigationViolations,
  primaryRoots,
  rootNav,
  shellShowsBack,
  statementListHref,
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

  it("keeps the sidebar and the tab bar to roots", () => {
    expect(rootNav().every((entry) => entry.kind === "root")).toBe(true);
    expect(rootNav().map((entry) => entry.label)).toEqual([
      "Etusivu",
      "Pankki",
      "Kuitit",
      "Myynti",
      "Kirjanpito",
      "Raportit",
      "Asetukset",
    ]);
    expect(primaryRoots().map((entry) => entry.label)).toEqual([
      "Etusivu",
      "Pankki",
      "Kuitit",
      "Myynti",
    ]);
    expect(moreRoots().map((entry) => entry.label)).toEqual([
      "Kirjanpito",
      "Raportit",
      "Asetukset",
    ]);
  });

  it("locks the bank workspace to four tabs", () => {
    expect(bankTabs().map((tab) => tab.label)).toEqual([
      "Yhteenveto",
      "Tapahtumat",
      "Tilit",
      "Täsmäytys",
    ]);
  });

  it("fails when a workspace, detail, or settings route is placed in root nav", () => {
    const planted: NavEntry = {
      id: "säännöt",
      kind: "workspace",
      label: "Säännöt",
      path: "/pankki/saannot",
      parent: "pankki",
      mobile: "more",
    };
    expect(navigationViolations([...NAV, planted]).some((error) => error.includes("root nav"))).toBe(true);
    expect(navigationViolations([...NAV, planted]).some((error) => error.includes("Muut"))).toBe(true);
  });

  it("fails on a third menu level", () => {
    const nested: NavEntry = {
      id: "pankki-saannot",
      kind: "workspace",
      label: "Säännöt",
      path: "/pankki/tapahtumat/saannot",
      parent: "pankki-tapahtumat",
    };
    expect(navigationViolations([...NAV, nested]).some((error) => error.includes("3-level"))).toBe(true);
  });

  it("fails when a detail has no parent", () => {
    const orphan: NavEntry = {
      id: "irrallinen",
      kind: "detail",
      label: "Irrallinen",
      path: "/irrallinen/:id",
    };
    expect(navigationViolations([...NAV, orphan]).some((error) => error.includes("without parent"))).toBe(true);
  });

  it("fails when one route has two canonical nav paths", () => {
    const alias: NavEntry = {
      id: "alv-alias",
      kind: "workspace",
      label: "ALV",
      path: "/alv-raportti",
      parent: "raportit",
    };
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

  it("gives bank pages one back owner", () => {
    expect(shellShowsBack("/pankki")).toBe(false);
    expect(shellShowsBack("/pankki/tapahtumat")).toBe(false);
    expect(shellShowsBack("/pankki/tapahtumat/stmt-1")).toBe(false);
    expect(shellShowsBack("/pankki/tilit")).toBe(false);
    expect(shellShowsBack("/asetukset/pankkiyhteys")).toBe(true);
    expect(shellShowsBack("/laskut/uusi")).toBe(true);
    expect(shellShowsBack("/dashboard")).toBe(false);
  });
});
