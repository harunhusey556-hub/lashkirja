import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { PUBLIC_PAGES, isPublicPage } from "./proxy";

const APP_DIR = path.resolve(__dirname, "app");

function pagesIn(dir: string, prefix: string): string[] {
  const routes: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      const segment = name.startsWith("[") && name.endsWith("]") ? "x" : name;
      routes.push(...pagesIn(full, `${prefix}/${segment}`));
      continue;
    }
    if (name === "page.tsx") routes.push(prefix || "/");
  }
  return routes;
}

describe("page protection", () => {
  it("lists only signed-out screens as public", () => {
    expect([...PUBLIC_PAGES].sort()).toEqual(
      ["/login", "/palauta-salasana", "/unohtunut-salasana", "/vahvista-sahkoposti"].sort()
    );
  });

  it("protects every other page, including ones added later", () => {
    const pages = pagesIn(APP_DIR, "");

    // Independent of PUBLIC_PAGES/isPublicPage: an inline literal, so a page
    // made public by accident (or a bug in isPublicPage itself) is caught.
    const acceptedAsPublic = pages.filter((route) => isPublicPage(route)).sort();
    expect(acceptedAsPublic).toEqual(
      ["/login", "/palauta-salasana", "/unohtunut-salasana", "/vahvista-sahkoposti"].sort()
    );

    // Every declared public page must actually exist as a walked route (catches
    // a stale or typo'd PUBLIC_PAGES entry).
    for (const page of PUBLIC_PAGES) {
      expect(pages).toContain(page);
    }

    expect(isPublicPage("/tyot")).toBe(false);
    expect(isPublicPage("/kirjanpito/alv")).toBe(false);
    expect(isPublicPage("/bank/callback")).toBe(false);
    expect(isPublicPage("/")).toBe(false);
  });

  it("does not treat a prefix lookalike as public", () => {
    expect(isPublicPage("/login-admin")).toBe(false);
    expect(isPublicPage("/login/extra")).toBe(false);
  });
});
