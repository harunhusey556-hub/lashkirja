import { expect, test } from "@playwright/test";

/**
 * Runs against the real static export (npm run build:mobile), served by
 * scripts/mobile/serve-export.ts, with the dev server on :3200 as the API
 * (see playwright.mobile.config.ts). No stored session exists in a fresh
 * browser context, so BootRedirect's token-less probe always comes back
 * unauthorized -- see BootRedirect.tsx.
 */

test("/ boots to /login with the login screen visible and no CSP violations", async ({ page }) => {
  const cspViolations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /content security policy|refused to/i.test(message.text())) {
      cspViolations.push(message.text());
    }
  });

  await page.goto("/");
  await page.waitForURL("**/login");
  await expect(page.getByRole("heading", { name: "LashKirja" })).toBeVisible();

  expect(cspViolations).toEqual([]);
});

test("a detail URL with ?id= serves its own static file, not the SPA shell", async ({ request, baseURL }) => {
  const base = baseURL ?? "http://127.0.0.1:3210";

  const [indexResponse, detailResponse] = await Promise.all([
    request.get(`${base}/`),
    request.get(`${base}/laskut/lasku?id=x`),
  ]);
  expect(indexResponse.status()).toBe(200);
  expect(detailResponse.status()).toBe(200);

  const [indexBody, detailBody] = await Promise.all([indexResponse.text(), detailResponse.text()]);
  // If serve-export.ts (or its Swift port) ever regressed to always falling
  // back to /index.html, this is the assertion that would catch it: the
  // detail page's static HTML is not the boot page's.
  expect(detailBody).not.toBe(indexBody);
});
