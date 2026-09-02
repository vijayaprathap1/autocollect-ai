import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import rawBody from "fastify-raw-body";
import { ZodError } from "zod";
import { config } from "./config.js";
import { ApiError } from "./lib/errors.js";
import tenantPlugin from "./plugins/tenant.js";
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
import { customerRoutes } from "./modules/customers/customers.controller.js";
import { cronRoutes } from "./modules/cron/cron.controller.js";
import { demoRoutes } from "./modules/demo/demo.controller.js";
import { adminRoutes } from "./modules/admin/admin.controller.js";
import { postmarkRoutes } from "./modules/email/postmark.controller.js";

export function buildApp() {
  const app = Fastify({
    logger: {
      level: config.nodeEnv === "test" ? "silent" : "info",
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", "req.headers['x-dev-user']", "res.headers['set-cookie']"],
        censor: "[REDACTED]",
      },
    },
    bodyLimit: 5 * 1024 * 1024,
  });

  void app.register(cors, {
    origin: config.webOrigin.split(",").map((s) => s.trim()),
    credentials: true,
  });
  void app.register(helmet);
  void app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  });
  void app.register(rawBody, {
    field: "rawBody",
    global: false,
    routes: ["/integrations/stripe/webhook"],
  });

  void app.register(tenantPlugin);

  // Structured request logging with tenant context (helps ops correlate traffic).
  app.addHook("onResponse", async (req, reply) => {
    const user = (req as { user?: { tenantId?: string } }).user;
    req.log.info(
      {
        method: req.method,
        url: req.url,
        statusCode: reply.statusCode,
        durationMs: reply.elapsedTime,
        tenantId: user?.tenantId ?? null,
      },
      "request",
    );
  });

  // Per-tenant (or per-IP for public routes) rate limiting. Registered after
  // auth so the tenant key is available for the keyGenerator.
  app.addHook("onRoute", (route) => {
    const routeConfig = route.config as { public?: boolean; rateLimit?: unknown } | undefined;
    if (!routeConfig?.public || !route.url.startsWith("/auth/")) return;
    routeConfig.rateLimit = { max: 20, timeWindow: "1 minute" };
  });

  void app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (req) => {
      const user = (req as { user?: { tenantId?: string } }).user;
      if (user?.tenantId) return `tenant:${user.tenantId}`;
      return `ip:${req.ip}`;
    },
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        },
      });
    }
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    const httpErr = err as { statusCode?: number; code?: string; message: string };
    if (httpErr.statusCode && httpErr.statusCode >= 400 && httpErr.statusCode < 500) {
      return reply.status(httpErr.statusCode).send({
        error: { code: httpErr.code ?? "REQUEST_ERROR", message: httpErr.message },
      });
    }
    const user = (req as { user?: { tenantId?: string } }).user;
    req.log.error(
      {
        err,
        tenantId: user?.tenantId ?? null,
        method: req.method,
        url: req.url,
      },
      "unhandled error",
    );
    if (config.errorWebhookUrl && config.nodeEnv === "production") {
      void fetch(config.errorWebhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          service: "autocollect-api",
          level: "error",
          message: httpErr.message,
          tenantId: user?.tenantId ?? null,
          url: req.url,
          at: new Date().toISOString(),
        }),
      }).catch(() => {});
    }
    return reply.status(500).send({ error: { code: "INTERNAL", message: "Internal server error" } });
  });

  void app.register(healthRoutes);
  void app.register(authRoutes);
  void app.register(meRoutes);
  void app.register(stripeRoutes);
  void app.register(csvRoutes);
  void app.register(qboRoutes);
  void app.register(inboundRoutes);
  void app.register(invoicesRoutes);
  void app.register(workflowRoutes);
  void app.register(dashboardRoutes);
  void app.register(activityRoutes);
  void app.register(billingRoutes);
  void app.register(devRoutes);
  void app.register(repliesRoutes);
  void app.register(membersRoutes);
  void app.register(settingsRoutes);
  void app.register(customerRoutes);
  void app.register(cronRoutes);
  void app.register(demoRoutes);
  void app.register(adminRoutes);
  void app.register(postmarkRoutes);

  return app;
}