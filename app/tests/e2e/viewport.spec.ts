import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Sähköposti").fill("demo@lashkirja.fi");
  await page.getByLabel("Salasana", { exact: true }).fill("demo123");
  await Promise.all([
    page.waitForURL("**/dashboard"),
    page.getByRole("button", { name: "Kirjaudu sisään" }).click(),
  ]);
  await page.request.post("/api/onboarding", {
    data: {
      entityType: "toiminimi",
      vatRegistered: false,
      vatPeriod: "month",
      salesTypes: ["ripsipalvelut"],
      expenseCategories: ["tarvikkeet"],
    },
  });
  await page.reload();
  await expect(page.locator(".app-header")).toBeVisible();
}

async function shellDoesNotOverlap(page: Page) {
  const header = page.locator(".app-header");
  const main = page.locator(".app-main");
  const tab = page.locator(".app-tab-bar");
  await expect(header).toBeVisible();
  await expect(main).toBeVisible();
  await expect(tab).toBeVisible();
  const h = await header.boundingBox();
  const m = await main.boundingBox();
  const t = await tab.boundingBox();
  expect(h && m && t).toBeTruthy();
  if (!h || !m || !t) return;
  expect(h.y + h.height).toBeLessThanOrEqual(m.y + 2);
  expect(Math.round(t.y)).toBeGreaterThanOrEqual(Math.round(m.y + m.height) - 2);
  expect(h.x).toBeGreaterThanOrEqual(-1);
  expect(h.x + h.width).toBeLessThanOrEqual((page.viewportSize()?.width ?? h.width) + 1);
}

for (const [width, height] of [
  [390, 844],
  [430, 932],
] as const) {
  test.describe(`portrait ${width}`, () => {
    test.use({ viewport: { width, height } });

    test("header, content, and tab bar do not overlap", async ({ page }) => {
      await login(page);
      await shellDoesNotOverlap(page);
      const viewport = page.locator('meta[name="viewport"]');
      const content = (await viewport.getAttribute("content")) ?? "";
      expect(content).not.toMatch(/user-scalable\s*=\s*no/i);
      expect(content).not.toMatch(/maximum-scale\s*=\s*1\b/i);
    });
  });
}

test.describe("landscape compact", () => {
  test.use({ viewport: { width: 844, height: 390 } });

  test("the shell still stacks", async ({ page }) => {
    await login(page);
    await shellDoesNotOverlap(page);
  });
});

test.describe("long text at 390", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("a long customer name stays inside the card", async ({ page }) => {
    await login(page);
    const name = `Ääkkönen Ripsistudio ja Kauneushoitola Oy ${test.info().project.name}`;
    await page.goto("/asiakkaat");
    await page.getByRole("main").getByRole("button", { name: "Lisää", exact: true }).click();
    await page.getByLabel("Nimi").fill(name);
    await page.getByRole("button", { name: "Lisää asiakas" }).click();
    const link = page.getByRole("link", { name });
    await expect(link).toBeVisible();
    const card = page.locator('[data-testid="list-row"]').filter({ has: link });
    // The link itself is an absolute inset-0 overlay the size of the whole
    // row, so its box is trivially equal to the row's - that proves nothing.
    // Measure the actual visible title text instead: the row's ".truncate"
    // title span, first in DOM order (the row's other truncating span is the
    // secondary line, which comes after it).
    const title = card.locator(".truncate").first();
    await expect(title).toBeVisible();
    const metrics = await title.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    // The full name is wider than the box it's rendered in - i.e. the
    // ellipsis is doing real work here, not merely present in the CSS.
    expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
    const cardBox = await card.boundingBox();
    const titleBox = await title.boundingBox();
    expect(cardBox && titleBox).toBeTruthy();
    if (!cardBox || !titleBox) return;
    // And the (clipped) rendered box never escapes the card, however long
    // the underlying text is.
    expect(titleBox.x).toBeGreaterThanOrEqual(cardBox.x - 1);
    expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
  });
});

test.describe("confirm dialog", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("names the dialog, traps Tab, and returns focus on Escape", async ({ page }) => {
    await login(page);
    await page.goto("/asiakkaat");
    await page.getByRole("main").getByRole("button", { name: "Lisää", exact: true }).click();
    const name = `Fokus Asiakas ${test.info().project.name}`;
    await page.getByLabel("Nimi").fill(name);
    await page.getByRole("button", { name: "Lisää asiakas" }).click();
    // "Poista" now lives on the customer's own detail page, behind its
    // "Lisää toimintoja" menu (MoreMenu), not on the list row directly.
    await page.getByRole("link", { name }).click();
    await expect(page).toHaveURL(/\/asiakkaat\/asiakas\?id=/);
    await page.getByRole("button", { name: "Lisää toimintoja" }).click();
    const remove = page.getByRole("button", { name: "Poista" });
    await remove.click();
    const dialog = page.getByRole("dialog", { name: "Poistetaanko asiakas?" });
    await expect(dialog).toBeVisible();
    const titleId = await dialog.locator("h3").getAttribute("id");
    const descriptionId = await dialog.locator("p").first().getAttribute("id");
    expect(titleId).toBeTruthy();
    expect(descriptionId).toBeTruthy();
    await expect(dialog).toHaveAttribute("aria-labelledby", titleId!);
    await expect(dialog).toHaveAttribute("aria-describedby", descriptionId!);
    await page.keyboard.press("Tab");
    const stillInside = await page.evaluate(() => {
      const dialog = document.querySelector("[role=dialog]");
      return Boolean(dialog && dialog.contains(document.activeElement));
    });
    expect(stillInside).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    // "Poista" is inside the "Lisää toimintoja" menu's own sheet, which
    // closes first (as part of the same click that opened the ConfirmModal)
    // and restores focus to ITS OWN trigger - "Lisää toimintoja" - before the
    // ConfirmModal's focus trap ever activates. So the ConfirmModal's own
    // previously-focused element (captured when it opens) is already "Lisää
    // toimintoja", not "Poista", and that's what Escape hands focus back to.
    await expect(page.getByRole("button", { name: "Lisää toimintoja" })).toBeFocused();
  });
});
