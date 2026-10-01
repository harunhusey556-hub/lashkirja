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

async function watchEnterClass(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __enter: string[] };
    w.__enter = [];
    // playNavTransition mounts the old page as a snapshot whose class names
    // the transition (page-push-out, page-pop-out, page-tab-out).
    const frame = document.querySelector(".app-frame")!;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          const match = node instanceof Element ? node.className.match(/page-(push|pop|tab)-out/) : null;
          if (match) w.__enter.push(match[1]);
        }
      }
    }).observe(frame, { childList: true });
  });
}

const enterClasses = (page: Page) => page.evaluate(() => (window as unknown as { __enter: string[] }).__enter.join(","));

test("direction comes from the gesture: a cross-tab link pushes and keeps its tab, back pops to it (C2, IA-05..07)", async ({
  page,
}) => {
  await page.goto("/raportit");
  await settled(page);
  await watchEnterClass(page);
  await page.locator('main a[href^="/kuitit"]').first().click();
  await page.waitForURL("**/kuitit**");
  await expect.poll(() => enterClasses(page)).toContain("push");
  await expect(page.locator(".app-tab-bar a[aria-current=page]")).toHaveText("Raportit");
  const back = page.locator(".app-header button[aria-label^='Takaisin']");
  await expect(back).toHaveAttribute("aria-label", "Takaisin: Raportit");
  await watchEnterClass(page);
  await back.click();
  await page.waitForURL("**/raportit");
  await expect.poll(() => enterClasses(page)).toContain("pop");
});

test("tabs remember their screen; the active tab scrolls to the top, then pops to its root (C1.5, IA-25)", async ({ page }) => {
  await page.goto("/kirjanpito");
  await settled(page);
  await page.locator('main a[href^="/kuitit"]').first().click();
  await page.waitForURL("**/kuitit**");
  await settled(page);
  await page.locator(".app-tab-bar a", { hasText: "Koti" }).click();
  await page.waitForURL("**/dashboard");
  await page.locator(".app-tab-bar a", { hasText: "Kirjanpito" }).click();
  await page.waitForURL("**/kuitit**");
  await settled(page);
  await page.evaluate(() => (document.querySelector("main.app-main")!.scrollTop = 200));
  await page.locator(".app-tab-bar a", { hasText: "Kirjanpito" }).click();
  await expect.poll(() => page.evaluate(() => document.querySelector("main.app-main")!.scrollTop)).toBeLessThanOrEqual(1);
  await expect(page).toHaveURL(/\/kuitit/);
  await page.locator(".app-tab-bar a", { hasText: "Kirjanpito" }).click();
  await page.waitForURL("**/kirjanpito");
});

type NavFrame = { path: string; tx: number; opacity: number; snaps: number; width: number };

/** Logs every animation frame's <main> position, opacity and snapshot count. */
async function logFrames(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __nav: NavFrame[]; __navStop?: boolean };
    w.__nav = [];
    w.__navStop = false;
    const tick = () => {
      const main = document.querySelector<HTMLElement>("main.app-main")!;
      const style = getComputedStyle(main);
      w.__nav.push({
        path: location.pathname,
        tx: style.transform === "none" ? 0 : new DOMMatrix(style.transform).m41,
        opacity: Number(style.opacity),
        snaps: document.querySelectorAll(".page-snapshot").length,
        width: main.offsetWidth,
      });
      if (!w.__navStop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const framesOn = (page: Page, prefix: string) =>
  page.evaluate((p) => {
    const w = window as unknown as { __nav: NavFrame[]; __navStop?: boolean };
    w.__navStop = true;
    return w.__nav.filter((frame) => frame.path.startsWith(p));
  }, prefix);

test("a push starts from the old page in place and slides, and a tab switch never dims the new page (OWN-17, OWN-19)", async ({
  page,
}) => {
  await page.goto("/kirjanpito");
  await settled(page);
  // Warm the target once, so the measured push is the cached, everyday case.
  await page.locator('main a[href^="/kirjanpito/alv"]').first().tap();
  await page.waitForURL("**/kirjanpito/alv**");
  await settled(page);
  await page.locator(".app-header button[aria-label^='Takaisin']").tap();
  await page.waitForURL(/\/kirjanpito$/);
  await settled(page);

  await logFrames(page);
  await page.locator('main a[href^="/kirjanpito/alv"]').first().tap();
  await page.waitForURL("**/kirjanpito/alv**");
  await page.waitForTimeout(900);
  const push = await framesOn(page, "/kirjanpito/alv");
  // The commit frame: the old page still covers the screen and the new one
  // waits off-screen right (before batch 3 it was already ~30 % in).
  expect(push[0].snaps).toBe(1);
  expect(push[0].tx).toBeGreaterThanOrEqual(push[0].width * 0.95);
  // Then it travels over several frames, with no jump-cut, and ends clean.
  expect(push.filter((frame) => frame.tx > 1).length).toBeGreaterThanOrEqual(4);
  for (let i = 1; i < push.length; i++) expect(push[i - 1].tx - push[i].tx).toBeLessThan(push[0].width * 0.6);
  expect(push.at(-1)).toMatchObject({ tx: 0, snaps: 0, opacity: 1 });

  await logFrames(page);
  await page.locator(".app-tab-bar a", { hasText: "Myynti" }).tap();
  await page.waitForURL("**/laskut");
  await page.waitForTimeout(600);
  const tab = await framesOn(page, "/laskut");
  // The old tab crossfades out above the new one; the new page is never dimmed.
  expect(tab[0].snaps).toBe(1);
  for (const frame of tab) expect(frame.opacity).toBe(1);
  expect(tab.at(-1)).toMatchObject({ tx: 0, snaps: 0 });
});
