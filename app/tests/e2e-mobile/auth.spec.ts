import { expect, test, type Page } from "@playwright/test";

/**
 * Exercises the real mobile auth flow (Task 5) against the served static
 * export (:3210) with the dev server (:3200) as the API -- see
 * playwright.mobile.config.ts and Global Constraints, "Local verification
 * harness". The token lives in the emulation store (localStorage under
 * "lashkirja.emu.", see secure-store.ts) rather than the real Keychain,
 * which is unreachable from a desktop browser.
 *
 * Uses the demo account (demo@lashkirja.fi / demo123). Never touches
 * production and never revokes with scope "all" on this account -- only
 * ever the one session row this test itself opened.
 */

const API_BASE = "http://127.0.0.1:3200";
const DEMO_EMAIL = "demo@lashkirja.fi";
const DEMO_PASSWORD = "demo123";
const AUTH_STORAGE_KEY = "lashkirja.emu.lashkirja.auth.v1";

interface ApiCall {
  url: string;
  hasAuthorization: boolean;
  hasCookie: boolean;
}

function trackApiCalls(page: Page): ApiCall[] {
  const calls: ApiCall[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith(`${API_BASE}/api/`)) return;
    const headers = request.headers();
    calls.push({
      url,
      hasAuthorization: headers["authorization"] !== undefined,
      hasCookie: headers["cookie"] !== undefined,
    });
  });
  return calls;
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Sähköposti").fill(DEMO_EMAIL);
  await page.getByLabel("Salasana", { exact: true }).fill(DEMO_PASSWORD);
  await Promise.all([
    page.waitForURL("**/dashboard"),
    page.getByRole("button", { name: "Kirjaudu sisään" }).click(),
  ]);
}

async function storedToken(page: Page): Promise<string | null> {
  const raw = await page.evaluate(
    (key) => window.localStorage.getItem(key),
    AUTH_STORAGE_KEY
  );
  if (!raw) return null;
  return (JSON.parse(raw) as { token: string }).token;
}

test("login stores a bearer token (no cookie), and the session survives a reload", async ({ page }) => {
  const calls = trackApiCalls(page);

  await login(page);

  const token = await storedToken(page);
  expect(token).toBeTruthy();

  const apiCallsSoFar = calls.filter((call) => call.url.includes("/api/"));
  expect(apiCallsSoFar.length).toBeGreaterThan(0);
  for (const call of apiCallsSoFar) {
    expect(call.hasCookie).toBe(false);
  }
  // The token endpoint itself carries no Authorization (there is nothing to
  // send yet); every call after signing in does.
  const postLoginCalls = apiCallsSoFar.filter((call) => !call.url.endsWith("/api/auth/token"));
  expect(postLoginCalls.length).toBeGreaterThan(0);
  for (const call of postLoginCalls) {
    expect(call.hasAuthorization).toBe(true);
  }

  // Reload on the dashboard itself (not "/") -- this is the case that only
  // works because clientFetch.ts's mobile branch awaits bootMobile() before
  // reading the token, not just BootRedirect on "/".
  await page.reload();
  await page.waitForURL("**/dashboard");
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("signing out from the profile sheet lands on /login with no document navigation", async ({ page }) => {
  await login(page);

  // "load" fires only for an actual document navigation (a real page
  // load/reload); a client-side App Router transition (pushState/
  // replaceState) never fires it. This is the precise signal for "no
  // document navigation", as opposed to "framenavigated", which also fires
  // for same-document SPA route changes and would give a false positive.
  let documentLoads = 0;
  page.on("load", () => {
    documentLoads++;
  });

  await page.getByRole("button", { name: /Profiili, asetukset/ }).click();
  await page.getByRole("button", { name: "Kirjaudu ulos" }).click();

  await page.waitForURL("**/login");
  expect(documentLoads).toBe(0);
  expect(await storedToken(page)).toBeNull();
});

test("revoking this session's own row signs the app out on the next API call, exactly once", async ({
  page,
  request,
}) => {
  await login(page);
  const token = await storedToken(page);
  expect(token).toBeTruthy();

  // Find this token's own session row -- GET /api/auth/sessions with the
  // bearer marks it "current" -- then revoke only that row. Never scope
  // "all" on the demo account: that would sign out every other session too.
  const sessionsResponse = await request.get(`${API_BASE}/api/auth/sessions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(sessionsResponse.ok()).toBe(true);
  const { sessions } = (await sessionsResponse.json()) as {
    sessions: Array<{ id: string; current: boolean }>;
  };
  const current = sessions.find((session) => session.current);
  expect(current).toBeTruthy();

  const revokeResponse = await request.post(`${API_BASE}/api/auth/sessions`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: { id: current!.id },
  });
  expect(revokeResponse.ok()).toBe(true);

  let documentLoads = 0;
  page.on("load", () => {
    documentLoads++;
  });

  // Triggers AppShell's foreground-resume /api/auth/me check deterministically,
  // without needing to actually background and re-foreground the page.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

  await page.waitForURL("**/login?error=expired");
  expect(documentLoads).toBe(0);
  expect(await storedToken(page)).toBeNull();

  // Calling expireSession()'s effect a second time (another dispatch) must
  // not navigate again -- the "once per signed-in period" guard.
  const urlAfterFirst = page.url();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(200);
  expect(page.url()).toBe(urlAfterFirst);
  expect(documentLoads).toBe(0);
});
