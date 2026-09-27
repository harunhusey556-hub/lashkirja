import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { PUBLIC_PAGES, config, isPublicPage, proxy } from "./proxy";

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

/**
 * NextResponse.next() (the pass-through response) sets no `Location` header
 * and sets `x-middleware-next: "1"` (confirmed against the installed Next
 * version's own source, node_modules/next/dist/server/web/spec-extension/response.js).
 * A redirect sets `Location` and never sets `x-middleware-next`. Asserting on
 * both headers distinguishes "passed through" from "redirected" without
 * guessing at status codes alone.
 */
function expectPassThrough(response: Response) {
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("x-middleware-next")).toBe("1");
}

describe("proxy() request handling (signed out, no session cookie)", () => {
  it("lets a public API route through: POST /api/auth/login", async () => {
    const request = new NextRequest("http://127.0.0.1/api/auth/login", { method: "POST" });
    const response = await proxy(request);
    expectPassThrough(response);
  });

  it("lets a public API route through: GET /api/health", async () => {
    const request = new NextRequest("http://127.0.0.1/api/health", { method: "GET" });
    const response = await proxy(request);
    expectPassThrough(response);
  });

  it("lets a public API route through: GET /api/cron/cleanup (cron routes do their own bearer check)", async () => {
    const request = new NextRequest("http://127.0.0.1/api/cron/cleanup", { method: "GET" });
    const response = await proxy(request);
    expectPassThrough(response);
  });

  it("blocks an unauthenticated protected API route: GET /api/receipts", async () => {
    const request = new NextRequest("http://127.0.0.1/api/receipts", { method: "GET" });
    const response = await proxy(request);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("redirects an unauthenticated protected page: GET /tyot", async () => {
    const request = new NextRequest("http://127.0.0.1/tyot", { method: "GET" });
    const response = await proxy(request);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toMatch(/\/login\?next=%2Ftyot$/);
  });

  it("lets the public login page through: GET /login", async () => {
    const request = new NextRequest("http://127.0.0.1/login", { method: "GET" });
    const response = await proxy(request);
    expectPassThrough(response);
  });
});

/**
 * Regression: the previous matcher was a single pattern whose extension
 * exclusion (`.*\.(?:png|jpg|...)$`) also matched API paths ending in one of
 * those extensions, so an upload route like /api/uploads/abc.jpg never even
 * reached proxy() — it skipped the gate entirely. This table pins the matcher
 * config itself, independent of proxy()'s internal logic.
 */
describe("proxy matcher config", () => {
  const OLD_MATCHER = {
    matcher: [
      "/((?!_next/|favicon\\.ico|manifest\\.json|offline\\.html|index\\.html|icons/|.*\\.(?:png|svg|jpg|jpeg|webp|ico|txt|webmanifest)$).*)",
    ],
  };

  const cases: Array<{ url: string; matched: boolean }> = [
    { url: "http://127.0.0.1/api/uploads/abc.jpg", matched: true },
    { url: "http://127.0.0.1/api/receipts", matched: true },
    { url: "http://127.0.0.1/tyot", matched: true },
    { url: "http://127.0.0.1/kirjanpito/alv", matched: true },
    { url: "http://127.0.0.1/_next/static/x.js", matched: false },
    { url: "http://127.0.0.1/icons/icon-192.png", matched: false },
    { url: "http://127.0.0.1/manifest.json", matched: false },
    { url: "http://127.0.0.1/manifest.jsonfoo", matched: true },
  ];

  it("the OLD matcher let an API upload file skip the gate (documents the bug, not the fix)", () => {
    expect(unstable_doesMiddlewareMatch({ config: OLD_MATCHER, url: "http://127.0.0.1/api/uploads/abc.jpg" })).toBe(
      false
    );
  });

  for (const { url, matched } of cases) {
    it(`${matched ? "matches" : "does not match"}: ${url}`, () => {
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(matched);
    });
  }
});
