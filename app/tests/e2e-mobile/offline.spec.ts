import { expect, test, type Page } from "@playwright/test";

/**
 * Exercises the connectivity banner and fail-fast writes (Task 8) against
 * the served static export (:3210, mobile) with the dev server (:3200) as
 * the API, plus one check directly against :3200 itself (web -- "the same
 * offline check shows the banner"). One login per scenario
 * (parallel-rules.md's shared login rate limit).
 */

const API_BASE = "http://127.0.0.1:3200";
const DEMO_EMAIL = "demo@lashkirja.fi";
const DEMO_PASSWORD = "demo123";

async function loginMobile(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Sähköposti").fill(DEMO_EMAIL);
  await page.getByLabel("Salasana").fill(DEMO_PASSWORD);
  await Promise.all([
    page.waitForURL("**/dashboard"),
    page.getByRole("button", { name: "Kirjaudu sisään" }).click(),
  ]);
}

test.describe("mobile (:3210)", () => {
  test("device offline: banner appears, a write fails fast, banner clears on reconnect", async ({ page, context }) => {
    await loginMobile(page);

    // A real receipt to edit -- fetched with the same bearer token the app
    // itself just stored, not a separate login.
    const token = await page.evaluate(() =>
      JSON.parse(window.localStorage.getItem("lashkirja.emu.lashkirja.auth.v1") || "{}").token
    );
    const listResponse = await page.request.get(`${API_BASE}/api/receipts?take=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { receipts } = (await listResponse.json()) as { receipts: Array<{ id: string }> };
    expect(receipts.length).toBeGreaterThan(0);
    const receiptId = receipts[0].id;

    await page.goto(`/kuitit/kuitti?id=${receiptId}`);
    await page.getByRole("button", { name: /Tallenna muutokset|Tallenna/ }).waitFor({ state: "visible" });

    await context.setOffline(true);
    await expect(page.getByText("Ei verkkoyhteyttä. Näytetään viimeksi haetut tiedot.")).toBeVisible({
      timeout: 1000,
    });

    const saveButton = page.getByRole("button", { name: /Tallenna muutokset|Tallenna/ });
    await saveButton.click();
    // ReceiptEditor shows the same message in two places (FormError plus a
    // duplicate inside the form itself) -- both correct, .first() only
    // disambiguates the locator.
    await expect(
      page
        .getByText("Ei verkkoyhteyttä. Tämä toiminto vaatii yhteyden. Yritä uudelleen, kun yhteys palaa.")
        .first()
    ).toBeVisible({ timeout: 1000 });
    // The button left its busy state -- it does not spin forever on a
    // request that never even started.
    await expect(saveButton).toBeEnabled({ timeout: 1000 });
    await expect(page.getByText("Tallennetaan…")).toHaveCount(0);

    let meRequestAfterReconnect = false;
    page.on("request", (request) => {
      if (request.url().includes("/api/auth/me")) meRequestAfterReconnect = true;
    });
    await context.setOffline(false);
    await expect(
      page.getByText("Ei verkkoyhteyttä. Näytetään viimeksi haetut tiedot.")
    ).toHaveCount(0, { timeout: 2000 });
    // "data refreshes" (brief): the reconnect event triggers
    // SessionProvider.refresh(), a real /api/auth/me call.
    await expect.poll(() => meRequestAfterReconnect, { timeout: 2000 }).toBe(true);
  });

  test("server unreachable: banner shows the server text after two requests, recovers on the next probe", async ({
    page,
  }) => {
    await loginMobile(page);

    let requestCount = 0;
    await page.route(`${API_BASE}/api/**`, async (route) => {
      requestCount++;
      await route.abort("connectionrefused");
    });

    // Two requests: the dashboard's own foreground-resume check (visible
    // already) dispatched twice is the same no-navigation trigger
    // auth.spec.ts and cache.spec.ts already use.
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForTimeout(300);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

    await expect(
      page.getByText("Palvelimeen ei saada yhteyttä. Näytetään viimeksi haetut tiedot.")
    ).toBeVisible({ timeout: 5000 });
    expect(requestCount).toBeGreaterThanOrEqual(2);

    await page.unroute(`${API_BASE}/api/**`);
    // The health probe runs every 15s while unreachable, in the app's own
    // (real, not fake) timer -- recovery is only visible after waiting for
    // the next tick to actually fire.
    await expect(
      page.getByText("Palvelimeen ei saada yhteyttä. Näytetään viimeksi haetut tiedot.")
    ).toHaveCount(0, { timeout: 20_000 });
  });
});

test.describe("web (:3200)", () => {
  test("the same offline check shows the banner", async ({ page, context }) => {
    await page.goto(`${API_BASE}/login`);
    await page.getByLabel("Sähköposti").fill(DEMO_EMAIL);
    await page.getByLabel("Salasana").fill(DEMO_PASSWORD);
    await Promise.all([
      page.waitForURL("**/dashboard"),
      page.getByRole("button", { name: "Kirjaudu sisään" }).click(),
    ]);

    await context.setOffline(true);
    await expect(page.getByText("Ei verkkoyhteyttä. Näytetään viimeksi haetut tiedot.")).toBeVisible({
      timeout: 1000,
    });
    await context.setOffline(false);
  });
});
