import { test, type Page } from "@playwright/test";

/**
 * W20 timing probe, not a pass/fail UI test: how long the bank page takes to
 * show its first rows. Run it against a built server whose database holds the
 * 5 000-row ledger (W18's seeder, `app/tests/.tmp/`):
 *
 *   PLAYWRIGHT_BASE_URL=http://127.0.0.1:3420 npx playwright test tests/e2e/bank-first-rows.spec.ts --project=mobile-chromium
 *
 * It prints TTFB of the page document, the time until the first bank row is in
 * the DOM and until the balance header shows, and how many rows the page put in
 * the DOM. Set W20_FIRST_ROWS_BUDGET_MS to turn the first-rows time into a gate.
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

test("bank page: time to first rows", async ({ page }) => {
  await login(page);
  // Start cold for this screen: a page-cache copy from the dashboard warm-up would hide the request.
  await page.goto("about:blank");
  await page.addInitScript(() => {
    const marks = { firstRow: 0, balance: 0 };
    (window as unknown as { __w20: typeof marks }).__w20 = marks;
    const watch = new MutationObserver(() => {
      if (!marks.firstRow && document.querySelector('[data-testid="list-row"]')) marks.firstRow = performance.now();
      if (!marks.balance && document.querySelector('[aria-label^="Päivitä "]')) marks.balance = performance.now();
      if (marks.firstRow && marks.balance) watch.disconnect();
    });
    watch.observe(document, { childList: true, subtree: true });
  });

  await page.goto("/pankki/tapahtumat", { waitUntil: "commit" });
  await page.waitForSelector('[data-testid="list-row"]', { timeout: 30_000 });

  const result = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    const marks = (window as unknown as { __w20: { firstRow: number; balance: number } }).__w20;
    return {
      ttfbMs: Math.round(nav.responseStart - nav.requestStart),
      firstRowMs: Math.round(marks.firstRow),
      balanceHeaderMs: marks.balance ? Math.round(marks.balance) : null,
      rowsInDom: document.querySelectorAll('[data-testid="list-row"]').length,
    };
  });
  console.log(`W20 bank page: ${JSON.stringify(result)}`);
  test.info().annotations.push({ type: "timing", description: JSON.stringify(result) });

  const budget = Number(process.env.W20_FIRST_ROWS_BUDGET_MS);
  if (Number.isFinite(budget) && budget > 0 && result.firstRowMs > budget) {
    throw new Error(`first rows took ${result.firstRowMs} ms, budget ${budget} ms`);
  }
});
