import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Task 10: the offline receipt-photo queue, against the served static
 * export (:3210) with the dev server (:3200) as the API -- see
 * playwright.mobile.config.ts and Global Constraints, "Local verification
 * harness". IndexedDB survives a page close/reopen within the same
 * browser context, which stands in for a real app relaunch (Task 7's
 * cache.spec.ts uses the same technique).
 *
 * Only ONE `/api/auth/token` call for the whole file (parallel-rules.md
 * rule 11: the demo account allows 5 logins per 15 min, shared with
 * `/api/auth/login`, and the rest of this session's suite already uses
 * some of that budget) -- every page's localStorage is seeded directly
 * with the one token this file holds (the exact shape `auth-client.ts`'s
 * `persistAuth` writes), never through the login form.
 *
 * `context.setOffline(true)` blocks every request uniformly, including a
 * client-side route transition's own chunk/data fetch -- Task 7's
 * cache.spec.ts documents this same harness limitation at length, and the
 * offline capture path here *must* navigate (back to /kuitit) while
 * offline, unlike anything cache.spec.ts/offline.spec.ts exercise. So
 * "offline" here is simulated the way that still lets the harness's own
 * static-file server (:3210, a stand-in for the bundled UI a real device
 * always has local access to) answer normally: only `${API_BASE}/api/**`
 * (:3200, the remote server) is blocked, and `connectivity.ts`'s device
 * state is flipped with a plain `window.dispatchEvent(new Event("offline"))`
 * -- the same signal a real dropped connection fires, and exactly what
 * `connectivity.ts`'s own `onWindowOffline` listens for.
 *
 * This dev environment has no tesseract (task-9-11-client-report.md), so
 * a captured photo's job always fails extraction -- the pending receipt
 * created on the server is always the "Täydennä käsin" / unreadable
 * variant, exactly what the brief's own verify step expects.
 */

const API_BASE = "http://127.0.0.1:3200";
const DEMO_EMAIL = "demo@lashkirja.fi";
const DEMO_PASSWORD = "demo123";
const AUTH_STORAGE_KEY = "lashkirja.emu.lashkirja.auth.v1";

interface Auth {
  token: string;
  expiresAt: string;
  userId: string;
}

let sharedAuth: Auth | null = null;

async function getSharedAuth(request: APIRequestContext): Promise<Auth> {
  if (sharedAuth) return sharedAuth;
  const response = await request.post(`${API_BASE}/api/auth/token`, {
    data: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
  });
  const data = (await response.json()) as {
    token: string;
    expiresAt: string;
    user: { userId: string };
  };
  sharedAuth = { token: data.token, expiresAt: data.expiresAt, userId: data.user.userId };
  return sharedAuth;
}

/** Seeds the emulated Keychain (localStorage) so the app boots signed in,
 * without ever touching the rate-limited login endpoint per test. Applied
 * at the context level so a later `context.newPage()` (standing in for a
 * relaunch) also boots signed in with no further seeding. */
async function seedAuth(page: Page, auth: Auth) {
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    {
      key: AUTH_STORAGE_KEY,
      value: JSON.stringify({
        token: auth.token,
        expiresAt: auth.expiresAt,
        issuedAt: new Date().toISOString(),
        userId: auth.userId,
      }),
    }
  );
}

/**
 * A genuinely decodable 4x4 red JPEG (generated with `sharp`, same fixture
 * files.spec.ts already uses) -- large enough to satisfy the upload
 * pipeline's magic-byte detection, small enough to inline here.
 */
const TEST_JPEG_BASE64 =
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAEAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCAAHlhf//Z";

/** A unique JPEG each run, so the checksum-based de-dupe in
 * `POST /api/receipts/inbox` never treats this run's capture as a repeat
 * of an earlier one -- a trailing byte sequence after the JPEG's EOI
 * marker is invisible to every decoder but makes the bytes unique. */
function uniqueJpegBytes(): Buffer {
  return Buffer.concat([
    Buffer.from(TEST_JPEG_BASE64, "base64"),
    Buffer.from(`e2e-queue-${Date.now()}-${Math.random()}`),
  ]);
}

async function deleteReceipt(request: APIRequestContext, token: string, receiptId: string): Promise<void> {
  await request.delete(`${API_BASE}/api/receipts/${receiptId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Blocks only the remote API (:3200), never this page's own static
 * export (:3210) -- see the file header comment. Also flips
 * `connectivity.ts`'s device state the same way a real dropped connection
 * would, so the app's own offline branches (ReceiptEditor's pick-time
 * check, `assertCanWrite`) see it immediately, not just the queue driver's
 * blocked send attempts. */
async function goOffline(page: Page): Promise<void> {
  await page.route(`${API_BASE}/api/**`, (route) => route.abort("connectionrefused"));
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
}

async function goOnline(page: Page): Promise<void> {
  await page.unroute(`${API_BASE}/api/**`);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
}

test("captures offline, survives a restart, sends on reconnect, and warns before logout", async ({
  page,
  context,
  request,
}) => {
  const auth = await getSharedAuth(request);
  await seedAuth(page, auth);

  await page.goto("/kuitit/uusi");
  await page.waitForLoadState("networkidle");

  await goOffline(page);

  // No native shell in Chrome (Capacitor.isNativePlatform() is false), so
  // the "Valitse tiedosto" flow falls back to this plain, hidden file
  // input -- setInputFiles fires its onChange exactly like a real pick.
  await page
    .getByLabel("Valitse kuitti tai lasku tiedostona")
    .setInputFiles({ name: "e2e-queue-1.jpg", mimeType: "image/jpeg", buffer: uniqueJpegBytes() });

  // Offline capture: enqueued locally, then straight back to Kuitit with
  // the "Ei yhteyttä..." notice and one "Jonossa" row.
  await page.waitForURL("**/kuitit");
  await expect(
    page.getByText("Ei yhteyttä. Kuva tallennettiin ja lähetetään automaattisesti, kun yhteys palaa.")
  ).toBeVisible();
  await expect(page.getByText("Odottaa yhteyttä")).toBeVisible();
  await expect(page.getByText("Jonossa")).toBeVisible();

  // ---- restart: close this page, open a new one in the same context ----
  await page.close();
  const relaunched = await context.newPage();
  await relaunched.goto("/kuitit");
  await expect(relaunched.getByText("Jonossa")).toBeVisible();

  // ---- reconnect: within 10 s the row turns done ----
  await goOnline(relaunched);
  await expect(
    relaunched.getByText("1 kuva lähetetty.", { exact: false })
  ).toBeVisible({ timeout: 10_000 });

  // ---- the pending receipt landed in Tarkistettavat, unreadable variant
  // (no tesseract in this dev environment) ----
  const pending = await request.get(`${API_BASE}/api/receipts?reviewStatus=pending`, {
    headers: { Authorization: `Bearer ${auth.token}` },
  });
  const pendingData = (await pending.json()) as {
    receipts: Array<{ id: string; source: string }>;
  };
  const captured = pendingData.receipts.find((r) => r.source === "app_capture");
  expect(captured).toBeTruthy();

  const detailResponse = await request.get(`${API_BASE}/api/receipts/${captured!.id}`, {
    headers: { Authorization: `Bearer ${auth.token}` },
  });
  const detail = (await detailResponse.json()) as {
    receipt: { notes: string | null; totalAmount: number | null };
  };
  expect(detail.receipt.notes).toBe("Tietoja ei saatu luettua kuvasta. Täydennä käsin.");
  expect(detail.receipt.totalAmount).toBeNull();

  await deleteReceipt(request, auth.token, captured!.id);

  // ---- logout with one queued item shows the confirmation ----
  await relaunched.goto("/kuitit/uusi");
  await relaunched.waitForLoadState("networkidle");
  await goOffline(relaunched);
  await relaunched
    .getByLabel("Valitse kuitti tai lasku tiedostona")
    .setInputFiles({ name: "e2e-queue-2.jpg", mimeType: "image/jpeg", buffer: uniqueJpegBytes() });
  await relaunched.waitForURL("**/kuitit");
  await expect(relaunched.getByText("Jonossa")).toBeVisible();

  await relaunched.getByRole("button", { name: /Profiili, asetukset/ }).click();
  await relaunched.getByRole("dialog").getByRole("button", { name: "Kirjaudu ulos" }).click();
  // The earlier item is "done" (already delivered) and never counted here
  // -- only this second, still-queued item is "waiting to be sent".
  await expect(
    relaunched.getByText("1 kuitti odottaa lähetystä. Jos kirjaudut ulos, ne poistetaan tästä laitteesta.")
  ).toBeVisible();

  // Cancel -- this file never actually signs out (no further budget spent
  // on a real login/logout call, and the shared token stays valid for any
  // later test in the same run).
  await relaunched.getByRole("button", { name: "Peruuta" }).click();
  await goOnline(relaunched);
});
