import { expect, test, type Page } from "@playwright/test";

// The Koti page title is the current month, capitalised (e.g. "Syyskuu") -
// match any of the twelve rather than pin a specific month/date.
const MONTH_HEADING =
  /^(Tammikuu|Helmikuu|Maaliskuu|Huhtikuu|Toukokuu|Kesäkuu|Heinäkuu|Elokuu|Syyskuu|Lokakuu|Marraskuu|Joulukuu)$/;

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Sähköposti").fill("demo@lashkirja.fi");
  await page.getByLabel("Salasana", { exact: true }).fill("demo123");
  await Promise.all([
    page.waitForURL("**/dashboard"),
    page.getByRole("button", { name: "Kirjaudu sisään" }).click(),
  ]);
  // The demo seed is not onboarded. The perehdytys dialog covers the tab bar
  // until this is saved. Same call the viewport suite already uses.
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
}

test("protected pages redirect to login", async ({ page }) => {
  await page.goto("/kuitit/uusi");
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
});

test("login lands on the dashboard and the tab bar navigates", async ({ page }) => {
  await login(page);

  await expect(page.getByRole("heading", { name: MONTH_HEADING })).toBeVisible();
  await expect(page.getByText("Tulot", { exact: true })).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Päävalikko" });
  await expect(nav.getByRole("link", { name: "Muut" })).toHaveCount(0);

  // The tab bar's items are links (real hrefs); only the raised plus is a button.
  await nav.getByRole("link", { name: "Myynti" }).click();
  await expect(page).toHaveURL(/\/laskut$/);

  await nav.getByRole("link", { name: "Kirjanpito" }).click();
  await expect(page).toHaveURL(/\/kirjanpito$/);
  await page.getByRole("link", { name: /ALV-ilmoitus/ }).click();
  await expect(page).toHaveURL(/\/kirjanpito\/alv$/);
  await page.getByRole("button", { name: "Takaisin" }).click();
  await expect(page).toHaveURL(/\/kirjanpito$/);

  await nav.getByRole("button", { name: "Lisää" }).click();
  await expect(page.getByRole("button", { name: "Ota kuva" })).toBeVisible();
  await page.keyboard.press("Escape");

  await nav.getByRole("link", { name: "Raportit" }).click();
  await expect(page).toHaveURL(/\/raportit$/);

  await page.getByRole("button", { name: /Profiili, asetukset/ }).click();
  await page.getByRole("button", { name: "Asetukset", exact: true }).click();
  await expect(page).toHaveURL(/\/asetukset$/);
});

test("a bank account can be added and a month reconciled", async ({ page }) => {
  await login(page);
  await page.goto("/kirjanpito/pankkitilit");

  await page.getByRole("button", { name: "Lisää tili käsin" }).click();
  await page.getByLabel("Tilin nimi").fill("E2E Käyttötili");
  await page.getByLabel("IBAN").fill("FI21 1234 5600 0007 85");
  await page.getByLabel("Alkusaldo (€)").fill("1000");
  await page.getByLabel("Avauspäivä").fill("2026-01-01");
  await page.getByRole("button", { name: "Lisää tili", exact: true }).click();

  const card = page.getByRole("button", { name: /E2E Käyttötili/ });
  await expect(card).toBeVisible();
  await expect(page.getByText("Nordea").first()).toBeVisible(); // filled in from the IBAN

  await card.click();
  await page.getByRole("button", { name: "Kirjaa saldo" }).first().click();
  const balanceField = page.getByLabel("Pankin ilmoittama loppusaldo (€)");
  await balanceField.fill("1000");
  await page.getByRole("button", { name: "Tallenna" }).click();

  await expect(page.getByText("Täsmää").first()).toBeVisible();
});

test("a rejected IBAN never reaches the server", async ({ page }) => {
  await login(page);
  await page.goto("/kirjanpito/pankkitilit");

  await page.getByRole("button", { name: "Lisää tili käsin" }).click();
  await page.getByLabel("Tilin nimi").fill("Virheellinen");
  await page.getByLabel("IBAN").fill("FI2112345600000786");
  await page.getByRole("button", { name: "Lisää tili", exact: true }).click();

  await expect(page.getByText("IBAN ei ole kelvollinen.")).toBeVisible();
});

test("invoice goes from draft to paid", async ({ page }) => {
  await login(page);

  await page.goto("/asiakkaat");
  const main = page.getByRole("main");
  await main.getByRole("button", { name: "Uusi asiakas", exact: true }).click();
  await page.getByLabel("Nimi").fill("E2E Asiakas");
  await page.getByRole("button", { name: "Lisää asiakas" }).click();
  await expect(page.getByText("E2E Asiakas")).toBeVisible();

  await page.goto("/laskut");
  await page.getByRole("link", { name: "Uusi lasku" }).click();
  await page.getByRole("combobox", { name: "Asiakas" }).selectOption({ label: "E2E Asiakas" });
  await page.getByLabel("Rivin 1 kuvaus").fill("Ripsienpidennys");
  await page.getByLabel("Rivin 1 määrä").fill("1");
  await page.getByLabel("Rivin 1 hinta").fill("100");
  await expect(page.getByText("125,50 €").first()).toBeVisible(); // live total
  await page.getByRole("button", { name: "Luo lasku" }).click();

  // Creating the invoice opens it straight away (no trip back through the list).
  await expect(page).toHaveURL(/\/laskut\/lasku\?id=/);
  await expect(page.getByText("Luonnos", { exact: true })).toBeVisible();

  // "Merkitse lähetetyksi (ilman sähköpostia)" lives in the "..." menu (the
  // bottom bar's primary action for a draft is "Lähetä", the send-review
  // flow) and asks for a confirmation before booking.
  await page.getByRole("button", { name: "Lisää toimintoja" }).click();
  await page.getByRole("button", { name: /^Merkitse lähetetyksi/ }).click();
  await expect(page.getByRole("dialog").getByText("Merkitäänkö lähetetyksi?")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Merkitse", exact: true }).click();
  await expect(page.getByText("Lähetetty", { exact: true })).toBeVisible();

  // The payment form now opens in a "Kirjaa maksu" sheet (BottomActions'
  // primary for a sent, still-open invoice) instead of sitting inline.
  await page.getByRole("button", { name: "Kirjaa maksu" }).click();
  await page.getByLabel("Summa", { exact: true }).fill("125,50");
  await page.getByRole("dialog").getByRole("button", { name: "Uusi asiakas", exact: true }).click();
  // "Maksettu" appears both as the status and as the paid-amount row label.
  await expect(page.getByText("Maksettu", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Avoinna")).toHaveCount(0);
});

test("a purchase invoice can be added and marked paid", async ({ page }) => {
  await login(page);
  await page.goto("/kirjanpito/ostolaskut");

  await page.getByRole("button", { name: "Uusi ostolasku" }).click();
  await page.getByLabel("Toimittaja").fill("E2E Tukku");
  await page.getByLabel("Summa (€)").fill("124,00");
  await page.getByLabel("ALV (€)").fill("24,00");
  await page.getByRole("button", { name: "Lisää ostolasku" }).click();

  // .first(): the row's own button and its "..." menu (labelled "Lisää
  // toimintoja: E2E Tukku ...") both now match this name - the row itself
  // is first in DOM order.
  const card = page.getByRole("button", { name: /E2E Tukku/ }).first();
  await expect(card).toBeVisible();
  await card.click();

  await page.getByRole("button", { name: "Merkitse maksetuksi" }).click();
  await page.getByRole("button", { name: "Maksetut" }).click();
  await expect(page.getByText("E2E Tukku")).toBeVisible();
  await expect(page.getByText("Maksettu").first()).toBeVisible();
});

test("an invoice can be downloaded as a PDF", async ({ page, context }) => {
  await login(page);

  await page.goto("/asiakkaat");
  await page.getByRole("main").getByRole("button", { name: "Uusi asiakas", exact: true }).click();
  await page.getByLabel("Nimi").fill("PDF Asiakas");
  await page.getByRole("button", { name: "Lisää asiakas" }).click();

  await page.goto("/laskut");
  await page.getByRole("link", { name: "Uusi lasku" }).click();
  await page.getByRole("combobox", { name: "Asiakas" }).selectOption({ label: "PDF Asiakas" });
  await page.getByLabel("Rivin 1 kuvaus").fill("Ripsienpidennys");
  await page.getByLabel("Rivin 1 hinta").fill("100");
  await page.getByRole("button", { name: "Luo lasku" }).click();

  // The new invoice opens straight away.
  await expect(page).toHaveURL(/\/laskut\/lasku\?id=/);
  // "Avaa PDF" moved into the "..." menu (it opens the PDF via window.open
  // instead of an <a href> link, so it is a button once the sheet is open).
  await page.getByRole("button", { name: "Lisää toimintoja" }).click();
  await expect(page.getByRole("button", { name: "Avaa PDF" })).toBeVisible();
  await page.keyboard.press("Escape");

  const url = new URL(page.url());
  const id = url.searchParams.get("id");
  const cookies = await context.cookies();
  const response = await page.request.get(`/api/invoices/${id}/pdf`, {
    headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") },
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/pdf");
  const body = await response.body();
  expect(body.subarray(0, 5).toString("ascii")).toBe("%PDF-");
});

test("CSV export is served as a downloadable file", async ({ page, context }) => {
  await login(page);
  const cookies = await context.cookies();
  const response = await page.request.get("/api/export?type=receipts", {
    headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") },
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/csv");
  expect(response.headers()["content-disposition"]).toContain("kuitit.csv");
});

test("responses include the launch security baseline", async ({ request }) => {
  const response = await request.get("/login");
  expect(response.ok()).toBeTruthy();
  expect(response.headers()["x-powered-by"]).toBeUndefined();
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["x-frame-options"]).toBe("DENY");
});

// Runs last: it closes the books and reopens them, and a lock left behind
// would break every earlier test's assumptions.
test("closing the books makes an earlier period read-only", async ({ page }) => {
  await login(page);
  await page.goto("/kirjanpito/kaudet");

  const lockSelect = page.getByLabel("Lukitse kaudet tähän kuukauteen asti");
  const currentMonth = await lockSelect.locator("option").nth(1).getAttribute("value");
  await lockSelect.selectOption(currentMonth!);
  await page.getByRole("button", { name: "Lukitse", exact: true }).click();
  // Open items are listed first ("Lukitse silti"); a clean month goes straight to the confirm.
  const lockAnyway = page.getByRole("button", { name: "Lukitse silti" });
  const dialog = page.getByRole("dialog");
  await expect(dialog.or(lockAnyway)).toBeVisible();
  if (await lockAnyway.isVisible()) await lockAnyway.click();
  await dialog.getByRole("button", { name: "Lukitse", exact: true }).click();
  await expect(page.getByText(/Kirjanpito lukittu/)).toBeVisible();

  await page.goto("/asiakkaat");
  await page.getByRole("main").getByRole("button", { name: "Uusi asiakas", exact: true }).click();
  await page.getByLabel("Nimi").fill("Lukko Asiakas");
  await page.getByRole("button", { name: "Lisää asiakas" }).click();

  await page.goto("/laskut");
  await page.getByRole("link", { name: "Uusi lasku" }).click();
  await page.getByRole("combobox", { name: "Asiakas" }).selectOption({ label: "Lukko Asiakas" });
  await page.getByLabel("Rivin 1 kuvaus").fill("Lukittu kausi");
  await page.getByLabel("Rivin 1 hinta").fill("50");
  // Date the invoice inside the closed month.
  await page.getByLabel("Laskun päivä").fill(`${currentMonth}-01`);
  await page.getByRole("button", { name: "Luo lasku" }).click();

  await expect(page.getByText(/lukittu/i)).toBeVisible();

  await page.goto("/kirjanpito/kaudet");
  await page.getByRole("button", { name: "Avaa kirjanpito uudelleen" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Avaa kirjanpito" }).click();
  await expect(page.getByText("Kirjanpito avattiin.")).toBeVisible();
});

test("a recurring invoice generates a real invoice", async ({ page }) => {
  await login(page);

  await page.goto("/asiakkaat");
  await page.getByRole("main").getByRole("button", { name: "Uusi asiakas", exact: true }).click();
  await page.getByLabel("Nimi").fill("Toisto Asiakas");
  await page.getByRole("button", { name: "Lisää asiakas" }).click();

  await page.goto("/toistuvat");
  await page.getByRole("button", { name: "Uusi toistuva lasku" }).click();
  await page.getByRole("combobox", { name: "Asiakas" }).selectOption({ label: "Toisto Asiakas" });
  await page.getByLabel("Rivin 1 kuvaus").fill("Kuukausiylläpito");
  await page.getByLabel("Rivin 1 hinta").fill("50");
  // Start in the past so the first occurrence is immediately due.
  await page.getByLabel("Alkaa").fill("2026-01-01");
  // The empty state behind the sheet has a button of the same name; the submit is in the dialog.
  await page.getByRole("dialog").getByRole("button", { name: "Luo toistuva lasku" }).click();

  await expect(page.getByText("Toisto Asiakas").first()).toBeVisible();
  // Two steps: the preview sheet lists what would be created, then the confirm books it.
  await page.getByRole("button", { name: "Luo erääntyneet laskut" }).click();
  await page.getByRole("dialog").getByRole("button", { name: /^Luo (lasku|\d+ laskua)$/ }).click();
  await expect(page.getByText(/(1 lasku|\d+ laskua) luotiin\./)).toBeVisible();

  await page.goto("/laskut");
  await expect(page.getByText("Toisto Asiakas").first()).toBeVisible();
});

test("privacy request status is visible and the lock PIN is masked", async ({ page }) => {
  await login(page);
  const requested = await page.request.post("/api/account/request", {
    data: { kind: "export", currentPassword: "demo123" },
  });
  expect(requested.ok()).toBe(true);

  await page.goto("/asetukset/tietosuoja");
  await expect(page.getByText("Tietojen kopio")).toBeVisible();
  await expect(page.getByText("Odottaa")).toBeVisible();

  await page.goto("/asetukset/turvallisuus/lukitus");
  await expect(page.locator("#lockPin")).toHaveAttribute("type", "password");

  await page.goto("/asiakkaat");
  await page.getByRole("main").getByRole("button", { name: "Uusi asiakas", exact: true }).click();
  await page.getByLabel("Nimi").fill("Luonnos Asiakas");
  await expect(page.getByText("Luonnos tallennettu.")).toBeVisible();
  // The notice's own "Sulje" (the sheet's close button carries the same name).
  await page.getByRole("status").getByRole("button", { name: "Sulje" }).click();
  await expect(page.getByText("Luonnos tallennettu.")).toBeHidden();
});
