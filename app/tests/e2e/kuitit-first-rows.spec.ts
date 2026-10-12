import { expect, test, type Page } from "@playwright/test";

/**
 * W26 timing probe for the Kuitit page: TTFB of the document, time until the
 * first receipt rows are in the DOM, how many rows the page mounted, and how
 * many picture bytes it asked for. Run it against a BUILT server whose database
 * holds the 5 000-row ledger with ~1 500 receipts (W18's populate script):
 *
 *   PLAYWRIGHT_BASE_URL=http://127.0.0.1:3420 npx playwright test tests/e2e/kuitit-first-rows.spec.ts --project=mobile-chromium
 *
 * Gates (override with env): first rows < W26_KUITIT_FIRST_ROWS_MS (default 1500 cold),
 * at most 60 rows mounted on the first screen (one page of 50 + the queue), and
 * no list row ever requests a full upload (`/file` without `/preview`).
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

test("kuitit: time to first rows, paged, thumbnails only", async ({ page }) => {
  await login(page);
  const requested: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/receipts")) requested.push(url.pathname + url.search);
  });

  // Cold for this screen: no page-cache copy from the dashboard warm-up hides the request.
  await page.goto("about:blank");
  await page.addInitScript(() => {
    const marks = { firstRow: 0 };
    (window as unknown as { __w26: typeof marks }).__w26 = marks;
    const watch = new MutationObserver(() => {
      if (!marks.firstRow && document.querySelector('[data-testid="list-row"]')) {
        marks.firstRow = performance.now();
        watch.disconnect();
      }
    });
    watch.observe(document, { childList: true, subtree: true });
  });

  await page.goto("/kuitit", { waitUntil: "commit" });
  await page.waitForSelector('[data-testid="list-row"]', { timeout: 30_000 });
  // Expand the collapsed list so the whole first page is mounted.
  const showAll = page.getByRole("button", { name: /Katso kaikki/ });
  if (await showAll.isVisible().catch(() => false)) await showAll.click();

  const result = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    const marks = (window as unknown as { __w26: { firstRow: number } }).__w26;
    return {
      ttfbMs: Math.round(nav.responseStart - nav.requestStart),
      firstRowMs: Math.round(marks.firstRow),
      rowsInDom: document.querySelectorAll('[data-testid="list-row"]').length,
    };
  });
  const listCalls = requested.filter((url) => /^\/api\/receipts\?/.test(url) && !url.includes("reviewStatus"));
  const fullUploads = requested.filter((url) => /^\/api\/receipts\/[^/]+\/file(\?|$)/.test(url));
  const summary = { ...result, listCalls: listCalls.length, firstListCall: listCalls[0], fullUploads: fullUploads.length };
  console.log(`W26 kuitit: ${JSON.stringify(summary)}`);
  test.info().annotations.push({ type: "timing", description: JSON.stringify(summary) });

  expect(fullUploads, "a list row must never load a full upload").toHaveLength(0);
  expect(listCalls[0] ?? "").toContain("limit=50");
  expect(result.rowsInDom).toBeLessThanOrEqual(60);
  const budget = Number(process.env.W26_KUITIT_FIRST_ROWS_MS ?? 1500);
  expect(result.firstRowMs).toBeLessThan(budget);
});
