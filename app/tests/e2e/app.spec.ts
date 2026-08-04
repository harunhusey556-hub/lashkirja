import { expect, test } from "@playwright/test";

async function login(page: import("@playwright/test").Page) {
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

test("login hydrates and primary controls remain interactive", async ({ page }) => {
  await login(page);

  await expect(page.getByText(/Liisa!/)).toBeVisible();
  await expect(page.getByText("TULOT")).toBeVisible();

  await page.getByRole("button", { name: "Valikko" }).click();
  const nav = page.getByRole("navigation");
  await expect(nav).toBeVisible();
  await nav.getByText("Tiliotteet", { exact: true }).click();
  await expect(page).toHaveURL(/\/tiliotteet$/);

  const fileChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Valitse tiedosto" }).click();
  await fileChooser;
});

test("responses include the launch security baseline", async ({ request }) => {
  const response = await request.get("/login");
  expect(response.ok()).toBeTruthy();
  expect(response.headers()["x-powered-by"]).toBeUndefined();
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["x-frame-options"]).toBe("DENY");
  expect(response.headers()["content-security-policy"]).toContain(
    "frame-ancestors 'none'"
  );
});
