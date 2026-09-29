import { readFile } from "fs/promises";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Task 9: files through authenticated fetch and the native share sheet.
 *
 * Runs against the real static export (:3210) with the dev server (:3200)
 * as the API -- see playwright.mobile.config.ts and Global Constraints,
 * "Local verification harness". There is no Capacitor share plugin on
 * Chrome (Capacitor.isNativePlatform() is false), so `openAuthedFile`
 * always takes the mobile "fetch then shareContent" branch here, exactly as
 * it does on device -- the platform difference is inside `shareContent`
 * itself. Desktop Chrome's Web Share API *does* report file sharing as
 * available (`navigator.canShare({files})` is true here), but actually
 * calling `navigator.share()` for a file blocks forever with no OS share
 * target to hand it to -- there is nothing to interact with in an automated
 * run. `navigator.share`/`canShare` are stubbed away below so the same
 * download fallback the brief describes ("Chrome has no Capacitor share")
 * runs deterministically, and the `download` event is what this suite
 * asserts on, per the brief.
 *
 * Only ONE `/api/auth/token` call for the whole file (see `sharedToken`
 * below): `checkCredentials` rate-limits the demo account to 5 logins per
 * 15 minutes (auth-login.ts), a budget `auth.spec.ts` alone already spends
 * 3 of on every run. A page never goes through the login FORM here -- its
 * localStorage is seeded directly with the one token this file already
 * holds (the exact shape `auth-client.ts`'s `persistAuth` writes), which
 * costs the rate limit nothing and is exactly what a real relaunch finds
 * already in the Keychain.
 *
 * Uses the demo account (demo@lashkirja.fi / demo123) and its seeded
 * invoices. Never touches production.
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
 * without ever touching the rate-limited login endpoint per test. */
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

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    Object.defineProperty(window.navigator, "share", { value: undefined, configurable: true });
    Object.defineProperty(window.navigator, "canShare", { value: undefined, configurable: true });
  });
});

interface ApiCall {
  url: string;
  hasAuthorization: boolean;
}

function trackApiCalls(page: Page): ApiCall[] {
  const calls: ApiCall[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith(`${API_BASE}/api/`)) return;
    calls.push({ url, hasAuthorization: request.headers()["authorization"] !== undefined });
  });
  return calls;
}

/**
 * A genuinely decodable 4x4 red JPEG (generated with `sharp`, see
 * task-9-11-client-report.md) -- large enough to satisfy the upload
 * pipeline's magic-byte detection, small enough to inline here rather than
 * add a binary fixture file.
 */
const TEST_JPEG_BASE64 =
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAEAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCAAHlhf//Z";

/**
 * Creates a receipt with a real, fetchable file on disk, bypassing OCR
 * entirely: `POST /api/receipts` stages the upload (real bytes written to
 * `data/uploads/...`), then `POST /api/receipts/save` finishes it with
 * manual fields -- the same request `ReceiptEditor` sends when OCR fails
 * or the user edits by hand. This dev environment's OCR cannot read text
 * from a synthetic image (it fails in ~5ms regardless of content, even
 * with real receipt text rendered into the JPEG), so going through
 * `applyUpload`'s auto-fill path is not viable here; this reaches the same
 * end state (an approved receipt with a real file) without depending on it.
 */
async function createReceiptWithFile(
  request: APIRequestContext,
  token: string,
  fileName: string
): Promise<string> {
  // A trailing byte sequence after the JPEG's EOI marker is invisible to
  // every decoder (browser included -- confirmed with `sharp`) but makes
  // each run's bytes unique, so a repeat run never collides with an
  // earlier run's upload via the content-checksum de-dupe in
  // `POST /api/receipts` (findReusableStagedUpload).
  const uniqueBytes = Buffer.concat([
    Buffer.from(TEST_JPEG_BASE64, "base64"),
    Buffer.from(`e2e-${Date.now()}-${Math.random()}`),
  ]);

  const upload = await request.post(`${API_BASE}/api/receipts`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      file: {
        name: fileName,
        mimeType: "image/jpeg",
        buffer: uniqueBytes,
      },
    },
  });
  const uploadData = (await upload.json()) as { uploadId: string };

  const save = await request.post(`${API_BASE}/api/receipts/save`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: {
      vendor: "E2E Testi",
      date: "2026-09-20",
      totalAmount: 13.9,
      vatDetails: [],
      category: "tarvikkeet",
      notes: null,
      type: "meno",
      reference: null,
      invoiceNumber: null,
      uploadId: uploadData.uploadId,
      forceDuplicate: true,
    },
  });
  const saveData = (await save.json()) as { receipt: { id: string } };
  return saveData.receipt.id;
}

test("a receipt's image preview fetches the bytes with the bearer token and shows a blob: <img>", async ({
  page,
  request,
}) => {
  const auth = await getSharedAuth(request);
  const receiptId = await createReceiptWithFile(request, auth.token, "e2e-preview.jpg");
  const calls = trackApiCalls(page);

  await seedAuth(page, auth);
  await page.goto(`/kuitit/kuitti?id=${receiptId}`);

  const img = page.locator('img[alt="e2e-preview.jpg"]');
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("src", /^blob:/);

  const fileCalls = calls.filter((call) => call.url.includes(`/api/receipts/${receiptId}/file`));
  expect(fileCalls.length).toBeGreaterThan(0);
  for (const call of fileCalls) {
    expect(call.hasAuthorization).toBe(true);
  }
});

test("downloading a report CSV keeps the server's file name", async ({ page, request }) => {
  const auth = await getSharedAuth(request);
  const calls = trackApiCalls(page);

  await seedAuth(page, auth);
  await page.goto("/raportit");

  // The period exports name the file after the year they cover
  // (`kuitit-<year>.csv`); the link itself says which year that is.
  const link = page.getByRole("link", { name: "Kuitit", exact: true });
  const year = new URL((await link.getAttribute("href")) ?? "", "http://x").searchParams.get("year");
  expect(year).toMatch(/^[0-9]{4}$/);

  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
  expect(download.suggestedFilename()).toBe(`kuitit-${year}.csv`);

  const exportCalls = calls.filter((call) => call.url.includes("/api/export"));
  expect(exportCalls.length).toBeGreaterThan(0);
  for (const call of exportCalls) {
    expect(call.hasAuthorization).toBe(true);
  }
});

test("the invoice PDF menu action downloads a real %PDF file with the server's name", async ({
  page,
  request,
}) => {
  const auth = await getSharedAuth(request);
  const invoicesResponse = await request.get(`${API_BASE}/api/invoices?take=1`, {
    headers: { Authorization: `Bearer ${auth.token}` },
  });
  const { invoices } = (await invoicesResponse.json()) as {
    invoices: Array<{ id: string; number: number }>;
  };
  expect(invoices.length).toBeGreaterThan(0);
  const invoice = invoices[0];

  const calls = trackApiCalls(page);
  await seedAuth(page, auth);
  await page.goto(`/laskut/lasku?id=${invoice.id}`);

  await page.getByRole("button", { name: "Lisää toimintoja" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Avaa PDF" }).click(),
  ]);

  const expectedName = `lasku-${String(invoice.number).padStart(4, "0")}.pdf`;
  expect(download.suggestedFilename()).toBe(expectedName);
  const filePath = await download.path();
  expect(filePath).toBeTruthy();
  const bytes = await readFile(filePath!);
  expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");

  const pdfCalls = calls.filter((call) => call.url.includes(`/api/invoices/${invoice.id}/pdf`));
  expect(pdfCalls.length).toBeGreaterThan(0);
  for (const call of pdfCalls) {
    expect(call.hasAuthorization).toBe(true);
  }
});
