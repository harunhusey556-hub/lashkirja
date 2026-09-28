import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { sealData } from "iron-session";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { PUBLIC_PAGES, config, isPublicPage, proxy } from "./proxy";
import { sealBearerToken } from "@/lib/auth-credential";
import { sessionOptions } from "@/lib/session-options";
import { DEV_EMULATION_ORIGIN } from "@/lib/app-origins";

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

// Signed-out screens, plus /bank/callback (Task 11): an app-started bank
// consent lands there from Capacitor's in-app Browser, a separate browsing
// context with no session cookie, so this page must render (and do its own
// bounce back into lashkirja://) before any login gate could apply. See the
// comment on PUBLIC_PAGES in proxy.ts.
const EXPECTED_PUBLIC_PAGES = [
  "/login",
  "/palauta-salasana",
  "/unohtunut-salasana",
  "/vahvista-sahkoposti",
  "/bank/callback",
];

describe("page protection", () => {
  it("lists only signed-out screens (plus the app-started bank return) as public", () => {
    expect([...PUBLIC_PAGES].sort()).toEqual([...EXPECTED_PUBLIC_PAGES].sort());
  });

  it("protects every other page, including ones added later", () => {
    const pages = pagesIn(APP_DIR, "");

    // Independent of PUBLIC_PAGES/isPublicPage: an inline literal, so a page
    // made public by accident (or a bug in isPublicPage itself) is caught.
    const acceptedAsPublic = pages.filter((route) => isPublicPage(route)).sort();
    expect(acceptedAsPublic).toEqual([...EXPECTED_PUBLIC_PAGES].sort());

    // Every declared public page must actually exist as a walked route (catches
    // a stale or typo'd PUBLIC_PAGES entry).
    for (const page of PUBLIC_PAGES) {
      expect(pages).toContain(page);
    }

    expect(isPublicPage("/tyot")).toBe(false);
    expect(isPublicPage("/kirjanpito/alv")).toBe(false);
    expect(isPublicPage("/")).toBe(false);
  });

  it("still requires a session for /bank (everything except the callback page itself)", () => {
    expect(isPublicPage("/bank/callback")).toBe(true);
    expect(isPublicPage("/bank")).toBe(false);
    expect(isPublicPage("/bank/callback/extra")).toBe(false);
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

async function bearerHeader(): Promise<string> {
  const { token } = await sealBearerToken({
    userId: "user-1",
    email: "demo@lashkirja.fi",
    firstName: "Demo",
    sessionId: "session-1",
  });
  return `Bearer ${token}`;
}

async function webCookie(): Promise<string> {
  const sealed = await sealData(
    { userId: "user-1", email: "demo@lashkirja.fi", firstName: "Demo" },
    { password: sessionOptions.password as string, ttl: sessionOptions.ttl }
  );
  return `${sessionOptions.cookieName}=${sealed}`;
}

describe("proxy() CORS and app-origin gate (Task 2)", () => {
  it("OPTIONS with an allowed app origin: 204 with the preflight headers", async () => {
    const request = new NextRequest("http://127.0.0.1/api/dashboard", {
      method: "OPTIONS",
      headers: { origin: DEV_EMULATION_ORIGIN },
    });
    const response = await proxy(request);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(DEV_EMULATION_ORIGIN);
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, PUT, PATCH, DELETE, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "Authorization, Content-Type, Idempotency-Key, Accept"
    );
    expect(response.headers.get("access-control-max-age")).toBe("600");
    expect(response.headers.get("vary")).toBe("Origin");
    expect(response.headers.get("x-lashkirja-api-version")).toBe("1");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("OPTIONS with a foreign origin: 403, no Access-Control-* headers", async () => {
    const request = new NextRequest("http://127.0.0.1/api/dashboard", {
      method: "OPTIONS",
      headers: { origin: "https://evil.test" },
    });
    const response = await proxy(request);
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("x-lashkirja-api-version")).toBe("1");
  });

  it("public API with an allowed origin: passes through with CORS + version headers", async () => {
    const request = new NextRequest("http://127.0.0.1/api/auth/token", {
      method: "POST",
      headers: { origin: DEV_EMULATION_ORIGIN },
    });
    const response = await proxy(request);
    expectPassThrough(response);
    expect(response.headers.get("access-control-allow-origin")).toBe(DEV_EMULATION_ORIGIN);
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "Retry-After, Content-Disposition, X-LashKirja-Api-Version"
    );
    expect(response.headers.get("x-lashkirja-api-version")).toBe("1");
  });

  it("protected API with a bearer: passes through with CORS + version headers", async () => {
    const request = new NextRequest("http://127.0.0.1/api/dashboard", {
      method: "GET",
      headers: { origin: DEV_EMULATION_ORIGIN, authorization: await bearerHeader() },
    });
    const response = await proxy(request);
    expectPassThrough(response);
    expect(response.headers.get("access-control-allow-origin")).toBe(DEV_EMULATION_ORIGIN);
    expect(response.headers.get("x-lashkirja-api-version")).toBe("1");
  });

  it("protected API with a cookie from the web (no Origin): passes through, no CORS headers", async () => {
    const request = new NextRequest("http://127.0.0.1/api/dashboard", {
      method: "GET",
      headers: { cookie: await webCookie() },
    });
    const response = await proxy(request);
    expectPassThrough(response);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("x-lashkirja-api-version")).toBe("1");
  });

  it("protected API with a cookie plus an app Origin: 401 (the cookie is ignored for that origin)", async () => {
    const request = new NextRequest("http://127.0.0.1/api/dashboard", {
      method: "GET",
      headers: { cookie: await webCookie(), origin: DEV_EMULATION_ORIGIN },
    });
    const response = await proxy(request);
    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBe(DEV_EMULATION_ORIGIN);
  });

  it("page route: unchanged, no CORS headers even with an app Origin present", async () => {
    const request = new NextRequest("http://127.0.0.1/login", {
      method: "GET",
      headers: { origin: DEV_EMULATION_ORIGIN },
    });
    const response = await proxy(request);
    expectPassThrough(response);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("x-lashkirja-api-version")).toBeNull();
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
