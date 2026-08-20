import type { FastifyInstance } from "fastify";
import { parse as parseCsv } from "csv-parse/sync";
import { requireRole } from "../../plugins/tenant.js";
import { badRequest } from "../../lib/errors.js";
import { withTenant } from "../../lib/db.js";
import { assertInvoiceCapacity } from "../../lib/billing.js";

type CsvRow = Record<string, string>;

const HEADER_ALIASES: Record<string, string[]> = {
  name: ["client_name", "name", "customer", "customer_name", "client"],
  email: ["client_email", "email", "customer_email"],
  phone: ["client_phone", "phone", "customer_phone", "mobile", "tel"],
  amount: ["amount", "amount_due", "total", "amountdue", "amt"],
  dueDate: ["due_date", "due", "duedate", "payment_due"],
  issueDate: ["issue_date", "issued", "date", "created", "created_at"],
  invoiceNumber: ["invoice_number", "number", "id", "invoice", "external_id", "invoice_no"],
  currency: ["currency", "ccy"],
  payLink: ["pay_link", "payment_link", "url", "link", "hosted_invoice_url"],
};

function mapHeaders(headers: string[]): Record<string, string> {
  const norm = headers.map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, "_"));
  const mapping: Record<string, string> = {};
  for (const field of Object.keys(HEADER_ALIASES)) {
    for (const alias of HEADER_ALIASES[field]) {
      const idx = norm.indexOf(alias);
      if (idx !== -1) {
        mapping[field] = headers[idx];
        break;
      }
    }
  }
  return mapping;
}

function toCents(value: string | undefined): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[^0-9.\-]/g, "");
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100);
}

function parseDate(value: string | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

async function importOneRow(
  client: import("pg").PoolClient,
  r: CsvRow,
  mapping: Record<string, string>,
  tenantId: string,
  workflowId: string | null,
  imported: string[],
  errors: { row: number; error: string }[],
  index: number,
): Promise<void> {
  const get = (field: string) => r[mapping[field]]?.trim();

  const invoiceNumber = get("invoiceNumber");
  const amountCents = toCents(get("amount"));
  if (!invoiceNumber) {
    errors.push({ row: index + 2, error: "missing invoice number" });
    return;
  }
  if (amountCents === null || amountCents <= 0) {
    errors.push({ row: index + 2, error: "invalid amount" });
    return;
  }

  const name = get("name");
  const email = get("email");
  if (!name && !email) {
    errors.push({ row: index + 2, error: "missing client name/email" });
    return;
  }

  // Enforce plan capacity per new row; a limit hit records an error for this
  // row without aborting the rest of the file (partial import).
  await assertInvoiceCapacity(client, tenantId, "csv", invoiceNumber);

  let customerId: string | null = null;
  if (name || email) {
    const cu = await client.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, source, external_id, name, email, phone)
       VALUES ($1, 'csv', $2, $3, $4, $5)
       ON CONFLICT (tenant_id, source, external_id)
       DO UPDATE SET name = COALESCE(EXCLUDED.name, customers.name),
                     email = COALESCE(EXCLUDED.email, customers.email),
                     phone = COALESCE(EXCLUDED.phone, customers.phone)
       RETURNING id`,
      [tenantId, invoiceNumber, name ?? null, email ?? null, get("phone") ?? null],
    );
    customerId = cu.rows[0].id;
  }

  await client.query(
    `INSERT INTO invoices (tenant_id, customer_id, external_id, source,
                           amount_due, currency, issue_date, due_date, status,
                           payment_link, workflow_id)
     VALUES ($1, $2, $3, 'csv', $4, $5, $6, $7, 'open', $8, $9)
     ON CONFLICT (tenant_id, source, external_id)
     DO UPDATE SET amount_due = EXCLUDED.amount_due,
                   currency = EXCLUDED.currency,
                   issue_date = EXCLUDED.issue_date,
                   due_date = EXCLUDED.due_date,
                   payment_link = EXCLUDED.payment_link,
                   status = CASE WHEN invoices.status = 'paid' THEN 'paid' ELSE 'open' END,
                   updated_at = now()`,
    [
      tenantId,
      customerId,
      invoiceNumber,
      amountCents,
      get("currency") ?? "usd",
      parseDate(get("issueDate")),
      parseDate(get("dueDate")),
      get("payLink") ?? null,
      workflowId,
    ],
  );

  imported.push(invoiceNumber);
}

export async function csvRoutes(app: FastifyInstance) {
  /**
   * Upload + auto-map a CSV of invoices.
   * Returns a summary of imported rows and per-row errors.
   */
  app.post(
    "/integrations/csv/import",
    { preHandler: requireRole("admin") },
    async (req) => {
      const data = await req.file();
      if (!data) throw badRequest("Missing CSV file");

      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(chunk as Buffer);
      }
      const text = Buffer.concat(chunks).toString("utf8");

      let records: CsvRow[];
      try {
        records = parseCsv(text, { columns: true, skip_empty_lines: true, trim: true }) as CsvRow[];
      } catch (err) {
        throw badRequest("Could not parse CSV: " + (err instanceof Error ? err.message : "invalid file"));
      }
      if (records.length === 0) throw badRequest("CSV has no data rows");

      const mapping = mapHeaders(Object.keys(records[0]));
      const missing = ["name", "email", "amount", "invoiceNumber"].filter((f) => !mapping[f]);
      if (missing.length > 0) {
        throw badRequest(`CSV is missing required columns: ${missing.join(", ")}`);
      }

      const errors: { row: number; error: string }[] = [];
      const imported: string[] = [];

      const tenantId = req.user.tenantId;
      await withTenant(tenantId, async (client) => {
        await client.query(
          `INSERT INTO integrations (tenant_id, source, status)
           VALUES ($1, 'csv', 'active')
           ON CONFLICT DO NOTHING`,
          [tenantId],
        );

        const workflow = await client.query<{ id: string }>(
          `SELECT id FROM workflows WHERE tenant_id = $1 AND is_default = TRUE LIMIT 1`,
          [tenantId],
        );
        const workflowId = workflow.rows[0]?.id ?? null;

        for (let i = 0; i < records.length; i++) {
          try {
            await importOneRow(client, records[i], mapping, tenantId, workflowId, imported, errors, i);
          } catch (err) {
            errors.push({
              row: i + 2,
              error: err instanceof Error ? err.message : "import failed",
            });
          }
        }
      });

      return {
        imported: imported.length,
        failed: errors.length,
        total: records.length,
        errors,
      };
    },
  );
}