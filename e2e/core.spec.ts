import { test, expect, type Page } from "@playwright/test";

/**
 * E2E smoke tests for the core tenant flows.
 * Dev auth mode provisions a fresh tenant per unique email, so every test is
 * isolated: a new org with a default (disabled) workflow and no invoices.
 */
async function login(page: Page, email: string): Promise<void> {
  await page.addInitScript((addr) => {
    localStorage.setItem("autocollect.dev-user", addr);
  }, email);
  await page.goto("/dashboard");
  await expect(page.getByText("Dashboard", { exact: true }).first()).toBeVisible();
}

test("fresh tenant lands on dashboard with an empty invoice list", async ({ page }) => {
  await login(page, `pw-dash-${Date.now()}@example.com`);
  await expect(page.getByText("Invoices", { exact: true }).first()).toBeVisible();
});

test("navigation reaches Settings with billing, members and branding cards", async ({ page }) => {
  await login(page, `pw-settings-${Date.now()}@example.com`);
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Branding" })).toBeVisible();
  await expect(page.getByText("Sync invoices from QuickBooks Online", { exact: false })).toBeVisible();
});

test("plan ladder is visible and upgrade buttons render", async ({ page }) => {
  await login(page, `pw-billing-${Date.now()}@example.com`);
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByText("Upgrade to Growth")).toBeVisible();
  await expect(page.getByText("Upgrade to Pro")).toBeVisible();
  await expect(page.getByText("Upgrade to Agency")).toBeVisible();
});

test("seat limit blocks a member invite on the free plan", async ({ page }) => {
  const email = `pw-members-${Date.now()}@example.com`;
  await login(page, email);
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("heading", { name: "Members" }).waitFor();

  await expect(page.getByText("1 / 1 seats")).toBeVisible();
  await page.getByPlaceholder("teammate@company.com").fill("colleague@example.com");
  await page.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByText("Member limit reached")).toBeVisible();
});

test("Replies page renders the reply inbox", async ({ page }) => {
  await login(page, `pw-replies-${Date.now()}@example.com`);
  await page.getByRole("link", { name: "Replies" }).click();
  await expect(page.getByRole("heading", { name: "Replies" })).toBeVisible();
});

test("demo data seeds the workspace with invoices and replies", async ({ page }) => {
  const email = `pw-demo-${Date.now()}@example.com`;
  await login(page, email);

  await page.getByRole("button", { name: "Load demo data" }).click();
  await expect(page.getByText("Loading demo data…")).toBeVisible();

  await expect(page.getByText("Outstanding", { exact: true })).toBeVisible();
  await expect(page.getByText("Overdue", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Customers" }).waitFor({ state: "visible" });
  await page.getByRole("link", { name: "Customers" }).click();
  await expect(page.getByRole("heading", { name: "Customers" })).toBeVisible();

  await page.getByRole("link", { name: "Replies" }).click();
  await expect(page.getByText("promise", { exact: false }).first()).toBeVisible();
});