import { test, expect, type Page } from "@playwright/test";

/**
 * Signed-in flows. Uses the development-only /api/auth/dev-login endpoint to
 * create a fresh workspace per test (disabled outside development/test).
 */
async function signIn(page: Page, label: string): Promise<string> {
  const email = `pw-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const res = await page.request.post("/api/auth/dev-login", { data: { email } });
  expect(res.ok()).toBeTruthy();
  return email;
}

test("new workspace lands on the dashboard with onboarding", async ({ page }) => {
  await signIn(page, "dash");
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();
  await expect(page.getByText("Finish setup to start collecting automatically")).toBeVisible();
});

test("settings tabs cover workspace, integrations, team, billing, branding and account", async ({ page }) => {
  await signIn(page, "settings");
  await page.goto("/settings");
  for (const tab of ["Workspace", "Integrations", "Team", "Billing", "Branding", "Your account"]) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(page.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
  }
  await page.getByRole("tab", { name: "Billing" }).click();
  await expect(page.getByRole("button", { name: "Choose Growth" })).toBeVisible();
});

test("workspace preferences save and persist", async ({ page }) => {
  await signIn(page, "prefs");
  await page.goto("/settings?tab=workspace");
  await page.getByLabel("Company name").fill("Renamed Studio");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Workspace settings saved")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Company name")).toHaveValue("Renamed Studio");
});

test("owner can export workspace data and delete the workspace", async ({ page }) => {
  await signIn(page, "gdpr");
  await page.goto("/settings?tab=workspace");
  const name = await page.getByLabel("Company name").inputValue();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export workspace data" }).click();
  expect((await download).suggestedFilename()).toMatch(/^autocollect-.+\.json$/);

  await page.getByRole("button", { name: "Delete workspace…" }).click();
  const confirm = page.getByRole("button", { name: "Permanently delete" });
  await expect(confirm).toBeDisabled();
  await page.getByLabel(`Type "${name}" to confirm`).fill(name);
  await page.getByLabel("Your password").fill("dev-password-auto"); // dev-login accounts' password
  await confirm.click();
  await expect(page).toHaveURL(/\/login/);
});

test("seat limit on Starter points to upgrade instead of a failing invite form", async ({ page }) => {
  await signIn(page, "team");
  await page.goto("/settings?tab=team");
  await expect(page.getByText("All seats are in use.")).toBeVisible();
  await page.getByRole("button", { name: "Upgrade your plan" }).click();
  await expect(page.getByRole("tab", { name: "Billing" })).toHaveAttribute("aria-selected", "true");
  // The API enforces the same rule.
  const res = await page.request.post("/api/invitations", { data: { email: "teammate@example.com" }, headers: { "x-requested-with": "e2e" } });
  expect((await res.json()).error.code).toBe("SEAT_LIMIT_EXCEEDED");
});

test("approving templates and enabling the workflow clears the setup banner", async ({ page }) => {
  await signIn(page, "setup");
  const templates = await (await page.request.get("/api/templates")).json();
  for (const t of templates.templates) {
    await page.request.put(`/api/templates/${t.id}`, { data: { approved: true }, headers: { "x-requested-with": "e2e" } });
  }
  await page.goto("/workflows");
  await page.getByRole("button", { name: "Enable" }).click();
  await expect(page.getByText("Reminders are live")).toBeVisible();
  await page.goto("/dashboard");
  await expect(page.getByText("Finish setup to start collecting automatically")).toHaveCount(0);
});

test("invoice detail supports pay links and state changes", async ({ page }) => {
  await signIn(page, "invoice");
  const ing = await page.request.post("/api/integrations/stripe/dev-event", {
    data: { invoice: { id: `in_e2e_${Date.now()}`, due_days: -3, customer_name: "Globex", customer_email: "ap@globex.example" } },
    headers: { "x-requested-with": "e2e" },
  });
  expect(ing.ok()).toBeTruthy();
  await page.goto("/invoices");
  await page.getByText("Globex").first().click();
  await expect(page.getByRole("heading", { name: "Globex" })).toBeVisible();
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByText("Reminders paused")).toBeVisible();
  await page.getByRole("button", { name: "Resume reminders" }).click();
  await expect(page.getByText("Reminders resumed")).toBeVisible();
});

test("sign out ends the session", async ({ page }) => {
  await signIn(page, "logout");
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
});
