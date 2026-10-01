import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * Auth pages, secret fields and Asetukset (quality batch 1, lane auth), in
 * WebKit at iPhone sizes against the bundled export and the dev API.
 *
 * Auth: the seeded session (LASHKIRJA_E2E_STORAGE_STATE) is reused; the demo
 * account allows 5 logins per 15 min, so this file never logs in for real.
 * Every non-GET to the API is answered with a fake 200: nothing is written.
 */

test.use({
  browserName: "webkit",
  channel: "",
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

const API_BASE = "http://127.0.0.1:3200";
const AUTH_STORAGE_KEY = "lashkirja.emu.lashkirja.auth.v1";

function seededAuth(): string | null {
  const statePath = process.env.LASHKIRJA_E2E_STORAGE_STATE;
  if (!statePath) return null;
  const state = JSON.parse(readFileSync(statePath, "utf8")) as {
    origins: { localStorage: { name: string; value: string }[] }[];
  };
  return (
    state.origins.flatMap((origin) => origin.localStorage).find((item) => item.name === AUTH_STORAGE_KEY)?.value ??
    null
  );
}

async function fakeWrites(page: Page) {
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
}

/** goto, then wait until React has hydrated: a fill() before that is thrown away. */
async function open(page: Page, route: string) {
  await page.goto(route);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(600);
}

async function signedIn(page: Page) {
  const auth = seededAuth();
  test.skip(!auth, "needs LASHKIRJA_E2E_STORAGE_STATE with a saved session");
  await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), {
    key: AUTH_STORAGE_KEY,
    value: auth as string,
  });
  await fakeWrites(page);
}

test("login: the eye reveals the password and keeps focus and caret (OWN-01, F1)", async ({ page }) => {
  await fakeWrites(page);
  await open(page, "/login");
  const password = page.locator("#password");
  await password.click();
  await password.pressSequentially("hunter2abc");
  await password.evaluate((el: HTMLInputElement) => el.setSelectionRange(3, 3));

  const eye = page.getByRole("button", { name: "Näytä salasana" });
  const box = await eye.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await eye.click();

  await expect(password).toHaveAttribute("type", "text");
  const state = await password.evaluate((el: HTMLInputElement) => ({
    focused: document.activeElement === el,
    caret: el.selectionStart,
  }));
  expect(state).toEqual({ focused: true, caret: 3 });
  await page.getByRole("button", { name: "Piilota salasana" }).click();
  await expect(password).toHaveAttribute("type", "password");
  // No placeholders that look like typed values (AUTH-08).
  await expect(page.locator("#email")).not.toHaveAttribute("placeholder", /./);
  await expect(password).not.toHaveAttribute("placeholder", /./);
});

test("bare pages scroll inside a keyboard-sized viewport and keep the button reachable (SHELL-22, AUTH-07)", async ({
  page,
}) => {
  await fakeWrites(page);
  await page.setViewportSize({ width: 320, height: 290 });
  for (const route of ["/login", "/unohtunut-salasana", "/palauta-salasana?token=abc"]) {
    await open(page, route);
    await page.waitForLoadState("networkidle");
    const reach = await page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>(".bare-frame");
      const button = document.querySelector<HTMLElement>("button[type=submit]");
      if (!frame || !button) return null;
      frame.scrollTop = frame.scrollHeight;
      const rect = button.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, viewport: window.innerHeight };
    });
    expect(reach, `${route} has a .bare-frame and a submit button`).not.toBeNull();
    expect(reach!.top).toBeGreaterThanOrEqual(0);
    expect(reach!.bottom).toBeLessThanOrEqual(reach!.viewport + 1);
    // The title is scrollable back into view too: nothing is clipped above the frame.
    const titleTop = await page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>(".bare-frame")!;
      frame.scrollTop = 0;
      return document.querySelector("h1")!.getBoundingClientRect().top;
    });
    expect(titleTop).toBeGreaterThanOrEqual(0);
  }
});

test("password recovery posts to the API, never to the static server (AUTH-02)", async ({ page }) => {
  await fakeWrites(page);
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(request.url());
  });
  await open(page, "/unohtunut-salasana");
  await page.fill("#email", "demo@lashkirja.fi");
  await page.getByRole("button", { name: "Lähetä linkki" }).click();
  await expect(page.getByRole("heading", { name: "Tarkista sähköpostisi" })).toBeVisible();
  expect(posts).toEqual([`${API_BASE}/api/auth/password/forgot`]);
});

test("a 200 HTML answer from the wrong server is a failure, not 'the link is on its way' (AUTH-02)", async ({
  page,
}) => {
  await page.route(`${API_BASE}/api/auth/password/forgot`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: { "access-control-allow-origin": "*" },
      body: "<html></html>",
    })
  );
  await open(page, "/unohtunut-salasana");
  await page.fill("#email", "demo@lashkirja.fi");
  await page.getByRole("button", { name: "Lähetä linkki" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "epäonnistui" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Salasanan palautus" })).toBeVisible();
});

test("reset: repeat mismatch is an inline alert; a missing token says so (AUTH-05, AUTH-23)", async ({ page }) => {
  await fakeWrites(page);
  await open(page, "/palauta-salasana");
  await expect(page.getByRole("alert").filter({ hasText: "Linkki puuttuu tai on vanhentunut" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Pyydä uusi linkki" })).toBeVisible();

  await open(page, "/palauta-salasana?token=abc");
  await page.fill("#password", "abcdefghijk");
  await page.fill("#repeatPassword", "abcdefghijX");
  await page.getByRole("button", { name: "Tallenna salasana" }).click();
  await expect(page.locator("#repeatPassword-error")).toHaveText("Salasanat eivät täsmää.");
  await expect(page.locator("#repeatPassword")).toBeFocused();
  await page.fill("#repeatPassword", "abcdefghijk");
  await page.getByRole("button", { name: "Tallenna salasana" }).click();
  await expect(page.getByRole("heading", { name: "Salasana vaihdettu" })).toBeVisible();
});

test("a first launch lands on a plain /login, without the expired notice (AUTH-06)", async ({ page }) => {
  await fakeWrites(page);
  await open(page, "/dashboard");
  await page.waitForURL("**/login", { timeout: 15_000 });
  expect(new URL(page.url()).search).toBe("");
  await expect(page.locator("#login-notice")).toHaveCount(0);
});

test("Asetukset forms: field attributes, labels and inline alerts (AUTH-10, AUTH-11, AUTH-20)", async ({ page }) => {
  await signedIn(page);

  await open(page, "/asetukset/laskutus");
  await expect(page.locator("#sp-name")).toBeVisible();
  const seller = await page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLInputElement>("form input")].map((input) => [
        input.id,
        [input.getAttribute("autocomplete"), input.getAttribute("inputmode"), input.getAttribute("autocapitalize")],
      ])
    )
  );
  expect(seller["sp-postal"]).toEqual(["postal-code", "numeric", null]);
  expect(seller["sp-iban"]).toEqual(["off", null, "characters"]);
  expect(seller["sp-bic"]).toEqual(["off", null, "characters"]);
  expect(seller["sp-phone"]?.[0]).toBe("tel");
  await page.fill("#sp-business-id", "123");
  await page.getByRole("button", { name: "Tallenna laskuttajan tiedot" }).click();
  await expect(page.locator("#sp-business-id-error")).toHaveAttribute("role", "alert");
  await expect(page.locator("#sp-business-id")).toBeFocused();

  await open(page, "/asetukset/turvallisuus/lukitus");
  await page.fill("#lockPin", "1234");
  await page.fill("#lockPinRepeat", "1235");
  await page.getByRole("button", { name: "Ota lukitus käyttöön" }).click();
  await expect(page.locator("#lockPinRepeat-error")).toHaveText("Koodit eivät täsmää.");
  expect(await page.locator("#lockPin").getAttribute("maxlength")).toBe("8");
});

test("tietosuoja: no request without a password, and closing the account asks first (AUTH-04)", async ({ page }) => {
  await signedIn(page);
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(request.url());
  });
  await open(page, "/asetukset/tietosuoja");
  const close = page.getByRole("button", { name: "Pyydä tilin sulkemista" });
  await expect(close).toBeDisabled();
  await page.fill("#privacyPassword", "demo123");
  await expect(close).toBeEnabled();
  await close.click();
  await expect(page.getByText("Pyydetäänkö tilin sulkemista?")).toBeVisible();
  expect(posts.filter((url) => url.includes("/api/account/request"))).toEqual([]);
});

test("profiili: leaving with unsaved edits asks first (AUTH-13)", async ({ page }) => {
  await signedIn(page);
  await open(page, "/asetukset/profiili");
  await page.fill("#firstName", "Muutettu");
  await page.getByRole("button", { name: /Takaisin/ }).first().click();
  await expect(page.getByText("Hylätäänkö tallentamattomat muutokset?")).toBeVisible();
});

test("Asetukset: sign-out goes through the shared hook and ends at the login page (AUTH-03)", async ({ page }) => {
  await signedIn(page);
  const logouts: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/auth/logout")) logouts.push(request.method());
  });
  await open(page, "/asetukset");
  await page.getByRole("button", { name: "Kirjaa ulos" }).click();
  await page.waitForURL("**/login", { timeout: 15_000 });
  // The login page must not bounce a signed-out person back into the app.
  await page.waitForTimeout(1500);
  expect(new URL(page.url()).pathname).toBe("/login");
  expect(logouts).toEqual(["POST"]);
});
