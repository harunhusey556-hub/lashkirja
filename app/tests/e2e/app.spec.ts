import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Sähköposti").fill("demo@lashkirja.fi");
  await page.getByLabel("Salasana").fill("demo123");
  await Promise.all([
    page.waitForURL("**/dashboard"),
    page.getByRole("button", { name: "Kirjaudu sisään" }).click(),
  ]);
}

test("protected pages redirect to login", async ({ page }) => {
  await page.goto("/kuitit/uusi");
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
});

test("login lands on the dashboard and the tab bar navigates", async ({ page }) => {
  await login(page);

  await expect(page.getByRole("heading", { name: /Liisa!/ })).toBeVisible();
  await expect(page.getByText("Tulot", { exact: true })).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Päävalikko" });
  await nav.getByRole("link", { name: "Tiliote" }).click();
  await expect(page).toHaveURL(/\/tiliotteet$/);

  await nav.getByRole("link", { name: "Pankki" }).click();
  await expect(page).toHaveURL(/\/pankkitilit$/);

  // Secondary destinations live behind the "Lisää" sheet.
  await nav.getByRole("button", { name: "Lisää" }).click();
  await page.getByRole("menuitem", { name: /Myyntilaskut/ }).click();
  await expect(page).toHaveURL(/\/laskut$/);
});

test("a bank account can be added and a month reconciled", async ({ page }) => {
  await login(page);
  await page.goto("/pankkitilit");

  await page.getByRole("button", { name: "Lisää pankkitili" }).click();
  await page.getByLabel("Tilin nimi").fill("E2E Käyttötili");
  await page.getByLabel("IBAN").fill("FI21 1234 5600 0007 85");
  await page.getByLabel("Alkusaldo (€)").fill("1000");
  await page.getByLabel("Avauspäivä").fill("2026-01-01");
  await page.getByRole("button", { name: "Lisää tili" }).click();

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
  await page.goto("/pankkitilit");

  await page.getByRole("button", { name: "Lisää pankkitili" }).click();
  await page.getByLabel("Tilin nimi").fill("Virheellinen");
  await page.getByLabel("IBAN").fill("FI2112345600000786");
  await page.getByRole("button", { name: "Lisää tili" }).click();

  await expect(page.getByText("IBAN ei ole kelvollinen.")).toBeVisible();
});

test("invoice goes from draft to paid", async ({ page }) => {
  await login(page);

  await page.goto("/asiakkaat");
  const main = page.getByRole("main");
  await main.getByRole("button", { name: "Lisää", exact: true }).click();
  await page.getByLabel("Nimi").fill("E2E Asiakas");
  await page.getByRole("button", { name: "Lisää asiakas" }).click();
  await expect(page.getByText("E2E Asiakas")).toBeVisible();

  await page.goto("/laskut");
  await page.getByRole("button", { name: "Uusi lasku" }).click();
  await page.getByLabel("Asiakas").selectOption({ label: "E2E Asiakas" });
  await page.getByLabel("Rivin 1 kuvaus").fill("Ripsienpidennys");
  await page.getByLabel("Rivin 1 määrä").fill("1");
  await page.getByLabel("Rivin 1 hinta").fill("100");
  await expect(page.getByText("125,50 €").first()).toBeVisible(); // live total
  await page.getByRole("button", { name: "Luo lasku" }).click();

  await page.getByRole("link", { name: /E2E Asiakas/ }).first().click();
  await expect(page).toHaveURL(/\/laskut\/[^/]+$/);
  await expect(page.getByText("Luonnos", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Merkitse lähetetyksi" }).click();
  await expect(page.getByText("Lähetetty", { exact: true })).toBeVisible();

  await page.getByLabel("Maksun summa").fill("125,50");
  await page.getByRole("main").getByRole("button", { name: "Lisää", exact: true }).click();
  // "Maksettu" appears both as the status and as the paid-amount row label.
  await expect(page.getByText("Maksettu", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Avoinna")).toHaveCount(0);
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
