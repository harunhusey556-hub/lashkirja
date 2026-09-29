import { expect, test, type Page, type BrowserContext } from "@playwright/test";

/**
 * Exercises the persistent, encrypted cache (Task 7) against the served
 * static export (:3210) with the dev server (:3200) as the API -- see
 * playwright.mobile.config.ts. IndexedDB (like localStorage) survives a
 * page close/reopen within the same browser context, which is what stands
 * in here for a real app relaunch.
 *
 * One login for the whole file (parallel-rules.md's login rate limit is
 * shared across every mobile e2e spec run against the demo account).
 *
 * `context.setOffline(true)` blocks every request uniformly, including a
 * fresh document/route fetch -- it cannot distinguish "no path to the
 * remote API" (what offline means on a real device, where the bundled UI
 * keeps loading from `capacitor://localhost` regardless) from "no path to
 * `serve-export.ts` either" (an artifact of this harness alone, which
 * serves the SPA's own files over real HTTP). So every page this test
 * interacts with *while offline* is already open and on its target route
 * *before* going offline, and every offline interaction is either a plain
 * button click with no `next/link` behind it (Raportit's year switcher)
 * or a synthetic event a page's own effect reacts to without navigating
 * (dashboard's visibility-triggered poll) -- never a route change. The
 * "persisted cache paints before a slow network response" behaviour
 * (Task 7's actual promise) is instead proven for Koti, Kuitit and Laskut
 * with the brief's own technique: block the route, navigate to it (while
 * still online -- the document fetch itself works fine), and assert the
 * cached value is already on screen.
 *
 * Deviation from the brief's literal "one invoice" wording: the invoice
 * detail page (src/app/laskut/lasku/page.tsx) has no page-cache wiring at
 * all yet -- it is another lane's file (Task 9), not in Task 7's own file
 * list. "Laskut" (the invoice *list*, src/app/laskut/page.tsx) already
 * reads/writes page-cache exactly like "Kuitit" and "Koti" do, so it
 * stands in for the second cached screen. For "an invoice never opened",
 * Raportit's *previous year* (a distinct page-cache key, `report:<year>`,
 * never fetched) stands in for a specific record never opened, while its
 * *current year* is warmed like every other screen here -- proving the
 * miss is about that one key, not about the route never having loaded.
 */

const DEMO_EMAIL = "demo@lashkirja.fi";
const DEMO_PASSWORD = "demo123";
const EMULATED_CACHE_KEY_STORAGE_KEY = "lashkirja.emu.lashkirja.cachekey.v1";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Sähköposti").fill(DEMO_EMAIL);
  await page.getByLabel("Salasana", { exact: true }).fill(DEMO_PASSWORD);
  await Promise.all([
    page.waitForURL("**/dashboard"),
    page.getByRole("button", { name: "Kirjaudu sisään" }).click(),
  ]);
}

/** Reads every row of the "cache" object store directly, bypassing the
 * app's own decryption entirely -- used to prove what is actually on disk. */
async function readRawCacheRows(page: Page): Promise<Array<{ key: string; userId: string; dataBytesBase64: string }>> {
  return page.evaluate(() => {
    return new Promise<Array<{ key: string; userId: string; dataBytesBase64: string }>>((resolve, reject) => {
      const request = indexedDB.open("lashkirja-offline");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("cache", "readonly");
        const getAll = tx.objectStore("cache").getAll();
        getAll.onsuccess = () => {
          const rows = getAll.result as unknown[];
          resolve(
            rows.map((row) => {
              const typed = row as { key: string; userId: string; data: ArrayBuffer };
              const bytes = new Uint8Array(typed.data);
              let binary = "";
              for (const byte of bytes) binary += String.fromCharCode(byte);
              return { key: typed.key, userId: typed.userId, dataBytesBase64: btoa(binary) };
            })
          );
        };
        getAll.onerror = () => reject(getAll.error);
      };
    });
  });
}

/** Opens a fresh page, delays `apiPattern` by 3 s, navigates to `path`,
 * and asserts `expectVisible` resolves well before that delay elapses --
 * i.e. painted from the persisted cache, not from the (still-pending)
 * network response. Still online: only the API call is artificially slow. */
async function assertInstantPaint(
  context: BrowserContext,
  path: string,
  apiPattern: string,
  expectVisible: (page: Page) => Promise<void>
): Promise<void> {
  const probe = await context.newPage();
  let blocked = true;
  await probe.route(apiPattern, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    blocked = false;
    try {
      await route.continue();
    } catch {
      // A second, near-simultaneous request for the same URL can already
      // be resolved by the time this fires; the assertion below only
      // needs the first matching request delayed by the full 3 s.
    }
  });
  await probe.goto(path);
  await expectVisible(probe);
  expect(blocked).toBe(true);
  await probe.close();
}

test("survives a relaunch, paints instantly from cache, and wipes cleanly on logout", async ({ page, context }) => {
  await login(page); // lands on /dashboard
  // A cold dev-server first hit (Prisma connection, route compile) can take
  // a few seconds; this is the one fetch in the whole file with no cache to
  // paint from yet.
  await expect(page.getByText("€", { exact: false }).first()).toBeVisible({ timeout: 10_000 });

  const kuititPage = await context.newPage();
  await kuititPage.goto("/kuitit");
  await kuititPage.waitForLoadState("networkidle");

  const laskutPage = await context.newPage();
  await laskutPage.goto("/laskut");
  await laskutPage.waitForLoadState("networkidle");

  const raportitPage = await context.newPage();
  await raportitPage.goto("/raportit");
  await raportitPage.waitForLoadState("networkidle");

  // ---- IndexedDB contents are not readable JSON ----
  const rawRows = await readRawCacheRows(page);
  expect(rawRows.length).toBeGreaterThan(0);
  // Both page-cache.ts ("page:") and http-cache.ts ("http:") write into the
  // same "cache" store -- every /api/ GET clientFetch.ts makes along the
  // way (receipts, statements, invoices, ...) is itself remembered too.
  for (const row of rawRows) {
    expect(row.key.startsWith("page:") || row.key.startsWith("http:")).toBe(true);
    let looksLikeJson = false;
    try {
      const binary = atob(row.dataBytesBase64);
      JSON.parse(binary);
      looksLikeJson = true;
    } catch {
      looksLikeJson = false;
    }
    expect(looksLikeJson).toBe(false);
  }

  // ---- close every page: standing in for a real app relaunch ----
  await page.close();
  await kuititPage.close();
  await laskutPage.close();
  await raportitPage.close();

  // ---- still online: the persisted cache paints Koti, Kuitit and Laskut
  // before their (artificially slow) network response lands ----
  await assertInstantPaint(context, "/dashboard", "**/api/dashboard*", (p) =>
    expect(p.getByText("€", { exact: false }).first()).toBeVisible({ timeout: 1500 })
  );
  // Both pages' loading skeleton is `role="status" aria-label="Ladataan…"`
  // (SkeletonList, AsyncState.tsx) -- its absence shortly after navigation
  // is what proves the persisted cache painted instead of a spinner.
  await assertInstantPaint(context, "/kuitit", "**/api/receipts*", (p) =>
    expect(p.getByRole("status", { name: "Ladataan…" })).toHaveCount(0, { timeout: 1500 })
  );
  await assertInstantPaint(context, "/laskut", "**/api/invoices*", (p) =>
    expect(p.getByRole("status", { name: "Ladataan…" })).toHaveCount(0, { timeout: 1500 })
  );

  // ---- go offline. dashboardPage and reportPage are already open, on
  // their target route, before this -- everything below is a plain button
  // click or a synthetic event, never a route change ----
  const dashboardPage = await context.newPage();
  await dashboardPage.goto("/dashboard");
  await expect(dashboardPage.getByText("€", { exact: false }).first()).toBeVisible();

  const reportPage = await context.newPage();
  await reportPage.goto("/raportit");
  await reportPage.waitForLoadState("networkidle");

  // http-cache.ts (also Task 7) transparently serves a stale GET response
  // inside clientFetch.ts itself whenever it has one -- by design, "never
  // short-circuits a working network" but also never surfaces as a
  // failure to the caller. Dashboard's own page-level stale banner is a
  // *different* mechanism (page-cache.ts's fetchedAt plus a fetch that
  // actually rejects), only reachable when http-cache has no entry for
  // this exact request. Deleting only the "http:" row -- the "page:" one
  // stays untouched -- is what makes the retry below a real, page-visible
  // failure instead of a transparent hit one layer down.
  await dashboardPage.evaluate(() => {
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("lashkirja-offline");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("cache", "readwrite");
        const store = tx.objectStore("cache");
        const cursorRequest = store.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            resolve();
            return;
          }
          const key = (cursor.value as { key: string }).key;
          if (key.startsWith("http:/api/dashboard")) cursor.delete();
          cursor.continue();
        };
        cursorRequest.onerror = () => reject(cursorRequest.error);
      };
    });
  });

  await context.setOffline(true);

  // Dashboard: the same visibility-triggered poll AppShell's own resume
  // check uses (auth.spec.ts) -- no navigation, just a re-fetch that now
  // fails and falls back to the still-cached value plus a stale stamp.
  await dashboardPage.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(dashboardPage.locator('[data-stale="true"]')).toBeVisible({ timeout: 8000 });

  // Raportit: the year switcher is a plain button (no next/link) -- the
  // previous year's page-cache key was never touched, so this is an
  // honest first-ever fetch attempt for it, offline.
  await reportPage.getByRole("button", { name: "Edellinen vuosi" }).click();
  await expect(reportPage.locator('[role="alert"][data-connection]')).toBeVisible({ timeout: 5000 });
  // Never a stuck spinner: LoadingState's own label renders no such role.
  await expect(reportPage.getByText("Lasketaan raporttia")).toHaveCount(0);

  await context.setOffline(false);

  // ---- logout: the persistent cache and the emulated key are both gone ----
  await dashboardPage.getByRole("button", { name: /Profiili, asetukset/ }).click();
  await dashboardPage.getByRole("button", { name: "Kirjaudu ulos" }).click();
  await dashboardPage.waitForURL("**/login");

  const rowsAfterLogout = await readRawCacheRows(dashboardPage);
  expect(rowsAfterLogout).toEqual([]);

  const keyAfterLogout = await dashboardPage.evaluate(
    (storageKey) => window.localStorage.getItem(storageKey),
    EMULATED_CACHE_KEY_STORAGE_KEY
  );
  expect(keyAfterLogout).toBeNull();
});
