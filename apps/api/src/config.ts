import "dotenv/config";

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export const config = {
  nodeEnv: env("NODE_ENV", "development"),
  port: Number(env("PORT", "4000")),
  databaseUrl: env(
    "DATABASE_URL",
    "postgres://autocollect:autocollect_dev@localhost:5433/autocollect",
  ),
  /**
   * Background/platform connections (webhooks, scheduler, sync). In production
   * this should point at a BYPASSRLS service role so cross-tenant work is
   * allowed; the default of "same as DATABASE_URL" keeps dev/test parity.
   */
  databaseServiceUrl: env("SERVICE_DATABASE_URL", ""),
  webOrigin: env("WEB_ORIGIN", "http://localhost:5175"),
  appUrl: env("APP_URL", "http://localhost:4000"),

  // Secrets (used when present; dev falls back to deterministic mocks/plaintext)
  credentialsEncryptionKey: env("CREDENTIALS_ENCRYPTION_KEY"),
  stateSecret: env("OAUTH_STATE_SECRET", ""),
  inboundWebhookToken: env("POSTMARK_WEBHOOK_TOKEN"),

  // Auth
  clerkSecretKey: env("CLERK_SECRET_KEY"),
  clerkIssuer: env("CLERK_ISSUER"),
  devAuthEnabled: !env("CLERK_SECRET_KEY"),

  // Stripe
  stripeSecretKey: env("STRIPE_SECRET_KEY"),
  stripePlatformAccountId: env("STRIPE_PLATFORM_ACCOUNT_ID"),
  stripeConnectClientId: env("STRIPE_CONNECT_CLIENT_ID"),
  stripeWebhookSecret: env("STRIPE_WEBHOOK_SECRET"),

  // Platform billing (self-serve subscriptions)
  billingGrowthPriceId: env("BILLING_GROWTH_PRICE_ID"),
  billingProPriceId: env("BILLING_PRO_PRICE_ID"),
  billingAgencyPriceId: env("BILLING_AGENCY_PRICE_ID"),

  // Twilio SMS (Phase 2)
  twilioAccountSid: env("TWILIO_ACCOUNT_SID"),
  twilioAuthToken: env("TWILIO_AUTH_TOKEN"),
  twilioFromNumber: env("TWILIO_FROM_NUMBER"),

  // QuickBooks Online
  qboClientId: env("QBO_CLIENT_ID"),
  qboClientSecret: env("QBO_CLIENT_SECRET"),
  qboEnv: env("QBO_ENV", "sandbox"),

  // Postmark
  postmarkServerToken: env("POSTMARK_SERVER_TOKEN"),
  postmarkFromEmail: env("POSTMARK_FROM_EMAIL", "no-reply@ar.autocollect.dev"),

  // Anthropic
  anthropicApiKey: env("ANTHROPIC_API_KEY"),
  anthropicModel: env("ANTHROPIC_MODEL", "claude-sonnet-4-5"),

  // Dunning
  dunningScanIntervalMs: Number(env("DUNNING_SCAN_INTERVAL_MS", "60000")),

  // Monitoring
  errorWebhookUrl: env("ERROR_WEBHOOK_URL"),

  // Serverless cron trigger secret (see modules/cron)
  cronSecret: env("CRON_SECRET"),
};

export const isDev = config.nodeEnv !== "production";