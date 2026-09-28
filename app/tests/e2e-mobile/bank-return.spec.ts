import { expect, test, type Page } from "@playwright/test";

/**
 * Task 11: bank return via `lashkirja://`.
 *
 * Two halves, per task-11-brief.md's "Verify on Windows":
 *  - Web build (:3200, the server's own copy of `/bank/callback`): an
 *    app-started return (`state=app1....`) must bounce to the
 *    `lashkirja://` scheme instead of running the web POST flow, and show
 *    the "Palaa LashKirjaan" fallback button. A plain state is unaffected.
 *  - Mobile build (:3210, the bundled copy of the same page): there is no
 *    real `appUrlOpen` event to fire from a desktop browser, so
 *    `window.__lashkirjaDeepLink` (open-bank-auth.ts's test-only hook,
 *    present only outside a native shell) stands in for it. Enable Banking
 *    is disabled in this dev environment, so the API answers 503 -- this
 *    suite only asserts that the request goes out with a bearer and a
 *    clear error is shown, never a hang.
 *
 * Never completes a real bank flow; `code`/`state` here are fakes.
 */

const WEB_BASE = "http://127.0.0.1:3200";
const API_BASE = "http://127.0.0.1:3200";
const DEMO_EMAIL = "demo@lashkirja.fi";
const DEMO_PASSWORD = "demo123";
const APP_STATE = `app1.${"a".repeat(64)}`;
const AUTH_STORAGE_KEY = "lashkirja.emu.lashkirja.auth.v1";

/**
 * Seeds the emulated Keychain (localStorage) directly instead of going
 * through the login form: `checkCredentials` rate-limits the demo account
 * to 5 logins per 15 minutes (auth-login.ts), a budget `auth.spec.ts` and
 * `files.spec.ts` already spend most of on every run. This is exactly the
 * shape `auth-client.ts`'s `persistAuth` writes -- what a real relaunch
 * finds already in the Keychain -- from a single token this suite fetches
 * directly.
 */
async function seedAuth(page: Page) {
  const response = await page.request.post(`${API_BASE}/api/auth/token`, {
    data: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
  });
  const data = (await response.json()) as { token: string; expiresAt: string; user: { userId: string } };
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    {
      key: AUTH_STORAGE_KEY,
      value: JSON.stringify({
        token: data.token,
        expiresAt: data.expiresAt,
        issuedAt: new Date().toISOString(),
        userId: data.user.userId,
      }),
    }
  );
}

test.describe("web build (:3200): /bank/callback", () => {
  test("a plain (web-started) state never bounces to the app scheme", async ({ page }) => {
    const attemptedSchemeUrls: string[] = [];
    // Chrome still fires a `request` event for a custom-scheme
    // navigation before refusing it ("no registered handler") -- this is
    // the only observable trace of `location.replace()` having been
    // called with it, since the navigation itself never completes and
    // `framenavigated` never fires for it either.
    page.on("request", (request) => {
      if (request.url().startsWith("lashkirja://")) attemptedSchemeUrls.push(request.url());
    });

    await page.goto(`${WEB_BASE}/bank/callback?code=x&state=plain-web-state`);
    await page.waitForTimeout(300);

    await expect(page.getByRole("link", { name: "Palaa LashKirjaan" })).toHaveCount(0);
    expect(attemptedSchemeUrls).toEqual([]);
  });

  test("an app-started state (app1....) bounces to lashkirja:// and offers the fallback button", async ({
    page,
  }) => {
    const attemptedSchemeUrls: string[] = [];
    const requestsToApi: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.startsWith("lashkirja://")) attemptedSchemeUrls.push(url);
      if (url.includes("/api/bank/connections/callback")) requestsToApi.push(url);
    });

    await page.goto(`${WEB_BASE}/bank/callback?code=x&state=${APP_STATE}`);
    await expect
      .poll(() => attemptedSchemeUrls)
      .toEqual([`lashkirja://bank/callback?code=x&state=${APP_STATE}`]);

    const fallback = page.getByRole("link", { name: "Palaa LashKirjaan" });
    await expect(fallback).toBeVisible();
    await expect(fallback).toHaveAttribute(
      "href",
      `lashkirja://bank/callback?code=x&state=${APP_STATE}`
    );

    // The web page never runs the web POST flow for an app-started return.
    expect(requestsToApi).toEqual([]);
  });
});

test.describe("mobile build (:3210): the bundled /bank/callback + the deep-link test hook", () => {
  test("window.__lashkirjaDeepLink routes into /bank/callback, which posts with a bearer (Enable Banking disabled -> a clear error, no hang)", async ({
    page,
  }) => {
    await seedAuth(page);
    // Any in-app page mounts ShellGate, which registers the hook (Task 11).
    await page.goto("/dashboard");
    await expect
      .poll(async () => page.evaluate(() => typeof window.__lashkirjaDeepLink))
      .toBe("function");

    const calls: Array<{ url: string; hasAuthorization: boolean }> = [];
    page.on("request", (request) => {
      const url = request.url();
      if (!url.includes("/api/bank/connections/callback")) return;
      calls.push({ url, hasAuthorization: request.headers()["authorization"] !== undefined });
    });

    await page.evaluate((url) => {
      window.__lashkirjaDeepLink?.(url);
    }, `lashkirja://bank/callback?code=abc&state=${APP_STATE}`);

    await page.waitForURL(/\/bank\/callback/);
    // Never the app-return bounce screen inside the bundle itself (the
    // IS_MOBILE_BUILD fix in bank/callback/page.tsx) -- this is the app's
    // own callback screen now, so it proceeds like a normal return.
    await expect(page.getByRole("link", { name: "Palaa LashKirjaan" })).toHaveCount(0);

    await expect(page.getByRole("alert")).toBeVisible({ timeout: 10_000 });

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.hasAuthorization).toBe(true);
    }
  });
});
