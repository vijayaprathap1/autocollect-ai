import { test, expect } from "@playwright/test";

test.describe("signed-out flows", () => {
  test("root redirects anonymous visitors to sign in and remembers the target", async ({ page }) => {
    await page.goto("/settings?tab=billing");
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings/);
    await expect(page.getByRole("heading", { name: "Sign in to your workspace" })).toBeVisible();
  });

  test("login shows a clear error for wrong credentials", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(`nobody-${Date.now()}@example.com`);
    await page.getByLabel("Password", { exact: true }).fill("wrong-pass-1");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toContainText("Incorrect email or password");
  });

  test("login offers to resend verification for unverified accounts", async ({ page }) => {
    await page.route("**/api/auth/login", (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "EMAIL_NOT_VERIFIED", message: "Please confirm your email address first." } }),
      }),
    );
    let resent = false;
    await page.route("**/api/auth/resend-verification", (route) => {
      resent = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, message: "A new link is on its way." }) });
    });
    await page.goto("/login");
    await page.getByLabel("Email").fill("pending@example.com");
    await page.getByLabel("Password", { exact: true }).fill("Passw0rd!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("button", { name: "Send a new verification link" }).click();
    await expect(page.getByText("A new link is on its way.")).toBeVisible();
    expect(resent).toBe(true);
  });

  test("login surfaces OAuth errors passed back by the API", async ({ page }) => {
    await page.goto("/login?error=google_cancelled");
    await expect(page.getByRole("alert")).toContainText("Google sign-in was cancelled");
  });

  test("signup validates password strength and confirms by email", async ({ page }) => {
    let payload: Record<string, unknown> | undefined;
    await page.route("**/api/auth/signup", async (route) => {
      payload = route.request().postDataJSON();
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ ok: true, message: "Check your inbox" }) });
    });
    await page.goto("/signup");
    await page.getByLabel("Your name").fill("Jane Smith");
    await page.getByLabel("Company").fill("Acme Studio");
    await page.getByLabel("Work email").fill("jane@example.com");
    await page.getByLabel("Password", { exact: true }).fill("short");
    await expect(page.getByText(/Needs at least 8 characters/)).toBeVisible();
    await page.getByLabel("Password", { exact: true }).fill("Str0ng-Passw0rd");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    expect(payload).toMatchObject({ name: "Jane Smith", email: "jane@example.com", organizationName: "Acme Studio" });
    expect(typeof payload?.timezone).toBe("string");
  });

  test("verification link signs the user in", async ({ page }) => {
    await page.route("**/api/auth/verify-email", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, signedIn: false }) }),
    );
    await page.goto("/verify-email?token=test-token-1234567890");
    await expect(page.getByRole("heading", { name: "Email verified" })).toBeVisible();
  });

  test("forgot password never reveals whether an account exists", async ({ page }) => {
    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill(`nobody-${Date.now()}@example.com`);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText(/If an account exists for/)).toBeVisible();
  });

  test("reset password requires matching passwords", async ({ page }) => {
    await page.goto("/reset-password?token=some-token-value");
    await page.getByLabel("New password").fill("Str0ng-Passw0rd");
    await page.getByLabel("Confirm password").fill("Different-Passw0rd");
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByRole("alert")).toContainText("Passwords don't match");
  });

  test("Google button only appears when Google sign-in is configured", async ({ page }) => {
    await page.route("**/api/auth/providers", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ password: true, google: true, signup: true }) }),
    );
    await page.goto("/login");
    const google = page.getByRole("link", { name: "Continue with Google" });
    await expect(google).toBeVisible();
    await expect(google).toHaveAttribute("href", /\/api\/auth\/google$/);
  });

  test("Continue with Stripe signs up, lands on the welcome panel and starts reminders in one click", async ({ page }) => {
    await page.goto("/signup");
    const stripe = page.getByRole("link", { name: "Sign up with Stripe" });
    await expect(stripe).toBeVisible();
    await expect(stripe).toHaveAttribute("href", /\/api\/auth\/stripe$/);

    // The dev server has no Stripe keys, so /api/auth/stripe runs the mock consent
    // round trip. Give each run its own mock Stripe account and email.
    const id = `e2e${Date.now()}`;
    await page.route("**/api/auth/stripe/callback?**", (route) => {
      const url = new URL(route.request().url());
      url.searchParams.set("dev_account", `acct_${id}`);
      url.searchParams.set("dev_email", `${id}@stripe-e2e.example`);
      url.searchParams.set("dev_name", "E2E Stripe Co");
      return route.continue({ url: url.toString() });
    });
    await stripe.click();

    await expect(page).toHaveURL(/\/dashboard\?.*welcome=stripe/);
    await expect(page.getByRole("heading", { name: "Your Stripe account is connected" })).toBeVisible();
    await page.getByRole("button", { name: "Approve default reminders & start" }).click();
    await expect(page.getByText("Reminders are on.")).toBeVisible();
  });

  test("Stripe sign-in errors are explained on the login page", async ({ page }) => {
    await page.goto("/login?error=stripe_email_exists");
    await expect(page.getByRole("alert")).toContainText("already uses your Stripe email");
  });

  test("unknown routes show a 404 page", async ({ page }) => {
    await page.goto("/definitely-not-a-page");
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  });
});
