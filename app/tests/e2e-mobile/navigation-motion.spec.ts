import { expect, test, type Page } from "@playwright/test";

// Exercise the shipped static bundle in WebKit, without writing business data.
test.use({ browserName: "webkit", channel: "", viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const API = process.env.LASHKIRJA_E2E_API_BASE ?? "http://127.0.0.1:3200";
let auth: string;
test.beforeEach(async ({ page }) => {
  if (!auth) {
    const response = await page.request.post(`${API}/api/auth/token`, {
      data: { email: process.env.LASHKIRJA_E2E_EMAIL ?? "demo@lashkirja.fi", password: process.env.LASHKIRJA_E2E_PASSWORD ?? "demo123" },
    });
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    auth = JSON.stringify({ token: data.token, expiresAt: data.expiresAt, issuedAt: new Date().toISOString(), userId: data.user.userId });
  }
  await page.addInitScript((value) => {
    localStorage.setItem("lashkirja.emu.lashkirja.auth.v1", value);
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = ":root{--safe-top:47px!important;--safe-bottom:34px!important}";
      document.head.appendChild(style);
    });
  }, auth);
  // This harness's origin is HTTP, whereas native CORS uses capacitor://.
  await page.route(`${API}/**`, async (route) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(route.request().method())) {
      return route.fulfill({ status: 200, json: { ok: true }, headers: { "access-control-allow-origin": "*" } });
    }
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "access-control-allow-origin": "*" } });
  });
});

async function settled(page: Page) {
  await expect(page.locator("main h1")).toBeVisible();
  await expect.poll(() => page.locator("main").evaluate((main) => !main.hasAttribute("data-nav-moving"))).toBeTruthy();
  await expect(page.locator(".page-snapshot,.page-scrim,.swipe-cap")).toHaveCount(0);
}
async function openReceipts(page: Page) {
  await page.goto("/kirjanpito");
  await settled(page);
  await page.locator('main a[href^="/kuitit"]').first().click();
  await expect(page).toHaveURL(/\/kuitit$/);
  await settled(page);
}
async function touch(page: Page, type: string, x: number) {
  await page.evaluate(({ type, x }) => {
    const main = document.querySelector("main")!;
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "touches", { value: type === "touchend" || type === "touchcancel" ? [] : [{ clientX: x, clientY: 230 }] });
    main.dispatchEvent(event);
  }, { type, x });
}
async function drag(page: Page, endX: number) {
  await touch(page, "touchstart", 5);
  await touch(page, "touchmove", 20);
  await page.waitForTimeout(25);
  await touch(page, "touchmove", endX);
  await page.waitForTimeout(25);
}
async function clean(page: Page) {
  await settled(page);
  expect(await page.locator("main").evaluate((main) => ({ transform: main.style.transform, zIndex: main.style.zIndex, willChange: main.style.willChange, swiping: main.dataset.swiping }))).toEqual({ transform: "", zIndex: "", willChange: "", swiping: undefined });
}

test("page and header start on one clock; push/pop leave no layers", async ({ page }) => {
  await page.goto("/kirjanpito");
  await settled(page);
  await page.evaluate(() => {
    const samples: number[][] = [];
    (window as unknown as { headerSurfaces: string[] }).headerSurfaces = [];
    (window as unknown as { motionSamples: number[][] }).motionSamples = samples;
    const sample = () => {
      const main = document.querySelector<HTMLElement>("main")!;
      if (main.dataset.navMoving === "push") {
        const pageAnimation = main.getAnimations()[0];
        const headerAnimation = document.querySelector(".app-header-row")?.getAnimations()[0];
        if (pageAnimation && headerAnimation) {
          const style = getComputedStyle(document.querySelector(".app-header-row")!);
          (window as unknown as { headerSurfaces: string[] }).headerSurfaces.push(`${style.backgroundColor}|${style.opacity}`);
        }
        if (pageAnimation && headerAnimation && typeof pageAnimation.currentTime === "number" && typeof headerAnimation.currentTime === "number") samples.push([pageAnimation.currentTime, headerAnimation.currentTime]);
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.locator('main a[href^="/kuitit"]').first().click();
  await expect(page).toHaveURL(/\/kuitit$/);
  await clean(page);
  const samples = await page.evaluate(() => (window as unknown as { motionSamples: number[][] }).motionSamples);
  expect(samples.length).toBeGreaterThan(3);
  const surfaces = await page.evaluate(() => (window as unknown as { headerSurfaces: string[] }).headerSurfaces);
  expect(surfaces.every((surface) => /^rgb\([^)]*\)\|1$/.test(surface))).toBeTruthy();
  for (const [body, header] of samples) expect(Math.abs(body - header)).toBeLessThan(2);
  await page.locator('.app-header button[aria-label^="Takaisin"]').click();
  await expect(page).toHaveURL(/\/kirjanpito$/);
  await clean(page);
});

test("held short drag cancels; OS touchcancel never goes back", async ({ page }) => {
  await openReceipts(page);
  await drag(page, 85);
  await page.waitForTimeout(160);
  await touch(page, "touchend", 85);
  await clean(page);
  await expect(page).toHaveURL(/\/kuitit$/);
  await drag(page, 270);
  await touch(page, "touchcancel", 270);
  await clean(page);
  await expect(page).toHaveURL(/\/kuitit$/);
});

test("committed back keeps the preview through settlement and cleans on landing", async ({ page }) => {
  await openReceipts(page);
  await drag(page, 230);
  await touch(page, "touchend", 230);
  await expect(page).toHaveURL(/\/kuitit$/);
  await expect(page.locator('.page-swipe-under')).toHaveCount(1);
  await expect(page).toHaveURL(/\/kirjanpito$/);
  await clean(page);
});

test("a new push interrupts swipe cancellation without stale cleanup", async ({ page }) => {
  await openReceipts(page);
  await drag(page, 65);
  await page.waitForTimeout(160);
  await touch(page, "touchend", 65);
  await page.locator('a[href="/kuitit/uusi"]').first().click({ force: true });
  await expect(page).toHaveURL(/\/kuitit\/uusi$/);
  await clean(page);
});
