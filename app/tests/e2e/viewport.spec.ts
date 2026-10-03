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
  // Koti is an inline-header root (INLINE_HEADER_ROOTS in AppShell): the
  // shell header row is hidden there and the assistant and profile buttons
  // sit beside the page's own large title instead.
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: /Profiili, asetukset/ })).toBeVisible();
}

/** The header row, or (on an inline-header root) the page title, ends where main begins. */
async function headerClearsMain(page: Page) {
  const frame = page.locator(".app-frame");
  const header = page.locator(".app-header");
  const main = page.locator(".app-main");
  await expect(main).toBeVisible();
  const m = await main.boundingBox();
  const h = await header.boundingBox();
  expect(m && h).toBeTruthy();
  if (!m || !h) return;
  const width = page.viewportSize()?.width ?? m.x + m.width;
  if ((await frame.getAttribute("data-inline-header")) === "true") {
    // Inline-header roots (Koti, Myynti, Kirjanpito, Raportit, Asetukset)
    // hide the shell header row on purpose; the header keeps only the safe
    // area, and the actions render inside main next to the h1.
    await expect(header.locator(".app-header-row")).toBeHidden();
    const title = main.getByRole("heading", { level: 1 });
    await expect(title).toBeVisible();
    await expect(main.getByRole("button", { name: /Profiili, asetukset/ })).toBeVisible();
    const t = await title.boundingBox();
    expect(t).toBeTruthy();
    if (!t) return;
    expect(t.y).toBeGreaterThanOrEqual(m.y - 1);
    expect(t.x + t.width).toBeLessThanOrEqual(width + 1);
  } else {
    await expect(header).toBeVisible();
    await expect(header.locator(".app-header-row")).toBeVisible();
  }
  expect(h.y + h.height).toBeLessThanOrEqual(m.y + 2);
  expect(h.x).toBeGreaterThanOrEqual(-1);
  expect(h.x + h.width).toBeLessThanOrEqual(width + 1);
}

async function shellDoesNotOverlap(page: Page) {
  await headerClearsMain(page);
  // The tab bar is a floating glass capsule over the page (iOS 26, see
  // ".app-tab-bar" in globals.css): main runs on under it and pads its end
  // instead. What must hold is that main's content box - where the last row
  // lands when scrolled to the end - stops above the capsule and the "+".
  const main = page.locator(".app-main");
  const tab = page.locator(".app-tab-bar");
  await expect(tab).toBeVisible();
  const m = await main.boundingBox();
  const t = await tab.boundingBox();
  const capsule = await tab.locator(".tab-capsule").boundingBox();
  const plus = await tab.getByRole("button", { name: "Lisää" }).boundingBox();
  expect(m && t && capsule && plus).toBeTruthy();
  if (!m || !t || !capsule || !plus) return;
  const paddingBottom = await main.evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
  const contentEnd = m.y + m.height - paddingBottom;
  expect(contentEnd).toBeLessThanOrEqual(Math.min(capsule.y, plus.y) + 1);
  const viewport = page.viewportSize();
  expect(t.y + t.height).toBeLessThanOrEqual((viewport?.height ?? t.y + t.height) + 1);
  expect(capsule.x).toBeGreaterThanOrEqual(-1);
  expect(plus.x + plus.width).toBeLessThanOrEqual((viewport?.width ?? plus.x + plus.width) + 1);
}

for (const [width, height] of [
  [390, 844],
  [430, 932],
] as const) {
  test.describe(`portrait ${width}`, () => {
    test.use({ viewport: { width, height } });

    test("header, content, and tab bar do not overlap", async ({ page }) => {
      await login(page);
      // Koti: inline-header root.
      await shellDoesNotOverlap(page);
      // Asiakkaat: a root that keeps the shell header row.
      await page.goto("/asiakkaat");
      await expect(page.locator(".app-frame")).not.toHaveAttribute("data-inline-header", "true");
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

  // From 768 px the shell switches to the sidebar layout (globals.css): the
  // tab bar is gone and the sidebar carries the same seven roots. iPhone is
  // locked to portrait (SHELL-26), so this is the wide layout at a short height.
  test("the shell keeps a sidebar layout without overlap", async ({ page }) => {
    await login(page);
    const main = page.locator(".app-main");
    const sidebar = page.locator(".app-sidebar");
    for (const path of ["/dashboard", "/asiakkaat"]) {
      await page.goto(path);
      await headerClearsMain(page);
      await expect(sidebar).toBeVisible();
      await expect(page.locator(".app-tab-bar")).toBeHidden();
      const m = await main.boundingBox();
      const sb = await sidebar.boundingBox();
      expect(m && sb).toBeTruthy();
      if (!m || !sb) return;
      expect(m.x).toBeGreaterThanOrEqual(sb.x + sb.width - 2);
      expect(m.x + m.width).toBeLessThanOrEqual((page.viewportSize()?.width ?? m.width) + 1);
      expect(m.y + m.height).toBeLessThanOrEqual((page.viewportSize()?.height ?? m.height) + 1);
    }
  });
});

test.describe("long text at 390", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("a long customer name stays inside the card", async ({ page }) => {
    await login(page);
    // Unique per project and attempt: a CI retry runs against the same database.
    const name = `Ääkkönen Ripsistudio ja Kauneushoitola Oy ${test.info().project.name} ${test.info().retry}`;
    await page.goto("/asiakkaat");
    await page.getByRole("main").getByRole("button", { name: "Uusi asiakas", exact: true }).click();
    await page.getByLabel("Nimi").fill(name);
    await page.getByRole("button", { name: "Lisää asiakas" }).click();
    const link = page.getByRole("link", { name });
    await expect(link).toBeVisible();
    const card = page.locator('[data-testid="list-row"]').filter({ has: link });
    // The link itself is an absolute inset-0 overlay the size of the whole
    // row, so its box is trivially equal to the row's - that proves nothing.
    // Measure the actual visible title text instead: the row's title span,
    // first ".clamp-lines" in DOM order (the secondary line comes after it).
    // Titles wrap instead of an ellipsis (AX-26, R19); on the stitch pages
    // the two-line clamp is lifted too, so a long name is never cut.
    const title = card.locator(".clamp-lines").first();
    await expect(title).toBeVisible();
    const metrics = await title.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      height: el.getBoundingClientRect().height,
      lineHeight: parseFloat(getComputedStyle(el).lineHeight),
    }));
    // The long name wraps onto a second line and never spills sideways.
    expect(metrics.height).toBeGreaterThan(metrics.lineHeight * 1.5);
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
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
    await page.getByRole("main").getByRole("button", { name: "Uusi asiakas", exact: true }).click();
    const name = `Fokus Asiakas ${test.info().project.name} ${test.info().retry}`;
    await page.getByLabel("Nimi").fill(name);
    await page.getByRole("button", { name: "Lisää asiakas" }).click();
    // "Poista" now lives on the customer's own detail page, behind its
    // "Lisää toimintoja" menu (MoreMenu), not on the list row directly.
    await page.getByRole("link", { name }).click();
    await expect(page).toHaveURL(/\/asiakkaat\/asiakas\?id=/);
    await page.getByRole("button", { name: "Lisää toimintoja" }).click();
    const remove = page.getByRole("button", { name: "Poista" });
    await remove.click();
    // A destructive confirm is an alert dialog (AX-23, R6) titled by an h2 (AX-11).
    const dialog = page.getByRole("alertdialog", { name: "Poistetaanko asiakas?" });
    await expect(dialog).toBeVisible();
    const titleId = await dialog.locator("h2").getAttribute("id");
    const descriptionId = await dialog.locator("p").first().getAttribute("id");
    expect(titleId).toBeTruthy();
    expect(descriptionId).toBeTruthy();
    await expect(dialog).toHaveAttribute("aria-labelledby", titleId!);
    await expect(dialog).toHaveAttribute("aria-describedby", descriptionId!);
    await page.keyboard.press("Tab");
    // Measured on THIS dialog: the always-mounted assistant drawer and other
    // sheets are also role=dialog, and a bare querySelector finds those first.
    const stillInside = await dialog.evaluate((el) => el.contains(document.activeElement));
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
