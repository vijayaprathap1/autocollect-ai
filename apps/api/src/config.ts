import "dotenv/config";

/**
 * Centralised, typed configuration.
 *
 * Environment semantics (important for safety):
 *   - NODE_ENV=development | test  -> "dev-like": mocks, dev-login and simulators are allowed.
 *   - ANY other value (production, staging, unset-on-a-server, typos) -> production rules:
 *     dev routes are disabled and `validateProductionConfig()` enforces required secrets.
 *   Local `npm run dev` sets nothing, so NODE_ENV defaults to "development".
 */

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

function envInt(name: string, fallback: number, { min = -Infinity, max = Infinity } = {}): number {
  const raw = env(name);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${name}: expected an integer between ${min} and ${max}, got "${raw}"`);
  }
  return n;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = env(name).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`Invalid ${name}: expected true/false, got "${raw}"`);
}

function envList(name: string): string[] {
  return env(name)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const nodeEnv = env("NODE_ENV", "development");
/** Vercel functions: many short-lived instances share the database, so each keeps a small pool. */
const isServerless = Boolean(env("VERCEL"));
export const isDevLike = nodeEnv === "development" || nodeEnv === "test";
export const isProduction = !isDevLike;
/** @deprecated use `isDevLike` / `isProduction` */
export const isDev = isDevLike;

/** TRUST_PROXY: "true" (trust all), "false", or a hop count. Defaults to 1 hop in production. */
function trustProxySetting(): boolean | number {
  const raw = env("TRUST_PROXY");
  if (!raw) return isProduction ? 1 : false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return envBool("TRUST_PROXY", false);
}

export const config = {
  nodeEnv,
  port: envInt("PORT", 4000, { min: 1, max: 65535 }),
  host: env("HOST", "0.0.0.0"),
  logLevel: env("LOG_LEVEL", nodeEnv === "test" ? "silent" : "info"),
  version: env("APP_VERSION", env("VERCEL_GIT_COMMIT_SHA", env("GIT_SHA", "dev"))).slice(0, 40),
  trustProxy: trustProxySetting(),
  /** Rate limiting (per tenant / per IP). Disabled only for the automated test suite. */
  rateLimitEnabled: envBool("RATE_LIMIT_ENABLED", nodeEnv !== "test"),

  // Database
  databaseUrl: env("DATABASE_URL", "postgres://autocollect:autocollect_dev@localhost:5433/autocollect"),
  /**
   * Background/platform connections (webhooks, scheduler, sync, auth lookups).
   * In production this MUST be a BYPASSRLS service role; in dev it defaults to DATABASE_URL.
   */
  databaseServiceUrl: env("SERVICE_DATABASE_URL"),
  /** Owner/superuser URL used only by `db:migrate` / `db:roles` (DDL). Defaults to DATABASE_URL. */
  migrationDatabaseUrl: env("MIGRATION_DATABASE_URL"),
  dbPoolMax: envInt("DB_POOL_MAX", isServerless ? 3 : 10, { min: 1, max: 200 }),
  dbServicePoolMax: envInt("DB_SERVICE_POOL_MAX", isServerless ? 2 : 5, { min: 1, max: 200 }),
  dbConnectionTimeoutMs: envInt("DB_CONNECTION_TIMEOUT_MS", 10_000, { min: 100 }),
  dbStatementTimeoutMs: envInt("DB_STATEMENT_TIMEOUT_MS", 30_000, { min: 0 }),
  dbSsl: envBool("DB_SSL", false),
  /** Idle connections are dropped quickly on serverless so frozen instances don't hold database slots. */
  dbIdleTimeoutMs: envInt("DB_IDLE_TIMEOUT_MS", isServerless ? 5_000 : 30_000, { min: 0 }),

  webOrigin: env("WEB_ORIGIN", "http://localhost:5175"),
  appUrl: env("APP_URL", "http://localhost:4000"),
  /** Optional: serve the built SPA from this directory (single-container deploys). */
  serveWebDir: env("SERVE_WEB_DIR"),

  // Secrets
  credentialsEncryptionKey: env("CREDENTIALS_ENCRYPTION_KEY"),
  stateSecret: env("OAUTH_STATE_SECRET"),
  inboundWebhookToken: env("POSTMARK_WEBHOOK_TOKEN"),

  // Auth
  sessionTtlHours: envInt("SESSION_TTL_HOURS", 720, { min: 1 }), // 30 days
  resetTokenTtlMinutes: envInt("RESET_TOKEN_TTL_MINUTES", 60, { min: 5 }),
  verifyTokenTtlHours: envInt("VERIFY_TOKEN_TTL_HOURS", 24, { min: 1 }),
  loginMaxFailures: envInt("LOGIN_MAX_FAILURES", 5, { min: 1 }),
  loginLockoutMinutes: envInt("LOGIN_LOCKOUT_MINUTES", 15, { min: 1 }),
  superAdminEmail: env("SUPER_ADMIN_EMAIL", "admin@autocollect.local").toLowerCase(),
  superAdminPassword: env("SUPER_ADMIN_PASSWORD", "admin123"),

  // Stripe
  stripeSecretKey: env("STRIPE_SECRET_KEY"),
  stripeConnectClientId: env("STRIPE_CONNECT_CLIENT_ID"),
  /**
   * Webhook signing secrets. Stripe issues one secret PER ENDPOINT, and Connect
   * (connected-account) events and platform billing events need separate
   * endpoints — so accept several. Comma-separate in STRIPE_WEBHOOK_SECRET
   * and/or set STRIPE_BILLING_WEBHOOK_SECRET.
   */
  stripeWebhookSecrets: [...envList("STRIPE_WEBHOOK_SECRET"), ...envList("STRIPE_BILLING_WEBHOOK_SECRET")],

  // Platform billing (self-serve subscriptions)
  billingGrowthPriceId: env("BILLING_GROWTH_PRICE_ID"),
  billingProPriceId: env("BILLING_PRO_PRICE_ID"),
  billingAgencyPriceId: env("BILLING_AGENCY_PRICE_ID"),

  // Twilio SMS
  twilioAccountSid: env("TWILIO_ACCOUNT_SID"),
  twilioAuthToken: env("TWILIO_AUTH_TOKEN"),
  twilioFromNumber: env("TWILIO_FROM_NUMBER"),

  // QuickBooks Online
  qboClientId: env("QBO_CLIENT_ID"),
  qboClientSecret: env("QBO_CLIENT_SECRET"),
  qboEnv: env("QBO_ENV", "sandbox"),
  qboSyncIntervalMs: envInt("QBO_SYNC_INTERVAL_MS", 15 * 60_000, { min: 60_000 }),

  // Email: "auto" (Postmark if token set, else SMTP if configured, else mock/log), "postmark", "smtp", "ethereal", "mock"
  emailProvider: env("EMAIL_PROVIDER", "auto").toLowerCase(),
  postmarkServerToken: env("POSTMARK_SERVER_TOKEN"),
  /** Sender address for every provider (EMAIL_FROM_ADDRESS, or the older POSTMARK_FROM_EMAIL). */
  postmarkFromEmail: env("EMAIL_FROM_ADDRESS", env("POSTMARK_FROM_EMAIL", "no-reply@ar.autocollect.dev")),
  postmarkMessageStream: env("POSTMARK_MESSAGE_STREAM", "outbound"),
  emailFromName: env("EMAIL_FROM_NAME", "AutoCollect AI"),
  // Generic SMTP (Gmail app password, Brevo, Amazon SES, …). No delivery webhooks or inbound parsing.
  smtpHost: env("SMTP_HOST"),
  smtpPort: envInt("SMTP_PORT", 587, { min: 1, max: 65535 }),
  smtpUser: env("SMTP_USER"),
  smtpPass: env("SMTP_PASS"),
  /**
   * Postmark inbound address, e.g. `abc123@inbound.postmarkapp.com` or
   * `replies@in.yourdomain.com`. Reminders set Reply-To to
   * `local+<signed invoice ref>@domain` so customer replies route back to the invoice.
   */
  inboundReplyAddress: env("INBOUND_REPLY_ADDRESS"),

  // Anthropic
  anthropicApiKey: env("ANTHROPIC_API_KEY"),
  anthropicModel: env("ANTHROPIC_MODEL", "claude-sonnet-4-5"),

  // Google OAuth (optional)
  googleClientId: env("GOOGLE_CLIENT_ID"),
  googleClientSecret: env("GOOGLE_CLIENT_SECRET"),

  // Dunning / background work
  runScheduler: envBool("RUN_SCHEDULER", true),
  dunningScanIntervalMs: envInt("DUNNING_SCAN_INTERVAL_MS", 60_000, { min: 1_000 }),
  dunningBatchSize: envInt("DUNNING_BATCH_SIZE", 200, { min: 1, max: 5_000 }),
  /** Time budget per dunning run (keeps serverless cron invocations under their limit). */
  dunningTimeBudgetMs: envInt("DUNNING_TIME_BUDGET_MS", 45_000, { min: 1_000 }),

  // Monitoring
  errorWebhookUrl: env("ERROR_WEBHOOK_URL"),
  providerTimeoutMs: envInt("PROVIDER_TIMEOUT_MS", 15_000, { min: 1_000 }),

  // Serverless cron trigger secret (see modules/cron)
  cronSecret: env("CRON_SECRET"),
};

export function validateProductionConfig(): void {
  if (!isProduction) return;

  const problems: string[] = [];
  const need = (ok: boolean, msg: string) => {
    if (!ok) problems.push(msg);
  };

  need(Boolean(process.env.DATABASE_URL), "DATABASE_URL");
  need(Boolean(config.databaseServiceUrl), "SERVICE_DATABASE_URL (BYPASSRLS service role)");
  need(config.credentialsEncryptionKey.length === 32, "CREDENTIALS_ENCRYPTION_KEY (exactly 32 characters)");
  need(config.stateSecret.length >= 32, "OAUTH_STATE_SECRET (32+ random characters)");
  need(config.cronSecret.length >= 32, "CRON_SECRET (32+ random characters)");
  need(config.inboundWebhookToken.length >= 24, "POSTMARK_WEBHOOK_TOKEN (24+ random characters)");
  const smtpReady = Boolean(config.smtpHost && config.smtpUser && config.smtpPass);
  need(
    ["auto", "postmark", "smtp"].includes(config.emailProvider),
    `EMAIL_PROVIDER must be "postmark", "smtp" or "auto" in production (got "${config.emailProvider}")`,
  );
  if (config.emailProvider === "postmark") need(Boolean(config.postmarkServerToken), "POSTMARK_SERVER_TOKEN");
  else if (config.emailProvider === "smtp") need(smtpReady, "SMTP_HOST, SMTP_USER and SMTP_PASS");
  else need(Boolean(config.postmarkServerToken) || smtpReady, "POSTMARK_SERVER_TOKEN, or SMTP_HOST + SMTP_USER + SMTP_PASS");
  need(/^https:\/\//.test(config.webOrigin.split(",")[0] ?? ""), "WEB_ORIGIN must be an https:// origin");
  need(/^https:\/\//.test(config.appUrl), "APP_URL must be an https:// URL");
  need(
    config.superAdminPassword !== "admin123" && config.superAdminPassword.length >= 12,
    "SUPER_ADMIN_PASSWORD (not the default, 12+ characters)",
  );

  // Stripe is all-or-nothing.
  const stripeAny = Boolean(config.stripeSecretKey || config.stripeConnectClientId || config.stripeWebhookSecrets.length);
  if (stripeAny) {
    need(Boolean(config.stripeSecretKey), "STRIPE_SECRET_KEY");
    need(Boolean(config.stripeConnectClientId), "STRIPE_CONNECT_CLIENT_ID");
    need(config.stripeWebhookSecrets.length > 0, "STRIPE_WEBHOOK_SECRET");
    need(
      config.stripeWebhookSecrets.every((s) => s.startsWith("whsec_")),
      "STRIPE_WEBHOOK_SECRET / STRIPE_BILLING_WEBHOOK_SECRET must be whsec_... signing secrets",
    );
  }
  // Twilio is all-or-nothing.
  const twilioAny = Boolean(config.twilioAccountSid || config.twilioAuthToken || config.twilioFromNumber);
  if (twilioAny) {
    need(Boolean(config.twilioAccountSid && config.twilioAuthToken && config.twilioFromNumber), "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER together");
  }
  // Google OAuth is optional but must be complete if started.
  if (config.googleClientId || config.googleClientSecret) {
    need(Boolean(config.googleClientId && config.googleClientSecret), "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET together");
  }
  // QuickBooks is optional but must be complete if started.
  if (config.qboClientId || config.qboClientSecret) {
    need(Boolean(config.qboClientId && config.qboClientSecret), "QBO_CLIENT_ID and QBO_CLIENT_SECRET together");
  }

  if (problems.length > 0) {
    throw new Error(`Missing or unsafe production configuration:\n  - ${problems.join("\n  - ")}`);
  }
}
