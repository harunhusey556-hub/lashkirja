import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * App-shell regressions (quality batch 1, lane infra), in WebKit at an
 * iPhone size with the notch and home-indicator insets injected: Playwright
 * has no env(safe-area-inset-*), and without them every overflow reads
 * ~80 px too small.
 *
 * Auth: one token for the whole file (the demo account allows 5 logins per
 * 15 min, shared with the other specs). Set LASHKIRJA_E2E_STORAGE_STATE to a
 * saved storage-state file to reuse a session instead of logging in.
 * Every non-GET to the API is answered with a fake 200, so nothing is written.
 */

test.use({
  browserName: "webkit",
  // The config pins Chromium to the installed Chrome; WebKit has no channels.
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
  // Installed after the token is fetched (a route here must not eat the login POST).
  await page.route(`${API_BASE}/**`, (route) => {
    const method = route.request().method();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return route.continue();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ ok: true }),
    });
  });
});

async function settled(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await expect(page.locator("main.app-main")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => /Ladataan|Haetaan/i.test(document.body.innerText)), { timeout: 12_000 })
    .toBe(false);
  await page.waitForTimeout(400);
}

test("avatar sheet > Asetukset lands on /asetukset (SHELL-01, AUTH-01)", async ({ page }) => {
  for (const start of ["/dashboard", "/kirjanpito"]) {
    await page.goto(start);
    await settled(page);
    await page.getByRole("button", { name: /Profiili, asetukset/ }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Asetukset", exact: true }).click();
    await page.waitForURL("**/asetukset");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
});

/** Every static route in the registry, plus the bare pages. Detail routes
 * that need an id are discovered from their list pages below. */
const STATIC_ROUTES = [
  "/dashboard", "/laskut", "/kirjanpito", "/raportit", "/asetukset",
  "/kuitit", "/kuitit/uusi", "/pankki/tapahtumat", "/pankki/taydennys", "/tyot",
  "/kirjanpito/alv", "/kirjanpito/ostolaskut", "/kirjanpito/pankkitilit", "/kirjanpito/kaudet",
  "/asiakkaat", "/toistuvat", "/laskut/uusi",
  "/asetukset/profiili", "/asetukset/yritys", "/asetukset/laskutus", "/asetukset/tili",
  "/asetukset/tili/salasana", "/asetukset/tili/laitteet", "/asetukset/turvallisuus",
  "/asetukset/turvallisuus/lukitus", "/asetukset/turvallisuus/biometria",
  "/asetukset/tietosuoja", "/asetukset/sahkoposti", "/asetukset/ohje",
  "/unohtunut-salasana",
];
const DETAIL_SOURCES: [list: string, hrefPart: string][] = [
  ["/laskut", "/laskut/lasku?id="],
  ["/kuitit", "/kuitit/kuitti?id="],
  ["/asiakkaat", "/asiakkaat/asiakas?id="],
  ["/pankki/tapahtumat", "/pankki/tapahtumat/tiliote?id="],
];
const SIZES = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
];

test("every screen always rubber-bands: one scroller, overflow-y auto, range >= 1 px, no fit mode (C1.1, IA-01..04)", async ({
  page,
}) => {
  test.setTimeout(15 * 60_000);
  const routes = [...STATIC_ROUTES];
  for (const [list, hrefPart] of DETAIL_SOURCES) {
    await page.goto(list);
    await settled(page);
    const href = await page.evaluate(
      (part) => document.querySelector<HTMLAnchorElement>(`a[href*="${part}"]`)?.getAttribute("href") ?? null,
      hrefPart
    );
    if (href) routes.push(href);
  }
  expect(routes.length).toBeGreaterThanOrEqual(STATIC_ROUTES.length + 2);

  const offenders: string[] = [];
  let measured = 0;
  for (const size of SIZES) {
    await page.setViewportSize(size);
    for (const route of routes) {
      await page.goto(route);
      await page.waitForLoadState("networkidle").catch(() => {});
      await page
        .waitForFunction(() => !document.querySelector(".skeleton, [aria-busy='true']"), null, { timeout: 12_000 })
        .catch(() => {});
      await page.waitForTimeout(250);
      const result = await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>("main.app-main, .bare-frame");
        if (!scroller) return null;
        return {
          overflowY: getComputedStyle(scroller).overflowY,
          range: scroller.scrollHeight - scroller.clientHeight,
          fit: document.querySelector("[data-fit]") !== null,
        };
      });
      const where = `${size.width}px ${route}`;
      if (!result) {
        offenders.push(`${where}: no scroller`);
        continue;
      }
      measured += 1;
      if (result.overflowY !== "auto") offenders.push(`${where}: overflow-y ${result.overflowY}`);
      if (result.range < 1) offenders.push(`${where}: range ${result.range}px`);
      if (result.fit) offenders.push(`${where}: data-fit present`);
    }
  }
  expect(offenders).toEqual([]);
  expect(measured).toBe(routes.length * SIZES.length);
});

test("Enter on a 'next' field moves focus and never submits (C6, IA-11)", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method()) && request.url().startsWith(API_BASE)) {
      writes.push(`${request.method()} ${request.url()}`);
    }
  });
  for (const route of ["/asetukset/laskutus", "/asetukset/profiili"]) {
    await page.goto(route);
    await settled(page);
    const first = page.locator('main input[enterkeyhint="next"]').first();
    await first.focus();
    const before = await first.evaluate((el) => (el as HTMLInputElement).name || el.id);
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.name || document.activeElement?.id))
      .not.toBe(before);
    expect(await page.evaluate(() => document.activeElement?.tagName)).toMatch(/INPUT|SELECT|TEXTAREA/);
    await expect(page).toHaveURL(new RegExp(`${route}$`));
  }
  expect(writes).toEqual([]);
});

test("the tab bar and the action bar hide while the keyboard is open (C5, IA-08, IA-09)", async ({ page }) => {
  await page.goto("/laskut/uusi");
  await settled(page);
  await page.locator("main input").first().focus();
  // Playwright has no on-screen keyboard: publish what UsableArea would.
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = ":root{--usable-bottom:300px !important}";
    document.head.appendChild(style);
    document.documentElement.dataset.keyboard = "open";
  });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector(".app-tab-bar")!).display)).toBe("none");
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.querySelector(".bottom-actions")!).visibility))
    .toBe("hidden");
});
