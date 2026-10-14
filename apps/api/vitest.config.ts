import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Integration tests share one database; run files sequentially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      // Tests call routes at the root; single-container mode would mount them under /api.
      SERVE_WEB_DIR: "",
      // Hermetic: never let provider keys from a developer's .env reach the suite
      // (dotenv does not override variables that are already defined, even empty).
      // Real keys would disable the dev simulators and could call live services.
      EMAIL_PROVIDER: "mock",
      POSTMARK_SERVER_TOKEN: "",
      SMTP_HOST: "",
      STRIPE_SECRET_KEY: "",
      STRIPE_CONNECT_CLIENT_ID: "",
      STRIPE_WEBHOOK_SECRET: "",
      STRIPE_BILLING_WEBHOOK_SECRET: "",
      TWILIO_ACCOUNT_SID: "",
      TWILIO_AUTH_TOKEN: "",
      TWILIO_FROM_NUMBER: "",
      QBO_CLIENT_ID: "",
      QBO_CLIENT_SECRET: "",
      ANTHROPIC_API_KEY: "",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      ERROR_WEBHOOK_URL: "",
    },
  },
});
