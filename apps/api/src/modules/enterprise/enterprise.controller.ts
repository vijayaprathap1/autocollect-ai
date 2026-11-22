import type { FastifyInstance, FastifyReply } from "fastify";
import { parse as parseCsv } from "csv-parse/sync";
import { z } from "zod";
import { requireRole } from "../../plugins/tenant.js";
import { assertUuid, badRequest } from "../../lib/errors.js";
import { toCents } from "../integrations/csv.controller.js";
import { applyCash, bookSettledReceipt, recordPayment, suggestionsForPayment } from "../../lib/cash-ledger.js";
import { creditStanding } from "../../lib/credit.js";
import { forecastCollections } from "../../lib/forecast.js";

const manager = requireRole("manager");
const writer = requireRole("member");

function csv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const esc = (value: unknown) => {
    let text = value == null ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(","), ...rows.map((row) => headers.map((h) => esc(row[h])).join(","))].join("\n");
}

function sendTable(reply: FastifyReply, name: string, format: string, rows: Record<string, unknown>[]) {
  const body = csv(rows);
  if (format === "xls") {
    const headers = rows[0] ? Object.keys(rows[0]) : [];
    const xml =
      `<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Export" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Table>` +
      `<Row>${headers.map((h) => `<Cell><Data ss:Type="String">${h}</Data></Cell>`).join("")}</Row>` +
      rows
        .map(
          (row) =>
            `<Row>${headers
              .map((h) => `<Cell><Data ss:Type="String">${String(row[h] ?? "").replace(/[<>&]/g, "").replace(/^[=+\-@]/, "'")}</Data></Cell>`)
              .join("")}</Row>`,
        )
        .join("") +
      `</Table></Worksheet></Workbook>`;
    return reply
      .header("content-type", "application/vnd.ms-excel")
      .header("content-disposition", `attachment; filename="${name}.xls"`)
      .send(xml);
  }
  return reply
    .header("content-type", "text/csv; charset=utf-8")
    .header("content-disposition", `attachment; filename="${name}.csv"`)
    .send(`\uFEFF${body}`);
}

export async function enterpriseRoutes(app: FastifyInstance) {
  app.get("/cash/payments", async (req) => {
    const q = z.object({ unapplied: z.enum(["1", "0"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query ?? {});
    const rows = await req.db.query(
      `SELECT p.id, p.customer_id, c.name AS customer_name, p.source, p.external_id, p.amount, p.unapplied, p.currency,
              p.paid_at, p.reference
         FROM payments p LEFT JOIN customers c ON c.id = p.customer_id
        WHERE p.tenant_id = $1 AND ($2::boolean IS NOT TRUE OR p.unapplied > 0)
        ORDER BY p.paid_at DESC LIMIT $3`,
      [req.user.tenantId, q.unapplied === "1", q.limit],
    );
    return { payments: rows.rows.map(money) };
  });

  app.post("/cash/payments", { preHandler: writer, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = z
      .object({
        customerId: z.string().uuid().nullable().optional(),
        source: z.enum(["qbo", "csv", "manual"]).default("manual"),
        externalId: z.string().trim().min(1).max(120),
        amount: z.number().int().positive(),
        currency: z.string().trim().length(3).default("usd"),
        reference: z.string().trim().max(200).optional(),
      })
      .parse(req.body ?? {});
    const payment = await recordPayment(req.db, {
      tenantId: req.user.tenantId,
      customerId: body.customerId ?? null,
      source: body.source,
      externalId: body.externalId,
      amount: body.amount,
      currency: body.currency.toLowerCase(),
      reference: body.reference ?? null,
    });
    await req.db.query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'payment_recorded', $3::jsonb)`, [
      req.user.tenantId,
      req.user.email,
      JSON.stringify({ payment_id: payment.id, amount: body.amount, source: body.source }),
    ]);
    return reply.status(payment.created ? 201 : 200).send({ payment });
  });

  app.get("/cash/payments/:id/suggestions", async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "Payment");
    return { suggestions: await suggestionsForPayment(req.db, req.user.tenantId, id) };
  });

  app.post("/cash/payments/:id/apply", { preHandler: writer, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "Payment");
    const body = z
      .object({
        lines: z.array(z.object({ invoiceId: z.string().uuid(), amount: z.number().int().positive() })).min(1).max(20),
        acceptSuggestion: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    try {
      const result = await applyCash(req.db, {
        tenantId: req.user.tenantId,
        paymentId: id,
        lines: body.lines,
        userId: req.user.userId,
        method: body.acceptSuggestion ? "suggested" : "manual",
      });
      return { ok: true, ...result };
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : "Could not apply cash");
    }
  });

  app.post("/cash/payments/:id/dismiss", { preHandler: writer, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "Payment");
    const updated = await req.db.query(
      `UPDATE payments SET unapplied = 0 WHERE id = $1 AND tenant_id = $2 AND unapplied > 0 RETURNING id`,
      [id, req.user.tenantId],
    );
    if (!updated.rows[0]) throw badRequest("Nothing unapplied on that receipt");
    await req.db.query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'cash_dismissed', $3::jsonb)`, [
      req.user.tenantId,
      req.user.email,
      JSON.stringify({ payment_id: id }),
    ]);
    return { ok: true };
  });

  app.post("/cash/import", { preHandler: writer, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const data = await req.file();
    if (!data) throw badRequest("Missing CSV file");
    const chunks: Buffer[] = [];
    for await (const chunk of data.file) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    let records: Record<string, string>[];
    try {
      records = parseCsv(text, { columns: true, skip_empty_lines: true, trim: true, bom: true }) as Record<string, string>[];
    } catch (err) {
      throw badRequest("Could not read this CSV: " + (err instanceof Error ? err.message : "invalid file"));
    }
    if (!records.length) throw badRequest("The CSV has no data rows");
    if (records.length > 2000) throw badRequest("Import up to 2000 payment rows at a time");
    let imported = 0;
    const errors: { row: number; error: string }[] = [];
    await req.db.query("BEGIN");
    try {
      for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const amount = toCents(row.amount ?? row.Amount);
        const externalId = (row.payment_id ?? row.reference ?? row.external_id ?? "").trim();
        if (!amount || !externalId) {
          errors.push({ row: i + 2, error: "Each row needs amount and payment_id (or reference)" });
          continue;
        }
        const invoiceNumber = (row.invoice_number ?? row.invoice ?? "").trim();
        let invoiceId: string | null = null;
        let customerId: string | null = null;
        if (invoiceNumber) {
          const invoice = await req.db.query<{ id: string; customer_id: string | null }>(
            `SELECT id, customer_id FROM invoices WHERE tenant_id = $1 AND external_id = $2`,
            [req.user.tenantId, invoiceNumber],
          );
          invoiceId = invoice.rows[0]?.id ?? null;
          customerId = invoice.rows[0]?.customer_id ?? null;
        }
        if (!customerId && row.customer_email) {
          const customer = await req.db.query<{ id: string }>(
            `SELECT id FROM customers WHERE tenant_id = $1 AND lower(email) = lower($2) LIMIT 1`,
            [req.user.tenantId, row.customer_email.trim()],
          );
          customerId = customer.rows[0]?.id ?? null;
        }
        await req.db.query("SAVEPOINT cash_row");
        try {
          await bookSettledReceipt(req.db, {
            tenantId: req.user.tenantId,
            customerId,
            source: "csv",
            externalId,
            amount,
            currency: (row.currency ?? "usd").slice(0, 3).toLowerCase(),
            invoiceId,
            reference: row.reference ?? externalId,
          });
          await req.db.query("RELEASE SAVEPOINT cash_row");
          imported += 1;
        } catch (err) {
          await req.db.query("ROLLBACK TO SAVEPOINT cash_row");
          errors.push({ row: i + 2, error: err instanceof Error ? err.message : "could not import this row" });
        }
      }
      await req.db.query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'csv_payments_imported', $3::jsonb)`, [
        req.user.tenantId,
        req.user.email,
        JSON.stringify({ imported, failed: errors.length }),
      ]);
      await req.db.query("COMMIT");
    } catch (err) {
      await req.db.query("ROLLBACK");
      throw err;
    }
    return { imported, failed: errors.length, errors: errors.slice(0, 50) };
  });

  app.get("/credit/customers", async (req) => {
    const rows = await req.db.query<{
      id: string; name: string | null; credit_limit: number | null; credit_status: string; credit_hold_reason: string | null;
      risk_score: number; exposure: number; broken: number; disputes: number;
    }>(
      `SELECT c.id, c.name, c.credit_limit, c.credit_status, c.credit_hold_reason, c.risk_score,
              COALESCE(SUM(i.amount_due) FILTER (WHERE i.status IN ('open','paused')), 0)::bigint AS exposure,
              (SELECT count(*) FROM promises p WHERE p.customer_id = c.id AND p.status = 'broken')::int AS broken,
              (SELECT count(*) FROM disputes d WHERE d.customer_id = c.id AND d.status IN ('open','investigating','pending_customer'))::int AS disputes
         FROM customers c LEFT JOIN invoices i ON i.customer_id = c.id AND i.tenant_id = c.tenant_id
        WHERE c.tenant_id = $1
        GROUP BY c.id ORDER BY c.risk_score DESC LIMIT 200`,
      [req.user.tenantId],
    );
    return {
      customers: rows.rows.map((r) => {
        const standing = creditStanding({
          limitCents: r.credit_limit == null ? null : Number(r.credit_limit),
          exposureCents: Number(r.exposure),
          risk: r.risk_score,
          brokenPromises: r.broken,
          openDisputes: r.disputes,
        });
        return {
          id: r.id,
          name: r.name,
          creditLimit: r.credit_limit == null ? null : Number(r.credit_limit),
          creditStatus: r.credit_status,
          holdReason: r.credit_hold_reason,
          riskScore: r.risk_score,
          exposure: Number(r.exposure),
          recommended: standing.status,
          reason: standing.reason,
        };
      }),
    };
  });

  app.patch("/credit/customers/:id", { preHandler: manager }, async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "Customer");
    const body = z
      .object({
        creditLimit: z.number().int().nonnegative().nullable().optional(),
        creditStatus: z.enum(["ok", "review", "hold"]).optional(),
        holdReason: z.string().trim().max(500).nullable().optional(),
      })
      .parse(req.body ?? {});
    const sets = ["id"];
    const values: unknown[] = [id, req.user.tenantId];
    const add = (col: string, value: unknown) => {
      values.push(value);
      sets.push(`${col} = $${values.length}`);
    };
    if (body.creditLimit !== undefined) add("credit_limit", body.creditLimit);
    if (body.creditStatus) add("credit_status", body.creditStatus);
    if (body.holdReason !== undefined) add("credit_hold_reason", body.holdReason);
    if (sets.length === 1) throw badRequest("Nothing to update");
    const updated = await req.db.query(
      `UPDATE customers SET ${sets.slice(1).join(", ")} WHERE id = $1 AND tenant_id = $2 RETURNING id, credit_status`,
      values,
    );
    if (!updated.rows[0]) throw badRequest("Customer not found");
    await req.db.query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'credit_updated', $3::jsonb)`, [
      req.user.tenantId,
      req.user.email,
      JSON.stringify({ customer_id: id, ...body }),
    ]);
    if (body.creditStatus === "hold" || body.creditStatus === "review") {
      await req.db.query(
        `INSERT INTO credit_reviews (tenant_id, customer_id, status, notes) VALUES ($1, $2, 'open', $3)`,
        [req.user.tenantId, id, body.holdReason ?? body.creditStatus],
      );
      await req.db.query(
        `INSERT INTO notifications (tenant_id, kind, title, body, href)
         SELECT $1, 'credit', $2, $3, $4`,
        [req.user.tenantId, "Credit review opened", body.holdReason ?? "An account needs a credit decision", `/credit`],
      );
    }
    return { customer: updated.rows[0] };
  });

  app.get("/credit/reviews", async (req) => {
    const rows = await req.db.query(
      `SELECT r.id, r.customer_id, c.name AS customer_name, r.status, r.notes, r.created_at
         FROM credit_reviews r JOIN customers c ON c.id = r.customer_id
        WHERE r.tenant_id = $1 ORDER BY r.created_at DESC LIMIT 100`,
      [req.user.tenantId],
    );
    return { reviews: rows.rows };
  });

  app.post("/credit/reviews/:id", { preHandler: manager }, async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "Review");
    const body = z.object({ status: z.enum(["approved", "held", "rejected"]), notes: z.string().max(2000).optional() }).parse(req.body ?? {});
    const review = await req.db.query<{ customer_id: string }>(
      `UPDATE credit_reviews SET status = $3, notes = COALESCE($4, notes), reviewer_user_id = $5, decided_at = now()
        WHERE id = $1 AND tenant_id = $2 RETURNING customer_id`,
      [id, req.user.tenantId, body.status, body.notes ?? null, req.user.userId],
    );
    if (!review.rows[0]) throw badRequest("Review not found");
    const next = body.status === "approved" ? "ok" : "hold";
    await req.db.query(`UPDATE customers SET credit_status = $3, credit_hold_reason = $4 WHERE id = $1 AND tenant_id = $2`, [
      review.rows[0].customer_id,
      req.user.tenantId,
      next,
      body.status === "approved" ? null : body.notes ?? body.status,
    ]);
    await req.db.query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'credit_review_decided', $3::jsonb)`, [
      req.user.tenantId,
      req.user.email,
      JSON.stringify({ review_id: id, status: body.status }),
    ]);
    return { ok: true };
  });

  app.get("/forecast", async (req) => {
    const grain = z.object({ grain: z.enum(["week", "month"]).default("week") }).parse(req.query ?? {}).grain;
    const rows = await req.db.query<{ amount_due: number; due_date: string | null; promise_date: string | null }>(
      `SELECT i.amount_due, i.due_date::text AS due_date,
              (SELECT min(p.promise_date)::text FROM promises p WHERE p.invoice_id = i.id AND p.status = 'open') AS promise_date
         FROM invoices i WHERE i.tenant_id = $1 AND i.status IN ('open', 'paused') AND i.amount_due > 0`,
      [req.user.tenantId],
    );
    const history = await req.db.query<{ kept: number; broken: number }>(
      `SELECT count(*) FILTER (WHERE status = 'kept')::int AS kept,
              count(*) FILTER (WHERE status = 'broken')::int AS broken
         FROM promises WHERE tenant_id = $1`,
      [req.user.tenantId],
    );
    const kept = history.rows[0]?.kept ?? 0;
    const broken = history.rows[0]?.broken ?? 0;
    const keepRate = kept + broken === 0 ? 0.85 : kept / (kept + broken);
    return {
      grain,
      keepRate,
      buckets: forecastCollections(
        rows.rows.map((r) => ({ amountDue: Number(r.amount_due), dueDate: r.due_date, promiseDate: r.promise_date })),
        grain,
        keepRate,
      ),
    };
  });

  app.get("/analytics/process", async (req) => sequential(req));

  app.get("/search", async (req) => {
    const q = z.object({ q: z.string().trim().min(1).max(80) }).parse(req.query ?? {}).q;
    const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const customers = await req.db.query(
      `SELECT id, name, email FROM customers WHERE tenant_id = $1 AND (name ILIKE $2 ESCAPE '\\' OR email ILIKE $2 ESCAPE '\\') LIMIT 8`,
      [req.user.tenantId, like],
    );
    const invoices = await req.db.query(
      `SELECT id, external_id, amount_due, status FROM invoices WHERE tenant_id = $1 AND external_id ILIKE $2 ESCAPE '\\' LIMIT 8`,
      [req.user.tenantId, like],
    );
    return { customers: customers.rows, invoices: invoices.rows.map(money) };
  });

  app.get("/filters", async (req) => {
    const rows = await req.db.query(
      `SELECT id, name, scope, query, created_at FROM saved_filters WHERE tenant_id = $1 AND user_id = $2 ORDER BY name`,
      [req.user.tenantId, req.user.userId],
    );
    return { filters: rows.rows };
  });

  app.post("/filters", { preHandler: writer }, async (req, reply) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(80),
        scope: z.enum(["invoices", "worklist", "cash", "disputes"]),
        query: z.record(z.string(), z.unknown()).default({}),
      })
      .parse(req.body ?? {});
    const row = await req.db.query(
      `INSERT INTO saved_filters (tenant_id, user_id, name, scope, query) VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (tenant_id, user_id, scope, name) DO UPDATE SET query = EXCLUDED.query
       RETURNING id, name, scope`,
      [req.user.tenantId, req.user.userId, body.name, body.scope, JSON.stringify(body.query)],
    );
    return reply.status(201).send({ filter: row.rows[0] });
  });

  app.get("/notifications", async (req) => {
    const rows = await req.db.query(
      `SELECT id, kind, title, body, href, read_at, created_at FROM notifications
        WHERE tenant_id = $1 AND (user_id IS NULL OR user_id = $2)
        ORDER BY created_at DESC LIMIT 30`,
      [req.user.tenantId, req.user.userId],
    );
    return { notifications: rows.rows };
  });

  app.post("/notifications/:id/read", { preHandler: writer }, async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "Notification");
    await req.db.query(`UPDATE notifications SET read_at = now() WHERE id = $1 AND tenant_id = $2`, [id, req.user.tenantId]);
    return { ok: true };
  });

  app.post("/invoices/bulk", { preHandler: writer }, async (req) => {
    const body = z
      .object({ ids: z.array(z.string().uuid()).min(1).max(100), action: z.enum(["pause", "resume"]) })
      .parse(req.body ?? {});
    const next = body.action === "pause" ? "paused" : "open";
    const from = body.action === "pause" ? "open" : "paused";
    const updated = await req.db.query(
      `UPDATE invoices SET status = $3, updated_at = now()
        WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND status = $4`,
      [req.user.tenantId, body.ids, next, from],
    );
    await req.db.query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'invoices_bulk', $3::jsonb)`, [
      req.user.tenantId,
      req.user.email,
      JSON.stringify({ action: body.action, count: updated.rowCount ?? 0 }),
    ]);
    return { ok: true, updated: updated.rowCount ?? 0 };
  });

  app.get("/exports/invoices", async (req, reply) => {
    const format = z.object({ format: z.enum(["csv", "xls"]).default("csv") }).parse(req.query ?? {}).format;
    const rows = await req.db.query(
      `SELECT i.external_id, c.name AS customer, i.amount_due, i.currency, i.status, i.due_date::text AS due_date, i.source
         FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
        WHERE i.tenant_id = $1 ORDER BY i.due_date NULLS LAST LIMIT 5000`,
      [req.user.tenantId],
    );
    await req.db.query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'export_invoices', $3::jsonb)`, [
      req.user.tenantId,
      req.user.email,
      JSON.stringify({ format, rows: rows.rows.length }),
    ]);
    return sendTable(reply, "invoices", format, rows.rows as Record<string, unknown>[]);
  });
}

async function sequential(req: { db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }; user: { tenantId: string } }) {
  const tenantId = req.user.tenantId;
  const aging = await req.db.query(
    `SELECT CASE WHEN due_date >= CURRENT_DATE OR due_date IS NULL THEN 'current'
                 WHEN CURRENT_DATE - due_date <= 30 THEN '1-30'
                 WHEN CURRENT_DATE - due_date <= 60 THEN '31-60'
                 WHEN CURRENT_DATE - due_date <= 90 THEN '61-90' ELSE '90+' END AS bucket,
            count(*)::int AS count, COALESCE(SUM(amount_due),0)::bigint AS amount
       FROM invoices WHERE tenant_id = $1 AND status IN ('open','paused') GROUP BY 1 ORDER BY 1`,
    [tenantId],
  );
  const collectors = await req.db.query(
    `SELECT u.email, count(DISTINCT c.id)::int AS accounts,
            COALESCE(SUM(i.amount_due) FILTER (WHERE i.status = 'paid' AND i.updated_at > now() - interval '30 days'), 0)::bigint AS collected
       FROM customers c
       LEFT JOIN users u ON u.id = c.collector_user_id
       LEFT JOIN invoices i ON i.customer_id = c.id
      WHERE c.tenant_id = $1
      GROUP BY u.email ORDER BY collected DESC LIMIT 20`,
    [tenantId],
  );
  const steps = await req.db.query(
    `SELECT channel, step_index, count(*) FILTER (WHERE status IN ('sent','delivered','opened','clicked'))::int AS sent,
            count(*) FILTER (WHERE status IN ('opened','clicked'))::int AS engaged
       FROM messages WHERE tenant_id = $1 AND sent_at > now() - interval '90 days'
      GROUP BY channel, step_index ORDER BY step_index, channel`,
    [tenantId],
  );
  const bottlenecks = await req.db.query(
    `SELECT 'open_disputes' AS kind, count(*)::int AS count FROM disputes WHERE tenant_id = $1 AND status IN ('open','investigating','pending_customer')
     UNION ALL SELECT 'broken_promises', count(*)::int FROM promises WHERE tenant_id = $1 AND status = 'broken'
     UNION ALL SELECT 'unapplied_cash', count(*)::int FROM payments WHERE tenant_id = $1 AND unapplied > 0
     UNION ALL SELECT 'credit_holds', count(*)::int FROM customers WHERE tenant_id = $1 AND credit_status = 'hold'`,
    [tenantId],
  );
  return {
    funnel: aging.rows.map(money),
    collectors: collectors.rows.map(money),
    steps: steps.rows,
    bottlenecks: bottlenecks.rows,
  };
}

function money(row: Record<string, unknown>): Record<string, unknown> {
  const next = { ...row };
  for (const key of ["amount", "amount_due", "unapplied", "exposure", "collected"]) {
    if (next[key] != null) next[key] = Number(next[key]);
  }
  return next;
}
