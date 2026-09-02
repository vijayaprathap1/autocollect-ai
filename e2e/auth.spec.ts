import { test, expect } from "@playwright/test";

test.describe("public authentication flow", () => {
  test("signup route is visible to unauthenticated users", async ({ page }) => {
    await page.goto("/signup");

    await expect(page).toHaveURL(/\\/signup$/);
    await expect(page.getByText("Create your workspace", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();
    await expect(page.getByPlaceholder("jane@company.com")).toBeVisible();
  });

  test("login page navigates to signup", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("link", { name: "Start your free trial" }).click();

    await expect(page).toHaveURL(/\\/signup$/);
    await expect(page.getByText("Create your workspace", { exact: true })).toBeVisible();
  });

  test("signup shows verification confirmation without email delivery", async ({ page }) => {
    let signupPayload: { name: string; email: string; password: string } | undefined;
    await page.route("/**/api/auth/signup", async (route) => {
      signupPayload = route.request().postDataJSON() as typeof signupPayload;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          message: "If the address can be registered, a verification link has been sent",
        }),
      });
    });

    await page.goto("/signup");
    await page.getByPlaceholder("Jane Smith").fill("Jane Smith");
    await page.getByPlaceholder("jane@company.com").fill("jane@example.com");
    await page.getByPlaceholder("Min. 8 characters, include a letter and number").fill("Password1");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await expect(page.getByText("jane@example.com", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to sign in" })).toBeVisible();
    expect(signupPayload).toEqual({
      name: "Jane Smith",
      email: "jane@example.com",
      password: "Password1",
    });
  });

  test("verification token shows the verified state without email delivery", async ({ page }) => {
    await page.route("/**/api/auth/verify-email", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, message: "Email verified successfully" }),
      });
    });

    await page.goto("/verify-email?token=test-token");

    await expect(page.getByRole("heading", { name: "Email verified" })).toBeVisible();
    await expect(page.getByText("Your email has been verified.", { exact: false })).toBeVisible();
    await expect(page.getByRole("link", { name: /Sign in/ })).toBeVisible();
  });

  test("Google OAuth login flow", async ({ page }) => {
    // Mock the Google OAuth callback with a redirect to dashboard
    await page.route("/**/auth/google/callback", async (route) => {
      await route.fulfill({
        status: 302,
        headers: {
          Location: "/dashboard",
        },
        contentType: "text/html",
        body: "",
      });
    });

    // Mock the API endpoint that returns user session after OAuth
    await page.route("/**/api/auth/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          userId: "user_123",
          tenantId: "tenant_123",
          role: "member",
          tenantSlug: "test-org",
          isSuperAdmin: false,
          sessionType: "tenant",
        }),
      });
    });

    await page.goto("/login");

    // Click the "Sign in with Google" button
    await page.getByRole("button", { name: "SIGN IN WITH GOOGLE (TEST VERSION)" }).click();

    // Wait for navigation to dashboard (after OAuth callback)
    await page.waitForURL("/dashboard", { waitUntil: "domcontentloaded" });

    // Verify the user is on the dashboard
    await expect(page.getByText("Dashboard", { exact: true })).toBeVisible();
    await expect(page.getByText("Invoices")).toBeVisible();
  });
});
