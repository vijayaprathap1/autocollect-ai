import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../../plugins/tenant.js";
import { assertUuid, badRequest, notFound } from "../../lib/errors.js";
import { riskScore } from "../../lib/risk.js";
import { DISPUTE_REASONS } from "../../lib/dispute-reason.js";

const segmentSchema = z.enum(["strategic", "standard", "high_risk", "smb"]).nullable();
const disputeStatus = z.enum(["open", "investigating", "pending_customer", "resolved", "rejected"]);
const promiseStatus = z.enum(["open", "kept", "broken", "cancelled"]);
const taskStatus = z.enum(["open", "done", "cancelled"]);

function mapCustomer(r: {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  segment: string | null;
  risk_score: number;
  collector_user_id: string | null;
  source: string;
  sms_opt_out: boolean;
}) {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    company: r.company,
    segment: r.segment,
    riskScore: r.risk_score,
    collectorUserId: r.collector_user_id,
    source: r.source,
    smsOptOut: r.sms_opt_out,
  };
}

export async function collectionRoutes(app: FastifyInstance) {
  app.get("/worklist", async (req) => {
    const rows = await req.db.query<{
      id: string;
      name: string | null;
      email: string | null;
      company: string | null;
      segment: string | null;
      risk_score: number;
      collector_user_id: string | null;
      open_total: number;
      open_count: number;
      days_overdue: number;
      open_disputes: number;
      broken_promises: number;
      open_tasks: number;
      next_task_on: string | null;
    }>(
      `SELECT c.id, c.name, c.email, c.company, c.segment, c.risk_score, c.collector_user_id,
              COALESCE(SUM(i.amount_due) FILTER (WHERE i.status = 'open'), 0)::bigint AS open_total,
              COUNT(i.id) FILTER (WHERE i.status = 'open')::int AS open_count,
              COALESCE(MAX(CURRENT_DATE - i.due_date) FILTER (WHERE i.status = 'open' AND i.due_date < CURRENT_DATE), 0)::int AS days_overdue,
              (SELECT count(*) FROM disputes d WHERE d.customer_id = c.id AND d.tenant_id = c.tenant_id
                 AND d.status IN ('open', 'investigating', 'pending_customer'))::int AS open_disputes,
              (SELECT count(*) FROM promises p WHERE p.customer_id = c.id AND p.tenant_id = c.tenant_id AND p.status = 'broken')::int AS broken_promises,
              (SELECT count(*) FROM tasks t WHERE t.customer_id = c.id AND t.tenant_id = c.tenant_id AND t.status = 'open')::int AS open_tasks,
              (SELECT min(due_on)::text FROM tasks t WHERE t.customer_id = c.id AND t.tenant_id = c.tenant_id AND t.status = 'open') AS next_task_on
         FROM customers c
         LEFT JOIN invoices i ON i.customer_id = c.id AND i.tenant_id = c.tenant_id
        WHERE c.tenant_id = $1
        GROUP BY c.id
       HAVING COUNT(i.id) FILTER (WHERE i.status IN ('open', 'paused')) > 0
           OR (SELECT count(*) FROM tasks t WHERE t.customer_id = c.id AND t.status = 'open') > 0
           OR (SELECT count(*) FROM disputes d WHERE d.customer_id = c.id AND d.status IN ('open', 'investigating', 'pending_customer')) > 0
        ORDER BY c.risk_score DESC, open_total DESC, c.name
        LIMIT 200`,
      [req.user.tenantId],
    );
    const items = rows.rows.map((r) => {
      const score = riskScore({
        daysOverdue: r.days_overdue,
        openCents: Number(r.open_total),
        brokenPromises: r.broken_promises,
        openDisputes: r.open_disputes,
      });
      return {
        id: r.id,
        name: r.name,
        email: r.email,
        company: r.company,
        segment: r.segment,
        riskScore: score,
        collectorUserId: r.collector_user_id,
        openTotal: Number(r.open_total),
        openCount: r.open_count,
        daysOverdue: r.days_overdue,
        openDisputes: r.open_disputes,
        brokenPromises: r.broken_promises,
        openTasks: r.open_tasks,
        nextTaskOn: r.next_task_on,
      };
    });
    items.sort((a, b) => b.riskScore - a.riskScore || b.openTotal - a.openTotal);
    return { worklist: items };
  });

  app.get("/customers/:id", async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "Customer");
    const tenantId = req.user.tenantId;
    const customer = await req.db.query(
      `SELECT id, name, email, phone, company, segment, risk_score, collector_user_id, source, sms_opt_out
         FROM customers WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (!customer.rows[0]) throw notFound("Customer not found");
    // One connection per request: these cannot run with Promise.all.
    const contacts = await req.db.query(
      `SELECT id, name, email, phone, role, is_primary FROM customer_contacts
        WHERE customer_id = $1 AND tenant_id = $2 ORDER BY is_primary DESC, created_at`,
      [id, tenantId],
    );
    const invoices = await req.db.query(
      `SELECT id, external_id, amount_due, currency, status, issue_date::text AS issue_date, due_date::text AS due_date,
              payment_link, payment_link_status, source
         FROM invoices WHERE customer_id = $1 AND tenant_id = $2
        ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, due_date NULLS LAST`,
      [id, tenantId],
    );
    const messages = await req.db.query(
      `SELECT m.id, m.channel, m.status, m.sent_at, m.step_index, i.external_id
         FROM messages m JOIN invoices i ON i.id = m.invoice_id
        WHERE i.customer_id = $1 AND m.tenant_id = $2
        ORDER BY m.created_at DESC LIMIT 50`,
      [id, tenantId],
    );
    const replies = await req.db.query(
      `SELECT r.id, r.classification, r.content, r.promise_date::text AS promise_date, r.created_at, i.external_id
         FROM replies r JOIN invoices i ON i.id = r.invoice_id
        WHERE i.customer_id = $1 AND r.tenant_id = $2
        ORDER BY r.created_at DESC LIMIT 50`,
      [id, tenantId],
    );
    const disputes = await req.db.query(
      `SELECT id, invoice_id, reason_code, status, summary, resolution, opened_at, resolved_at
         FROM disputes WHERE customer_id = $1 AND tenant_id = $2 ORDER BY opened_at DESC`,
      [id, tenantId],
    );
    const promises = await req.db.query(
      `SELECT id, invoice_id, amount, currency, promise_date::text AS promise_date, status, kept_at, broken_at
         FROM promises WHERE customer_id = $1 AND tenant_id = $2 ORDER BY promise_date DESC`,
      [id, tenantId],
    );
    const tasks = await req.db.query(
      `SELECT id, title, notes, due_on::text AS due_on, status, priority, source, owner_user_id, invoice_id, dispute_id, promise_id
         FROM tasks WHERE customer_id = $1 AND tenant_id = $2 ORDER BY status = 'open' DESC, due_on NULLS LAST`,
      [id, tenantId],
    );
    const paid = invoices.rows.filter((i: { status: string }) => i.status === "paid");
    return {
      customer: mapCustomer(customer.rows[0]),
      contacts: contacts.rows,
      invoices: invoices.rows.map(moneyInvoice),
      communications: messages.rows,
      replies: replies.rows,
      disputes: disputes.rows,
      promises: promises.rows.map(moneyPromise),
      tasks: tasks.rows,
      payments: paid.map(moneyInvoice),
    };
  });

  app.patch("/customers/:id", { preHandler: requireRole("admin") }, async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "Customer");
    const body = z
      .object({
        segment: segmentSchema.optional(),
        collectorUserId: z.string().uuid().nullable().optional(),
      })
      .parse(req.body ?? {});
    if (body.collectorUserId) {
      const member = await req.db.query(`SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`, [
        req.user.tenantId,
        body.collectorUserId,
      ]);
      if (!member.rows.length) throw badRequest("That person is not a member of this workspace", "UNKNOWN_COLLECTOR");
    }
    const sets: string[] = [];
    const values: unknown[] = [id, req.user.tenantId];
    if (body.segment !== undefined) {
      values.push(body.segment);
      sets.push(`segment = $${values.length}`);
    }
    if (body.collectorUserId !== undefined) {
      values.push(body.collectorUserId);
      sets.push(`collector_user_id = $${values.length}`);
    }
    if (!sets.length) throw badRequest("Nothing to update");
    const updated = await req.db.query(
      `UPDATE customers SET ${sets.join(", ")} WHERE id = $1 AND tenant_id = $2
       RETURNING id, name, email, phone, company, segment, risk_score, collector_user_id, source, sms_opt_out`,
      values,
    );
    if (!updated.rows[0]) throw notFound("Customer not found");
    return { customer: mapCustomer(updated.rows[0]) };
  });

  app.post("/customers/:id/contacts", { preHandler: requireRole("admin") }, async (req, reply) => {
    const id = assertUuid((req.params as { id: string }).id, "Customer");
    const body = z
      .object({
        name: z.string().trim().max(120).optional(),
        email: z.string().trim().email().max(254).optional(),
        phone: z.string().trim().max(40).optional(),
        role: z.enum(["ap", "buyer", "other"]).default("ap"),
        isPrimary: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    if (!body.email && !body.phone) throw badRequest("A contact needs an email or a phone number");
    const owns = await req.db.query(`SELECT 1 FROM customers WHERE id = $1 AND tenant_id = $2`, [id, req.user.tenantId]);
    if (!owns.rows.length) throw notFound("Customer not found");
    if (body.isPrimary) {
      await req.db.query(`UPDATE customer_contacts SET is_primary = FALSE WHERE customer_id = $1 AND tenant_id = $2`, [id, req.user.tenantId]);
    }
    const row = await req.db.query(
      `INSERT INTO customer_contacts (tenant_id, customer_id, name, email, phone, role, is_primary)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, email, phone, role, is_primary`,
      [req.user.tenantId, id, body.name ?? null, body.email ?? null, body.phone ?? null, body.role, Boolean(body.isPrimary)],
    );
    return reply.status(201).send({ contact: row.rows[0] });
  });

  app.delete("/customers/:id/contacts/:contactId", { preHandler: requireRole("admin") }, async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "Customer");
    const contactId = assertUuid((req.params as { contactId: string }).contactId, "Contact");
    const res = await req.db.query(`DELETE FROM customer_contacts WHERE id = $1 AND customer_id = $2 AND tenant_id = $3`, [
      contactId,
      id,
      req.user.tenantId,
    ]);
    if (!res.rowCount) throw notFound("Contact not found");
    return { ok: true };
  });

  app.post("/customers/:id/strategy", { preHandler: requireRole("admin") }, async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "Customer");
    const { workflowId } = z.object({ workflowId: z.string().uuid().nullable() }).parse(req.body ?? {});
    const customer = await req.db.query(`SELECT 1 FROM customers WHERE id = $1 AND tenant_id = $2`, [id, req.user.tenantId]);
    if (!customer.rows.length) throw notFound("Customer not found");
    if (workflowId) {
      const wf = await req.db.query(`SELECT id FROM workflows WHERE id = $1 AND tenant_id = $2`, [workflowId, req.user.tenantId]);
      if (!wf.rows.length) throw notFound("Workflow not found");
      await req.db.query(
        `UPDATE invoices SET workflow_id = $3, strategy_locked = TRUE, next_step_due_at = NULL, updated_at = now()
          WHERE tenant_id = $1 AND customer_id = $2 AND status = 'open'`,
        [req.user.tenantId, id, workflowId],
      );
    } else {
      await req.db.query(
        `UPDATE invoices SET workflow_id = (SELECT id FROM workflows WHERE tenant_id = $1 AND is_default ORDER BY created_at LIMIT 1),
                strategy_locked = FALSE, next_step_due_at = NULL, updated_at = now()
          WHERE tenant_id = $1 AND customer_id = $2 AND status = 'open'`,
        [req.user.tenantId, id],
      );
    }
    return { ok: true };
  });

  app.get("/disputes", async (req) => {
    const status = z.object({ status: disputeStatus.optional() }).parse(req.query ?? {}).status ?? null;
    const rows = await req.db.query(
      `SELECT d.id, d.invoice_id, d.customer_id, d.reason_code, d.status, d.summary, d.owner_user_id,
              d.opened_at, d.resolved_at, c.name AS customer_name, i.external_id, i.amount_due, i.currency
         FROM disputes d
         LEFT JOIN customers c ON c.id = d.customer_id
         LEFT JOIN invoices i ON i.id = d.invoice_id
        WHERE d.tenant_id = $1 AND ($2::text IS NULL OR d.status = $2)
        ORDER BY d.status IN ('open', 'investigating', 'pending_customer') DESC, d.opened_at DESC
        LIMIT 200`,
      [req.user.tenantId, status],
    );
    return { disputes: rows.rows.map(moneyDispute) };
  });

  app.post("/disputes", { preHandler: requireRole("admin") }, async (req, reply) => {
    const body = z
      .object({
        invoiceId: z.string().uuid(),
        reasonCode: z.enum(DISPUTE_REASONS).default("other"),
        summary: z.string().trim().max(2000).optional(),
        ownerUserId: z.string().uuid().nullable().optional(),
      })
      .parse(req.body ?? {});
    const inv = await req.db.query<{ customer_id: string | null; status: string }>(
      `SELECT customer_id, status FROM invoices WHERE id = $1 AND tenant_id = $2`,
      [body.invoiceId, req.user.tenantId],
    );
    if (!inv.rows[0]) throw notFound("Invoice not found");
    const row = await req.db.query(
      `INSERT INTO disputes (tenant_id, customer_id, invoice_id, reason_code, summary, owner_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, invoice_id, customer_id, reason_code, status, summary, owner_user_id, opened_at`,
      [req.user.tenantId, inv.rows[0].customer_id, body.invoiceId, body.reasonCode, body.summary ?? null, body.ownerUserId ?? null],
    );
    if (inv.rows[0].status === "open") {
      await req.db.query(`UPDATE invoices SET status = 'paused', updated_at = now() WHERE id = $1 AND tenant_id = $2`, [
        body.invoiceId,
        req.user.tenantId,
      ]);
    }
    return reply.status(201).send({ dispute: row.rows[0] });
  });

  app.get("/disputes/:id", async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "Dispute");
    const row = await req.db.query(
      `SELECT d.*, c.name AS customer_name, i.external_id, i.amount_due, i.currency
         FROM disputes d
         LEFT JOIN customers c ON c.id = d.customer_id
         LEFT JOIN invoices i ON i.id = d.invoice_id
        WHERE d.id = $1 AND d.tenant_id = $2`,
      [id, req.user.tenantId],
    );
    if (!row.rows[0]) throw notFound("Dispute not found");
    const notes = await req.db.query(
      `SELECT n.id, n.body, n.created_at, u.display_name, u.email
         FROM dispute_notes n LEFT JOIN users u ON u.id = n.author_user_id
        WHERE n.dispute_id = $1 AND n.tenant_id = $2 ORDER BY n.created_at`,
      [id, req.user.tenantId],
    );
    return { dispute: moneyDispute(row.rows[0]), notes: notes.rows };
  });

  app.patch("/disputes/:id", { preHandler: requireRole("admin") }, async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "Dispute");
    const body = z
      .object({
        status: disputeStatus.optional(),
        reasonCode: z.enum(DISPUTE_REASONS).optional(),
        ownerUserId: z.string().uuid().nullable().optional(),
        summary: z.string().trim().max(2000).nullable().optional(),
        resolution: z.string().trim().max(2000).nullable().optional(),
      })
      .parse(req.body ?? {});
    const sets: string[] = ["updated_at = now()"];
    const values: unknown[] = [id, req.user.tenantId];
    const add = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (body.status) {
      add("status", body.status);
      if (body.status === "resolved" || body.status === "rejected") sets.push(`resolved_at = COALESCE(resolved_at, now())`);
    }
    if (body.reasonCode) add("reason_code", body.reasonCode);
    if (body.ownerUserId !== undefined) add("owner_user_id", body.ownerUserId);
    if (body.summary !== undefined) add("summary", body.summary);
    if (body.resolution !== undefined) add("resolution", body.resolution);
    const updated = await req.db.query(`UPDATE disputes SET ${sets.join(", ")} WHERE id = $1 AND tenant_id = $2 RETURNING id, status, resolved_at`, values);
    if (!updated.rows[0]) throw notFound("Dispute not found");
    if (body.status === "resolved" || body.status === "rejected") {
      await req.db.query(
        `UPDATE invoices SET status = 'open', updated_at = now()
          WHERE id = (SELECT invoice_id FROM disputes WHERE id = $1) AND tenant_id = $2 AND status = 'paused'`,
        [id, req.user.tenantId],
      );
    }
    return { dispute: updated.rows[0] };
  });

  app.post("/disputes/:id/notes", { preHandler: requireRole("member") }, async (req, reply) => {
    const id = assertUuid((req.params as { id: string }).id, "Dispute");
    const { body } = z.object({ body: z.string().trim().min(1).max(4000) }).parse(req.body ?? {});
    const owns = await req.db.query(`SELECT 1 FROM disputes WHERE id = $1 AND tenant_id = $2`, [id, req.user.tenantId]);
    if (!owns.rows.length) throw notFound("Dispute not found");
    const note = await req.db.query(
      `INSERT INTO dispute_notes (tenant_id, dispute_id, author_user_id, body) VALUES ($1, $2, $3, $4) RETURNING id, body, created_at`,
      [req.user.tenantId, id, req.user.userId, body],
    );
    return reply.status(201).send({ note: note.rows[0] });
  });

  app.get("/promises", async (req) => {
    const status = z.object({ status: promiseStatus.optional() }).parse(req.query ?? {}).status ?? null;
    const rows = await req.db.query(
      `SELECT p.id, p.invoice_id, p.customer_id, p.amount, p.currency, p.promise_date::text AS promise_date,
              p.status, p.kept_at, p.broken_at, p.owner_user_id, c.name AS customer_name, i.external_id
         FROM promises p
         LEFT JOIN customers c ON c.id = p.customer_id
         LEFT JOIN invoices i ON i.id = p.invoice_id
        WHERE p.tenant_id = $1 AND ($2::text IS NULL OR p.status = $2)
        ORDER BY p.status = 'open' DESC, p.promise_date
        LIMIT 200`,
      [req.user.tenantId, status],
    );
    return { promises: rows.rows.map(moneyPromise) };
  });

  app.post("/promises", { preHandler: requireRole("admin") }, async (req, reply) => {
    const body = z
      .object({
        invoiceId: z.string().uuid(),
        amount: z.number().int().positive().optional(),
        promiseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        ownerUserId: z.string().uuid().nullable().optional(),
      })
      .parse(req.body ?? {});
    const inv = await req.db.query<{ customer_id: string | null; amount_due: number; currency: string; status: string }>(
      `SELECT customer_id, amount_due, currency, status FROM invoices WHERE id = $1 AND tenant_id = $2`,
      [body.invoiceId, req.user.tenantId],
    );
    if (!inv.rows[0]) throw notFound("Invoice not found");
    const row = await req.db.query(
      `INSERT INTO promises (tenant_id, customer_id, invoice_id, amount, currency, promise_date, owner_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, amount, currency, promise_date::text AS promise_date, status`,
      [
        req.user.tenantId,
        inv.rows[0].customer_id,
        body.invoiceId,
        body.amount ?? Number(inv.rows[0].amount_due),
        inv.rows[0].currency,
        body.promiseDate,
        body.ownerUserId ?? null,
      ],
    );
    if (inv.rows[0].status === "open") {
      await req.db.query(
        `UPDATE invoices SET snoozed_until = ($2::date + interval '1 day'), next_step_due_at = ($2::date + interval '1 day'), updated_at = now()
          WHERE id = $1 AND tenant_id = $3 AND status = 'open'`,
        [body.invoiceId, body.promiseDate, req.user.tenantId],
      );
    }
    return reply.status(201).send({ promise: moneyPromise(row.rows[0]) });
  });

  app.patch("/promises/:id", { preHandler: requireRole("admin") }, async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "Promise");
    const body = z
      .object({
        status: promiseStatus.optional(),
        promiseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        ownerUserId: z.string().uuid().nullable().optional(),
      })
      .parse(req.body ?? {});
    const sets = ["updated_at = now()"];
    const values: unknown[] = [id, req.user.tenantId];
    const add = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (body.promiseDate) add("promise_date", body.promiseDate);
    if (body.ownerUserId !== undefined) add("owner_user_id", body.ownerUserId);
    if (body.status) {
      add("status", body.status);
      if (body.status === "kept") sets.push("kept_at = COALESCE(kept_at, now())");
      if (body.status === "broken") sets.push("broken_at = COALESCE(broken_at, now())");
    }
    const updated = await req.db.query(
      `UPDATE promises SET ${sets.join(", ")} WHERE id = $1 AND tenant_id = $2
       RETURNING id, status, promise_date::text AS promise_date, amount, currency`,
      values,
    );
    if (!updated.rows[0]) throw notFound("Promise not found");
    return { promise: moneyPromise(updated.rows[0]) };
  });

  app.get("/tasks", async (req) => {
    const q = z
      .object({ status: taskStatus.optional(), mine: z.enum(["1", "true"]).optional() })
      .parse(req.query ?? {});
    const rows = await req.db.query(
      `SELECT t.id, t.title, t.notes, t.due_on::text AS due_on, t.status, t.priority, t.source,
              t.owner_user_id, t.customer_id, t.invoice_id, t.dispute_id, t.promise_id,
              c.name AS customer_name
         FROM tasks t LEFT JOIN customers c ON c.id = t.customer_id
        WHERE t.tenant_id = $1
          AND ($2::text IS NULL OR t.status = $2)
          AND ($3::uuid IS NULL OR t.owner_user_id = $3)
        ORDER BY t.status = 'open' DESC, t.due_on NULLS LAST, t.priority DESC
        LIMIT 200`,
      [req.user.tenantId, q.status ?? null, q.mine ? req.user.userId : null],
    );
    return { tasks: rows.rows };
  });

  app.post("/tasks", { preHandler: requireRole("member") }, async (req, reply) => {
    const body = z
      .object({
        title: z.string().trim().min(1).max(200),
        notes: z.string().trim().max(4000).optional(),
        dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        customerId: z.string().uuid().nullable().optional(),
        invoiceId: z.string().uuid().nullable().optional(),
        ownerUserId: z.string().uuid().nullable().optional(),
        priority: z.number().int().min(0).max(100).optional(),
      })
      .parse(req.body ?? {});
    const row = await req.db.query(
      `INSERT INTO tasks (tenant_id, title, notes, due_on, customer_id, invoice_id, owner_user_id, priority, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual')
       RETURNING id, title, due_on::text AS due_on, status, owner_user_id`,
      [
        req.user.tenantId,
        body.title,
        body.notes ?? null,
        body.dueOn ?? null,
        body.customerId ?? null,
        body.invoiceId ?? null,
        body.ownerUserId ?? req.user.userId,
        body.priority ?? 0,
      ],
    );
    return reply.status(201).send({ task: row.rows[0] });
  });

  app.patch("/tasks/:id", async (req) => {
    const id = assertUuid((req.params as { id: string }).id, "Task");
    const body = z
      .object({
        status: taskStatus.optional(),
        title: z.string().trim().min(1).max(200).optional(),
        notes: z.string().trim().max(4000).nullable().optional(),
        dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        ownerUserId: z.string().uuid().nullable().optional(),
      })
      .parse(req.body ?? {});
    const sets = ["updated_at = now()"];
    const values: unknown[] = [id, req.user.tenantId];
    const add = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (body.status) add("status", body.status);
    if (body.title) add("title", body.title);
    if (body.notes !== undefined) add("notes", body.notes);
    if (body.dueOn !== undefined) add("due_on", body.dueOn);
    if (body.ownerUserId !== undefined) add("owner_user_id", body.ownerUserId);
    const updated = await req.db.query(`UPDATE tasks SET ${sets.join(", ")} WHERE id = $1 AND tenant_id = $2 RETURNING id, status, title`, values);
    if (!updated.rows[0]) throw notFound("Task not found");
    return { task: updated.rows[0] };
  });
}

function moneyInvoice(row: { amount_due?: number; amountDue?: number } & Record<string, unknown>) {
  return { ...row, amount_due: row.amount_due != null ? Number(row.amount_due) : row.amount_due };
}

function moneyPromise(row: { amount?: number } & Record<string, unknown>) {
  return { ...row, amount: row.amount != null ? Number(row.amount) : row.amount };
}

function moneyDispute(row: { amount_due?: number } & Record<string, unknown>) {
  return { ...row, amount_due: row.amount_due != null ? Number(row.amount_due) : row.amount_due };
}
