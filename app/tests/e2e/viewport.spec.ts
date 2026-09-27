import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Sähköposti").fill("demo@lashkirja.fi");
  await page.getByLabel("Salasana").fill("demo123");
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
    const name = "Ääkkönen Ripsistudio ja Kauneushoitola Oy";
    await page.goto("/asiakkaat");
    await page.getByRole("main").getByRole("button", { name: "Lisää", exact: true }).click();
    await page.getByLabel("Nimi").fill(name);
    await page.getByRole("button", { name: "Lisää asiakas" }).click();
    const link = page.getByRole("link", { name });
    await expect(link).toBeVisible();
    const linkBox = await link.boundingBox();
    const card = page.locator("li").filter({ has: link });
    const cardBox = await card.boundingBox();
    expect(linkBox && cardBox).toBeTruthy();
    if (!linkBox || !cardBox) return;
    expect(linkBox.x).toBeGreaterThanOrEqual(cardBox.x - 1);
    expect(linkBox.x + linkBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
  });
});

test.describe("confirm dialog", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("names the dialog, traps Tab, and returns focus on Escape", async ({ page }) => {
    await login(page);
    await page.goto("/asiakkaat");
    await page.getByRole("main").getByRole("button", { name: "Lisää", exact: true }).click();
    await page.getByLabel("Nimi").fill("Fokus Asiakas");
    await page.getByRole("button", { name: "Lisää asiakas" }).click();
    const card = page.locator("li").filter({ hasText: "Fokus Asiakas" });
    const remove = card.getByRole("button", { name: "Poista" });
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
    await expect(remove).toBeFocused();
  });
});
