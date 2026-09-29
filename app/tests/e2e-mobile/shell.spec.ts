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

test("root routes either fit or clearly scroll: no 1-64 px jitter scroll (S1)", async ({ page }) => {
  const offenders: string[] = [];
  let measured = 0;
  for (const route of ["/dashboard", "/laskut", "/kirjanpito", "/raportit", "/asetukset"]) {
    await page.goto(route);
    await settled(page);
    const overflow = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>("main.app-main");
      return main ? main.scrollHeight - main.clientHeight : null;
    });
    expect(overflow, `${route} has no <main>`).not.toBeNull();
    measured += 1;
    if (overflow !== null && overflow > 0 && overflow <= 64) offenders.push(`${route}: ${overflow}px`);
  }
  expect(measured).toBe(5);
  expect(offenders).toEqual([]);
});
