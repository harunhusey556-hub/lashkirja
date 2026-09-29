import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * The state patterns (quality batch 2, lane states; VS-30..33, TF-21, FP-14), in WebKit at an
 * iPhone size with the notch and home-indicator insets injected.
 *
 * - Error: a 500 on every read gives ONE failure card ("Jotain meni pieleen"), at most one
 *   "Yritä uudelleen", no card inside a card, and no search or filters over nothing.
 * - Empty: one pattern, and its primary action carries the header pill's label.
 * - Offline: with the server unreachable and the device offline, the screen has at most one
 *   "Yritä uudelleen", and a banner that claims cached data never sits over an empty error card.
 * - Loading: no "Ladataan…" line and no spinner outside a button while a screen waits.
 *
 * Auth: like shell.spec.ts, one token for the file (LASHKIRJA_E2E_STORAGE_STATE reuses a session).
 * Every non-GET to the API is answered with a fake 200, so nothing is written.
 */

test.use({
  browserName: "webkit",
  channel: "",
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

const API_BASE = "http://127.0.0.1:3200";
const DEMO_EMAIL = "demo@lashkirja.fi";
const DEMO_PASSWORD = "demo123";
const AUTH_STORAGE_KEY = "lashkirja.emu.lashkirja.auth.v1";
const SAFE_TOP = 47;
const SAFE_BOTTOM = 34;
const KEEP = /\/api\/(auth|session|health)/;

let authValue: string | null = null;

async function authValueOnce(page: Page): Promise<string> {
  if (authValue) return authValue;
  const statePath = process.env.LASHKIRJA_E2E_STORAGE_STATE;
  if (statePath) {
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      origins: { localStorage: { name: string; value: string }[] }[];
    };
    const entry = state.origins.flatMap((origin) => origin.localStorage).find((item) => item.name === AUTH_STORAGE_KEY);
    if (entry) {
      authValue = entry.value;
      return authValue;
    }
  }
  const response = await page.request.post(`${API_BASE}/api/auth/token`, {
    data: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
  });
  const data = (await response.json()) as { token: string; expiresAt: string; user: { userId: string } };
  authValue = JSON.stringify({
    token: data.token,
    expiresAt: data.expiresAt,
    issuedAt: new Date().toISOString(),
    userId: data.user.userId,
  });
  return authValue;
}

test.beforeEach(async ({ page }) => {
  const value = await authValueOnce(page);
  await page.addInitScript(
    ({ key, value, top, bottom }) => {
      window.localStorage.setItem(key, value);
      Object.defineProperty(navigator, "onLine", { get: () => !(window as unknown as { __off?: boolean }).__off, configurable: true });
      const add = () => {
        const style = document.createElement("style");
        style.textContent = `:root{--safe-top:${top}px !important;--safe-bottom:${bottom}px !important}`;
        (document.head || document.documentElement).appendChild(style);
      };
      if (document.head) add();
      else document.addEventListener("DOMContentLoaded", add);
    },
    { key: AUTH_STORAGE_KEY, value, top: SAFE_TOP, bottom: SAFE_BOTTOM }
  );
  await page.route(`${API_BASE}/**`, (route) => {
    const method = route.request().method();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ ok: true }),
    });
  });
});

const isRead = (method: string) => method === "GET" || method === "HEAD";

const AGING = { totalOpen: 0, overdue: 0, overdueCount: 0, buckets: {} };
/** An account with nothing in it, answered from fixed bodies so the test does not depend on the dev data. */
const EMPTY_BODIES: [RegExp, unknown][] = [
  [/\/api\/invoices\/counts/, { counts: {} }],
  [/\/api\/invoices(\?|$)/, { invoices: [], aging: AGING }],
  [/\/api\/customers/, { customers: [] }],
  [/\/api\/recurring-invoices/, { recurring: [], dueNow: 0 }],
  [/\/api\/purchase-invoices\/counts/, { counts: { open: 0, overdue: 0, paid: 0, cancelled: 0 } }],
  [/\/api\/purchase-invoices/, { invoices: [], aging: AGING }],
  [/\/api\/receipts\/counts/, { counts: {} }],
  [/\/api\/receipts/, { receipts: [], count: 0, truncated: false }],
];

const LIST_ROUTES = [
  "/laskut",
  "/kuitit",
  "/asiakkaat",
  "/toistuvat",
  "/kirjanpito/ostolaskut",
  "/kirjanpito/pankkitilit",
  "/pankki/tapahtumat",
  "/pankki/taydennys",
  "/tyot",
  "/raportit",
  "/kirjanpito",
];

async function retryButtons(page: Page): Promise<number> {
  return page.locator("main.app-main, .connectivity-banner").getByRole("button", { name: "Yritä uudelleen" }).count();
}

test.describe("error", () => {
  for (const route of LIST_ROUTES) {
    test(`${route}: one failure card, one retry`, async ({ page }) => {
      await page.route(`${API_BASE}/api/**`, (r) =>
        isRead(r.request().method()) && !KEEP.test(r.request().url())
          ? r.fulfill({
              status: 500,
              contentType: "application/json",
              headers: { "access-control-allow-origin": "*" },
              body: JSON.stringify({ error: "Internal Server Error" }),
            })
          : r.fallback()
      );
      await page.goto(route);
      const cards = page.locator("main.app-main [data-connection]");
      await expect(cards.first()).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(600);
      await expect(cards).toHaveCount(1);
      await expect(cards.first()).toContainText("Jotain meni pieleen");
      // Never a card inside a card, never a second retry.
      await expect(page.locator("[data-connection] [data-connection]")).toHaveCount(0);
      expect(await retryButtons(page)).toBe(1);
      await expect(page.getByText("Jokin meni pieleen")).toHaveCount(0);
      // Nothing to search or filter over a failed load.
      if (route !== "/raportit" && route !== "/kirjanpito") {
        await expect(page.getByRole("searchbox")).toHaveCount(0);
        await expect(page.getByRole("group", { name: /^Suodata/ })).toHaveCount(0);
      }
    });
  }
});

test.describe("empty", () => {
  const EMPTY_ROUTES: { route: string; pill: string }[] = [
    { route: "/laskut", pill: "Uusi lasku" },
    { route: "/kuitit", pill: "Uusi kuitti" },
    { route: "/asiakkaat", pill: "Uusi asiakas" },
    { route: "/toistuvat", pill: "Uusi toistuva lasku" },
    { route: "/kirjanpito/ostolaskut", pill: "Uusi ostolasku" },
  ];
  for (const { route, pill } of EMPTY_ROUTES) {
    test(`${route}: one empty pattern, the primary is "${pill}"`, async ({ page }) => {
      await page.route(`${API_BASE}/api/**`, (r) => {
        const url = r.request().url();
        const hit = isRead(r.request().method()) ? EMPTY_BODIES.find(([re]) => re.test(url)) : undefined;
        if (!hit) return r.fallback();
        return r.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify(hit[1]),
        });
      });
      await page.goto(route);
      const empty = page.locator('main.app-main [data-empty="records"]');
      await expect(empty).toBeVisible({ timeout: 15_000 });
      await expect(empty.locator("p").first()).toContainText(/^Ei .+ vielä$|^Ei .+$/);
      // 56 px tile, one primary action, same label as the header pill.
      const tile = await empty.locator("span[aria-hidden]").first().boundingBox();
      expect(Math.round(tile?.width ?? 0)).toBe(56);
      const primary = empty.getByRole(route === "/kuitit" ? "link" : "button", { name: pill });
      await expect(primary).toHaveCount(1);
      // No search, no filter chips, no zero table over an empty screen.
      await expect(page.getByRole("searchbox")).toHaveCount(0);
      await expect(page.getByRole("group", { name: /^Suodata/ })).toHaveCount(0);
    });
  }
});

test.describe("offline", () => {
  for (const route of ["/laskut", "/kuitit", "/kirjanpito/pankkitilit", "/raportit"]) {
    test(`${route}: at most one retry, no banner over an empty error card`, async ({ page }) => {
      await page.route(`${API_BASE}/api/**`, (r) =>
        !KEEP.test(r.request().url()) && isRead(r.request().method()) ? r.abort("failed") : r.fallback()
      );
      await page.goto(route);
      await page.evaluate(() => {
        (window as unknown as { __off: boolean }).__off = true;
        window.dispatchEvent(new Event("offline"));
      });
      const card = page.locator("main.app-main [data-connection]");
      await expect(card.first()).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(700);
      expect(await retryButtons(page)).toBeLessThanOrEqual(1);
      // The card says "Ei verkkoyhteyttä"; the banner that claims saved data stays away.
      await expect(page.locator(".connectivity-banner")).toHaveCount(0);
      await expect(page.getByText("Näytetään viimeksi haetut tiedot")).toHaveCount(0);
    });
  }

  test("the banner floats over the content and does not push it", async ({ page }) => {
    await page.goto("/kirjanpito/kaudet");
    await page.waitForLoadState("networkidle").catch(() => {});
    const top = () => page.locator("main.app-main h1").first().evaluate((el) => Math.round(el.getBoundingClientRect().top));
    const before = await top();
    await page.evaluate(() => {
      (window as unknown as { __off: boolean }).__off = true;
      window.dispatchEvent(new Event("offline"));
    });
    const banner = page.locator(".connectivity-banner");
    await expect(banner).toContainText("Ei verkkoyhteyttä. Näytetään viimeksi haetut tiedot.");
    await page.waitForTimeout(400);
    expect(await top()).toBe(before);
  });
});

test.describe("loading", () => {
  for (const route of ["/laskut", "/kuitit", "/asiakkaat", "/kirjanpito/ostolaskut", "/raportit", "/pankki/tapahtumat", "/tyot"]) {
    test(`${route}: a skeleton, no "Ladataan…" line and no spinner outside a button`, async ({ page }) => {
      await page.route(`${API_BASE}/api/**`, async (r) => {
        if (isRead(r.request().method()) && !KEEP.test(r.request().url())) await new Promise((resolve) => setTimeout(resolve, 4000));
        return r.fallback();
      });
      await page.goto(route);
      await expect(page.locator("main.app-main .skeleton").first()).toBeVisible({ timeout: 8000 });
      const text = await page.locator("main.app-main").innerText();
      expect(text).not.toMatch(/Ladataan|Haetaan|Lasketaan|Luetaan/);
      const spinners = await page.locator("main.app-main .animate-spin").evaluateAll(
        (nodes) => nodes.filter((node) => !node.closest("button")).length
      );
      expect(spinners).toBe(0);
    });
  }
});
