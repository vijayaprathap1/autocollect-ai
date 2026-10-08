import { test, expect } from "@playwright/test";

test.describe("landing page", () => {
  test("explains the product and leads anonymous visitors to sign up", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Stop chasing invoices.");
    await expect(page.getByRole("heading", { name: "The default sequence" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Growth" })).toBeVisible();

    await page.getByRole("link", { name: "Start free" }).first().click();
    await expect(page).toHaveURL(/\/signup$/);
  });

  test("navigation reaches pricing and sign in", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Pricing" }).click();
    await expect(page).toHaveURL(/#pricing$/);
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Sign in to your workspace" })).toBeVisible();
  });

  test("mobile menu opens and links to sign up", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.locator("#mobile-menu").getByRole("link", { name: "Start free" }).click();
    await expect(page).toHaveURL(/\/signup$/);
  });
});

test.describe("legal pages", () => {
  test("terms and privacy are reachable from the landing footer", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("navigation", { name: "Footer" }).getByRole("link", { name: "Privacy" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Who we share it with/ })).toBeVisible();

    await page.getByRole("navigation", { name: "Footer" }).getByRole("link", { name: "Terms" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Terms of Service" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Governing law/ })).toBeVisible();
  });

  test("signup links to the terms it asks people to accept", async ({ page }) => {
    await page.goto("/signup");
    await page.getByRole("link", { name: "Terms of Service" }).click();
    await expect(page).toHaveURL(/\/terms$/);
  });
});
