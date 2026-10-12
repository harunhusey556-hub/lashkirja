import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * W20: fresh data after a sync, and bulk actions on the Pankki feed.
 *
 * The bank itself is not reachable from a test (Enable Banking is off), so the
 * routes the page reads are answered here, in the exact shapes the server
 * returns. What is under test is the page: that the balance is on screen after
 * a sync without a reload, that a version change refetches the feed, and that
 * "Hyväksy ehdotukset (3)" sends exactly the three ticked pairs.
 */

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Sähköposti").fill("demo@lashkirja.fi");
  await page.getByLabel("Salasana", { exact: true }).fill("demo123");
  await Promise.all([page.waitForURL("**/dashboard"), page.getByRole("button", { name: "Kirjaudu sisään" }).click()]);
  await page.request.post("/api/onboarding", {
    data: {
      entityType: "toiminimi",
      vatRegistered: false,
      vatPeriod: "month",
      salesTypes: ["ripsipalvelut"],
      expenseCategories: ["tarvikkeet"],
    },
  });
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body), headers: { "cache-control": "no-store" } });

function connections(balanceCents: number) {
  return {
    enabled: true,
    ready: true,
    connections: [
      {
        id: "conn-1",
        aspspName: "Testipankki",
        aspspCountry: "FI",
        aspspLogo: null,
        psuType: "business",
        status: "active",
        validUntil: "2027-01-01T00:00:00.000Z",
        lastSyncAt: "2026-10-12T06:00:00.000Z",
        lastSuccessAt: "2026-10-12T06:00:00.000Z",
        lastError: null,
        accounts: [
          { id: "acc-1", iban: "FI2112345600000785", label: "Yritystili", currency: "EUR", inScope: true, balance: balanceCents / 100 },
        ],
      },
    ],
  };
}

const row = (id: string, receiptId: string | null) => ({
  id,
  statementId: "st-1",
  periodMonth: "2026-10",
  bankAccountId: "ba-1",
  date: "2026-10-09T00:00:00.000Z",
  counterparty: `Kauppa ${id}`,
  amount: -25,
  reference: null,
  message: null,
  type: "meno",
  matchStatus: receiptId ? "suggested" : "unmatched",
  receiptId: null,
  receipt: null,
  suggestedReceiptId: receiptId,
  suggestedReceipt: receiptId ? { id: receiptId, vendor: `Kauppa ${id}`, totalAmount: 25, date: "2026-10-09T00:00:00.000Z" } : null,
  settlesInvoice: false,
  paidInvoice: null,
  settlesPurchase: false,
  matchCandidates: [],
});

const summary = (openCount: number) => ({
  statements: [
    {
      id: "st-1",
      fileName: "pankki.csv",
      fileType: "csv",
      uploadedAt: "2026-10-10T00:00:00.000Z",
      periodMonth: "2026-10",
      bankAccountId: "ba-1",
      bankAccount: { id: "ba-1", name: "Yritystili", bankName: "Testipankki", iban: "FI2112345600000785", currency: "EUR" },
      openCount,
    },
  ],
});

test("a sync puts the new balance on the bank page without a reload", async ({ page }) => {
  await login(page);
  let balanceCents = 100_000;
  await page.route("**/api/bank/connections", (route) => json(route, connections(balanceCents)));
  await page.route(/\/api\/statements\?limit=/, (route) => json(route, { transactions: [row("a", null)], nextCursor: null, total: 1 }));
  await page.route(/\/api\/statements\?view=summary/, (route) => json(route, summary(1)));
  await page.route("**/api/sync/version", (route) => json(route, { dataVersion: 1, bank: { accounts: [] } }));
  await page.route("**/api/bank/connections/conn-1/sync", (route) => {
    balanceCents = 123_456;
    return json(route, {
      ok: true,
      imported: 2,
      accounts: [],
      dataVersion: 2,
      bank: { accounts: [{ connectedAccountId: "acc-1", balanceCents: 123_456, lastSyncAt: new Date().toISOString() }] },
    });
  });

  await page.goto("/pankki/tapahtumat");
  await expect(page.getByText(/1\s?000,00/)).toBeVisible();

  let reloaded = false;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) reloaded = true;
  });
  reloaded = false;
  await page.getByRole("button", { name: "Päivitä Testipankki" }).click();

  await expect(page.getByText(/1\s?234,56/)).toBeVisible();
  await expect(page.getByText(/1\s?000,00/)).toHaveCount(0);
  expect(reloaded).toBe(false);
});

test("a changed data version refetches the feed on its own", async ({ page }) => {
  await login(page);
  let version = 1;
  let feedRequests = 0;
  await page.route("**/api/bank/connections", (route) => json(route, connections(100_000)));
  await page.route(/\/api\/statements\?limit=/, (route) => {
    feedRequests += 1;
    // The second answer carries a row the first did not: what a background sync would have added.
    const rows = feedRequests === 1 ? [row("a", null)] : [row("a", null), row("b", null)];
    return json(route, { transactions: rows, nextCursor: null, total: rows.length });
  });
  await page.route(/\/api\/statements\?view=summary/, (route) => json(route, summary(feedRequests)));
  await page.route("**/api/sync/version", (route) => json(route, { dataVersion: version, bank: { accounts: [] } }));

  await page.goto("/pankki/tapahtumat");
  await expect(page.getByText("Kauppa a")).toBeVisible();
  await expect(page.getByText("Kauppa b")).toHaveCount(0);

  version = 2;
  // The poller asks again every 30 s while the tab is visible; coming back to the tab asks at once.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByText("Kauppa b")).toBeVisible({ timeout: 10_000 });
  expect(feedRequests).toBeGreaterThanOrEqual(2);
});

test("bulk accept sends exactly the three ticked suggestions", async ({ page }) => {
  await login(page);
  const rows = [row("a", "r-a"), row("b", "r-b"), row("c", "r-c"), row("d", "r-d")];
  let confirmBody: { pairs?: Array<{ transactionId: string; receiptId: string }> } | null = null;
  let confirmed = false;
  await page.route("**/api/bank/connections", (route) => json(route, connections(100_000)));
  await page.route(/\/api\/statements\?limit=/, (route) => {
    const served = confirmed
      ? rows.map((r) => (["a", "b", "c"].includes(r.id) ? { ...r, matchStatus: "confirmed", receiptId: r.suggestedReceiptId, suggestedReceiptId: null } : r))
      : rows;
    return json(route, { transactions: served, nextCursor: null, total: served.length });
  });
  await page.route(/\/api\/statements\?view=summary/, (route) => json(route, summary(confirmed ? 1 : 4)));
  await page.route("**/api/sync/version", (route) => json(route, { dataVersion: 1, bank: { accounts: [] } }));
  await page.route("**/api/matching/confirm-all", (route) => {
    confirmBody = route.request().postDataJSON();
    confirmed = true;
    return json(route, { ok: true, confirmed: 3, skipped: 0, alreadyConfirmed: 0, skippedPairs: [] });
  });

  await page.goto("/pankki/tapahtumat");
  await page.getByRole("button", { name: "Valitse", exact: true }).click();
  for (const id of ["a", "b", "c"]) await page.getByRole("checkbox", { name: `Valitse Kauppa ${id}` }).check();

  const bar = page.getByRole("toolbar", { name: "Valitut pankkitapahtumat" });
  await expect(bar).toContainText("3 valittu");
  await bar.getByRole("button", { name: "Hyväksy ehdotukset (3)" }).click();

  // The confirmation names the count before anything is sent.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Hyväksytäänkö 3 ehdotusta?");
  expect(confirmBody).toBeNull();
  await dialog.getByRole("button", { name: "Hyväksy", exact: true }).click();

  await expect.poll(() => confirmBody?.pairs?.length).toBe(3);
  expect(confirmBody!.pairs!.map((pair) => pair.transactionId).sort()).toEqual(["a", "b", "c"]);
  expect(confirmBody!.pairs!.map((pair) => pair.receiptId).sort()).toEqual(["r-a", "r-b", "r-c"]);
  // The fourth suggestion was not ticked and is still waiting.
  await expect(page.getByText("Tarkista", { exact: true })).toHaveCount(1);
});
