import Fastify, { type FastifyError, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import rawBody from "fastify-raw-body";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ZodError } from "zod";
import { config, isProduction } from "./config.js";
import { ApiError } from "./lib/errors.js";
import tenantPlugin, { isPublicRoute } from "./plugins/tenant.js";
import { healthRoutes } from "./modules/health.js";
import { meRoutes } from "./modules/auth/me.js";
import { authRoutes } from "./modules/auth/auth.controller.js";
import { stripeRoutes } from "./modules/integrations/stripe.controller.js";
import { csvRoutes } from "./modules/integrations/csv.controller.js";
import { qboRoutes } from "./modules/integrations/qbo.controller.js";
import { inboundRoutes } from "./modules/inbound/inbound.controller.js";
import { invoicesRoutes } from "./modules/invoices/invoices.controller.js";
import { workflowRoutes } from "./modules/workflows/workflows.controller.js";
import { dashboardRoutes } from "./modules/dashboard/dashboard.controller.js";
import { activityRoutes } from "./modules/activity/activity.controller.js";
import { billingRoutes } from "./modules/billing/billing.controller.js";
import { devRoutes } from "./modules/dev/dev.controller.js";
import { repliesRoutes } from "./modules/replies/replies.controller.js";
import { membersRoutes } from "./modules/members/members.controller.js";
import { settingsRoutes } from "./modules/settings/settings.controller.js";
import { privacyRoutes } from "./modules/privacy/privacy.controller.js";
import { customerRoutes } from "./modules/customers/customers.controller.js";
import { cronRoutes } from "./modules/cron/cron.controller.js";
import { demoRoutes } from "./modules/demo/demo.controller.js";
import { adminRoutes } from "./modules/admin/admin.controller.js";
import { postmarkRoutes } from "./modules/email/postmark.controller.js";

/** Origins allowed to make state-changing browser requests (CSRF defence). */
export function allowedOrigins(): Set<string> {
  const set = new Set<string>();
  for (const o of config.webOrigin.split(",")) if (o.trim()) set.add(new URL(o.trim()).origin);
  try {
    set.add(new URL(config.appUrl).origin);
  } catch {
    /* ignore */
  }
  return set;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence in depth (the session cookie is already SameSite=Lax):
 *  - a browser request carrying an Origin we don't serve is rejected outright;
 *  - authenticated state-changing requests without an Origin must carry the
 *    custom `X-Requested-With` header the SPA sends (custom headers can't be
 *    sent cross-site without a CORS preflight we never grant).
 * Server-to-server webhooks (no Origin, public routes) are unaffected.
 */
export function csrfCheck(req: FastifyRequest, origins: Set<string>): void {
  if (SAFE_METHODS.has(req.method)) return;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (!origins.has(origin)) throw new ApiError(403, "CSRF_ORIGIN_REJECTED", "Cross-site request blocked");
    return;
  }
  if (!isPublicRoute(req) && !req.headers["x-requested-with"]) {
    throw new ApiError(403, "CSRF_HEADER_MISSING", "Missing X-Requested-With header");
  }
}

type PgError = { code?: string; constraint?: string };

function mapError(err: unknown): { status: number; code: string; message: string } | null {
  if (err instanceof ZodError) {
    return {
      status: 400,
      code: "VALIDATION_ERROR",
      message: err.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; "),
    };
  }
  if (err instanceof ApiError) return { status: err.statusCode, code: err.code, message: err.message };
  const pgCode = (err as PgError)?.code;
  if (typeof pgCode === "string" && /^[0-9A-Z]{5}$/.test(pgCode)) {
    if (pgCode === "22P02") return { status: 400, code: "INVALID_INPUT", message: "Invalid identifier or value" };
    if (pgCode === "23505") return { status: 409, code: "CONFLICT", message: "That record already exists" };
    if (pgCode === "23503") return { status: 409, code: "CONFLICT", message: "Related record is missing or still in use" };
    if (pgCode === "23514") return { status: 400, code: "INVALID_INPUT", message: "Value violates a data rule" };
    if (pgCode === "57014") return { status: 503, code: "TIMEOUT", message: "The request took too long. Please retry." };
    return null;
  }
  const httpErr = err as FastifyError;
  if (httpErr?.statusCode && httpErr.statusCode >= 400 && httpErr.statusCode < 500) {
    return { status: httpErr.statusCode, code: httpErr.code ?? "REQUEST_ERROR", message: httpErr.message };
  }
  return null;
}

export function buildApp() {
  const webDir = config.serveWebDir ? resolve(config.serveWebDir) : "";
  const serveWeb = Boolean(webDir && existsSync(resolve(webDir, "index.html")));
  // In single-container mode the SPA owns "/" and the API lives under "/api"
  // (same layout as the Vercel deployment). Otherwise routes stay at the root.
  const prefix = serveWeb ? "/api" : "";

  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers['x-cron-secret']",
          "req.headers['stripe-signature']",
          "res.headers['set-cookie']",
        ],
        censor: "[REDACTED]",
      },
    },
    // proxy-addr accepts a hop count at runtime; Fastify's typings omit `number`.
    trustProxy: config.trustProxy as boolean,
    bodyLimit: 2 * 1024 * 1024,
    requestIdHeader: "x-request-id",
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && /^[\w.-]{8,128}$/.test(incoming) ? incoming : randomUUID();
    },
    disableRequestLogging: true,
    return503OnClosing: true,
  });

  const origins = allowedOrigins();

  void app.register(cors, {
    origin: [...origins],
    credentials: true,
    allowedHeaders: ["content-type", "x-requested-with", "x-request-id"],
    exposedHeaders: ["x-request-id"],
    maxAge: 600,
  });
  void app.register(helmet, {
    // The API only serves JSON; the SPA (when served here) needs fonts + inline styles.
    contentSecurityPolicy: serveWeb
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'"],
            frameAncestors: ["'none'"],
            formAction: ["'self'"],
            baseUri: ["'self'"],
            objectSrc: ["'none'"],
            upgradeInsecureRequests: isProduction ? [] : null,
          },
        }
      : { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: "same-site" },
    strictTransportSecurity: isProduction ? { maxAge: 63072000, includeSubDomains: true, preload: false } : false,
  });
  void app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 5 } });
  void app.register(rawBody, { field: "rawBody", global: false, encoding: false, runFirst: true });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
    csrfCheck(req, origins);
  });

  // One structured line per request, with tenant context for correlation.
  app.addHook("onResponse", async (req, reply) => {
    const user = (req as { user?: { tenantId?: string; userId?: string } | null }).user;
    const level = reply.statusCode >= 500 ? "error" : reply.statusCode >= 400 ? "warn" : "info";
    if (req.url.endsWith("/health") && reply.statusCode === 200) return;
    req.log[level](
      {
        method: req.method,
        url: req.url.split("?")[0],
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
        tenantId: user?.tenantId || null,
        userId: user?.userId ?? null,
        ip: req.ip,
      },
      "request",
    );
  });

  // Per-tenant (or per-IP for anonymous traffic) rate limiting. Sensitive
  // auth routes set tighter per-route limits in their own config.
  // With REDIS_URL the counters are shared by every instance (required for
  // meaningful limits on serverless); otherwise they live in process memory.
  const redis =
    config.rateLimitEnabled && config.redisUrl
      ? new Redis(config.redisUrl, { connectTimeout: 2_000, commandTimeout: 1_000, maxRetriesPerRequest: 1 })
      : null;
  if (redis) {
    redis.on("error", (err) => app.log.warn({ err: err.message }, "rate-limit redis error"));
    app.addHook("onClose", async () => {
      await redis.quit().catch(() => redis.disconnect());
    });
  }
  if (config.rateLimitEnabled) void app.register(rateLimit, {
    global: true,
    ...(redis ? { redis, nameSpace: "autocollect-rl:", skipOnError: true } : {}),
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (req) => {
      const user = (req as { user?: { tenantId?: string } | null }).user;
      return user?.tenantId ? `tenant:${user.tenantId}` : `ip:${req.ip}`;
    },
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: { code: "RATE_LIMITED", message: `Too many requests. Try again in ${Math.ceil(ctx.ttl / 1000)}s.` },
    }),
  });

  app.setErrorHandler((err, req, reply) => {
    const mapped = mapError(err);
    if (mapped) {
      if (mapped.status >= 500) req.log.error({ err }, "mapped server error");
      return reply.status(mapped.status).send({ error: { code: mapped.code, message: mapped.message, requestId: req.id } });
    }
    const user = (req as { user?: { tenantId?: string } | null }).user;
    req.log.error({ err, tenantId: user?.tenantId ?? null, method: req.method, url: req.url }, "unhandled error");
    if (config.errorWebhookUrl && isProduction) {
      void fetch(config.errorWebhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          service: "autocollect-api",
          version: config.version,
          level: "error",
          message: (err as Error).message?.slice(0, 500),
          requestId: req.id,
          tenantId: user?.tenantId ?? null,
          url: req.url.split("?")[0],
          at: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => {});
    }
    return reply.status(500).send({
      error: { code: "INTERNAL", message: "Something went wrong on our side. Please retry.", requestId: req.id },
    });
  });

  // All API routes (prefixed with /api in single-container mode). Auth/tenant
  // scoping is registered inside this scope so it never guards static assets.
  void app.register(
    async (api) => {
      void api.register(tenantPlugin);
      void api.register(healthRoutes);
      void api.register(authRoutes);
      void api.register(meRoutes);
      void api.register(stripeRoutes);
      void api.register(csvRoutes);
      void api.register(qboRoutes);
      void api.register(inboundRoutes);
      void api.register(invoicesRoutes);
      void api.register(workflowRoutes);
      void api.register(dashboardRoutes);
      void api.register(activityRoutes);
      void api.register(billingRoutes);
      void api.register(devRoutes);
      void api.register(repliesRoutes);
      void api.register(membersRoutes);
      void api.register(settingsRoutes);
      void api.register(privacyRoutes);
      void api.register(customerRoutes);
      void api.register(cronRoutes);
      void api.register(demoRoutes);
      void api.register(adminRoutes);
      void api.register(postmarkRoutes);
    },
    { prefix },
  );

  if (serveWeb) {
    // Loaded only in single-container mode: serverless hosts serve the SPA themselves,
    // and this plugin pulls in dependencies their module loader cannot require.
    void app.register(import("@fastify/static"), {
      root: webDir,
      prefix: "/",
      wildcard: false,
      index: false,
      setHeaders: (res: { header(name: string, value: string): unknown }, path: string) => {
        // Hashed assets are immutable; index.html must always revalidate.
        res.header("cache-control", /[\\/]assets[\\/]/.test(path) ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    const isApi = !serveWeb || req.url.startsWith("/api/") || req.url === "/api";
    if (!isApi && (req.method === "GET" || req.method === "HEAD")) {
      // Client-side routes (/invoices/123, /settings, …) all load the SPA shell.
      return reply.header("cache-control", "no-cache").sendFile("index.html");
    }
    return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Route not found", requestId: req.id } });
  });

  return app;
}
