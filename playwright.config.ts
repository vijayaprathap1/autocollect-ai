import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests run against the production-shaped build: the API serves the
 * compiled SPA and mounts itself under /api (the same layout as the Docker
 * image and the Vercel deployment).
 *
 *   npm run test:e2e                      # builds web, starts API on :4000
 *   PLAYWRIGHT_BASE_URL=https://staging… npm run test:e2e   # against a deployment
 */
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:4000";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // Optional: use a preinstalled Chromium (air-gapped CI / sandboxes).
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : undefined,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: "npm run build -w @autocollect/shared && npm run build -w @autocollect/web && npm run dev:serve -w @autocollect/api",
        url: "http://localhost:4000/api/health",
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        env: {
          PORT: "4000",
          SERVE_WEB_DIR: "../web/dist",
          WEB_ORIGIN: "http://localhost:4000",
          APP_URL: "http://localhost:4000/api",
          RUN_SCHEDULER: "false",
          RATE_LIMIT_ENABLED: "false",
          // Hermetic: keys in a developer's .env would disable the dev simulators.
          EMAIL_PROVIDER: "mock",
          POSTMARK_SERVER_TOKEN: "",
          STRIPE_SECRET_KEY: "",
          STRIPE_CONNECT_CLIENT_ID: "",
          STRIPE_WEBHOOK_SECRET: "",
          STRIPE_BILLING_WEBHOOK_SECRET: "",
          TWILIO_ACCOUNT_SID: "",
          QBO_CLIENT_ID: "",
          QBO_CLIENT_SECRET: "",
          ANTHROPIC_API_KEY: "",
          GOOGLE_CLIENT_ID: "",
          GOOGLE_CLIENT_SECRET: "",
        },
      },
});
