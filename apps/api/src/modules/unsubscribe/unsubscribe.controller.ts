import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { servicePool } from "../../lib/db.js";
import { verifyUnsubscribe } from "../../lib/unsubscribe.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function page(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}
main{max-width:420px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;text-align:center}
h1{font-size:20px;margin:0 0 8px}p{color:#475569;margin:0}</style></head>
<body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

/**
 * Public one-click unsubscribe for payment-reminder emails. Links are HMAC
 * signed per customer, so they cannot be forged for other customers.
 * GET shows a confirmation page; POST supports RFC 8058 one-click.
 */
export async function unsubscribeRoutes(app: FastifyInstance) {
  // RFC 8058 one-click POSTs `List-Unsubscribe=One-Click` as a form body; the
  // parameters we need are in the query string, so accept and ignore it.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, body);
  });

  async function handle(req: FastifyRequest, reply: FastifyReply) {
    const q = req.query as { c?: string; s?: string };
    const customerId = q.c ?? "";
    const signature = q.s ?? "";
    reply.header("Cache-Control", "no-store");

    if (!UUID_RE.test(customerId) || !verifyUnsubscribe(customerId, signature)) {
      return reply
        .status(400)
        .type("text/html; charset=utf-8")
        .send(page("Link not valid", "This unsubscribe link is invalid or has been altered."));
    }

    const updated = await servicePool.query<{ tenant_id: string }>(
      `UPDATE customers SET email_opt_out = TRUE WHERE id = $1 RETURNING tenant_id`,
      [customerId],
    );
    const tenantId = updated.rows[0]?.tenant_id;
    if (tenantId) {
      await servicePool
        .query(
          `INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, 'customer', 'email_unsubscribed', $2::jsonb)`,
          [tenantId, JSON.stringify({ customer_id: customerId, method: req.method })],
        )
        .catch(() => {});
    }

    return reply
      .type("text/html; charset=utf-8")
      .send(page("You're unsubscribed", "You will no longer receive payment reminder emails for this account."));
  }

  app.route({
    method: ["GET", "POST"],
    url: "/unsubscribe",
    config: { public: true },
    handler: async (req, reply) => handle(req, reply),
  });
}
