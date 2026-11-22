import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page, label: string) {
  const email = `pw-ent-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const res = await page.request.post("/api/auth/dev-login", { data: { email } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

test("cash, credit, forecast and analytics render for a new workspace", async ({ page }) => {
  await signIn(page, "desk");
  await page.goto("/cash");
  await expect(page.getByRole("heading", { name: "Cash application" })).toBeVisible();
  await page.getByLabel("Reference").fill("wire-100");
  await page.getByLabel("Amount").fill("25.00");
  await page.getByRole("button", { name: "Record receipt" }).click();
  await expect(page.getByText("wire-100")).toBeVisible();

  await page.goto("/credit");
  await expect(page.getByRole("heading", { name: "Credit" })).toBeVisible();
  await page.goto("/forecast");
  await expect(page.getByRole("heading", { name: "Cash forecast" })).toBeVisible();
  await page.goto("/analytics");
  await expect(page.getByRole("heading", { name: "Process analytics" })).toBeVisible();
  await expect(page.getByText("open disputes")).toBeVisible();
});

test("command palette lists workspace pages", async ({ page }) => {
  await signIn(page, "palette");
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
  await page.getByRole("button", { name: "Invoices" }).click();
  await expect(page).toHaveURL(/\/invoices/);
});

test("invoice export returns a spreadsheet", async ({ page }) => {
  await signIn(page, "export");
  const res = await page.request.get("/api/exports/invoices?format=csv");
  expect(res.ok()).toBeTruthy();
  expect(res.headers()["content-type"]).toContain("text/csv");
});
