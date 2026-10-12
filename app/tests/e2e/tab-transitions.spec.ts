import { expect, test, type Page } from "@playwright/test";

/**
 * W26: time from a tab tap to content for Koti -> Kuitit -> Pankki -> Myynti ->
 * Raportit, with a warm cache (a first lap visits every screen, the measured lap
 * revisits them). Each must show its content within 300 ms of the tap. Run
 * against a BUILT server with the 5 000-row ledger:
 *
 *   PLAYWRIGHT_BASE_URL=http://127.0.0.1:3420 npx playwright test tests/e2e/tab-transitions.spec.ts --project=mobile-chromium
 *
 * Kuitit and Pankki are workspaces under Kirjanpito, so they are reached the
 * way the owner does it: the Kirjanpito tab, then the row.
 */

const BUDGET_MS = Number(process.env.W26_TAB_BUDGET_MS ?? 300);

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

/** Tap, then wait for `ready` to be in the DOM; the clock runs in the page so Playwright's own latency is not counted. */
async function tapAndMeasure(page: Page, tap: () => Promise<void>, ready: string): Promise<number> {
  await page.evaluate((selector) => {
    const w = window as unknown as { __tap: { start: number; done: number } };
    w.__tap = { start: 0, done: 0 };
    document.addEventListener(
      "pointerdown",
      () => {
        w.__tap.start = performance.now();
        const watch = new MutationObserver(() => {
          if (document.querySelector(selector)) {
            w.__tap.done = performance.now();
            watch.disconnect();
          }
        });
        watch.observe(document, { childList: true, subtree: true });
      },
      { once: true, capture: true }
    );
  }, ready);
  await tap();
  await page.waitForFunction(() => (window as unknown as { __tap: { done: number } }).__tap.done > 0, undefined, { timeout: 10_000 });
  return page.evaluate(() => {
    const { start, done } = (window as unknown as { __tap: { start: number; done: number } }).__tap;
    return Math.round(done - start);
  });
}

const tab = (page: Page, name: string) => page.getByRole("navigation", { name: "Päävalikko" }).getByRole("link", { name }).first();
const hubRow = (page: Page, name: string) => page.getByRole("link", { name: new RegExp(`^${name}`) }).first();

const ROWS = '[data-testid="list-row"]';

const steps: Array<{ name: string; go: (page: Page) => Promise<void>; ready: string }> = [
  { name: "Koti", go: (page) => tab(page, "Koti").click(), ready: "main h1, main [data-testid='summary-card']" },
  {
    name: "Kuitit",
    go: async (page) => {
      await tab(page, "Kirjanpito").click();
      await hubRow(page, "Kuitit").click();
    },
    ready: ROWS,
  },
  {
    name: "Pankki",
    go: async (page) => {
      await tab(page, "Kirjanpito").click();
      await hubRow(page, "Pankki").click();
    },
    ready: ROWS,
  },
  { name: "Myynti", go: (page) => tab(page, "Myynti").click(), ready: ROWS },
  { name: "Raportit", go: (page) => tab(page, "Raportit").click(), ready: "main h1" },
];

test("tab transitions with a warm cache are each under 300 ms", async ({ page }) => {
  await login(page);

  // Lap 1 warms every screen (data and code).
  for (const step of steps) {
    await step.go(page);
    await page.waitForSelector(step.ready, { timeout: 30_000 });
  }

  // Lap 2 is measured. The tap on the Kirjanpito tab is not part of Kuitit/Pankki's time:
  // the hub is warm too, and only the final row tap starts the clock.
  const timings: Record<string, number> = {};
  for (const step of steps) {
    if (step.name === "Kuitit" || step.name === "Pankki") {
      await tab(page, "Kirjanpito").click();
      await page.waitForSelector("main h1", { timeout: 10_000 });
      timings[step.name] = await tapAndMeasure(page, () => hubRow(page, step.name).click(), step.ready);
    } else {
      timings[step.name] = await tapAndMeasure(page, () => step.go(page), step.ready);
    }
  }

  console.log(`W26 tab transitions (ms): ${JSON.stringify(timings)}`);
  test.info().annotations.push({ type: "timing", description: JSON.stringify(timings) });
  for (const [name, ms] of Object.entries(timings)) {
    expect(ms, `${name} took ${ms} ms`).toBeLessThan(BUDGET_MS);
  }
});
