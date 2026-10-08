import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { parse as parseCsv } from "csv-parse/sync";
import { requireRole } from "../../plugins/tenant.js";
import { ApiError, badRequest } from "../../lib/errors.js";
import { assertInvoiceCapacity } from "../../lib/billing.js";

type CsvRow = Record<string, string>;

const MAX_ROWS = 5000;

const HEADER_ALIASES: Record<string, string[]> = {
  name: ["client_name", "name", "customer", "customer_name", "client", "company", "bill_to"],
  email: ["client_email", "email", "customer_email", "email_address", "billing_email"],
  phone: ["client_phone", "phone", "customer_phone", "mobile", "tel", "phone_number"],
  amount: ["amount", "amount_due", "balance", "balance_due", "total", "amountdue", "amt", "open_balance"],
  dueDate: ["due_date", "due", "duedate", "payment_due", "due_on"],
  issueDate: ["issue_date", "issued", "invoice_date", "date", "created", "created_at"],
  invoiceNumber: ["invoice_number", "invoice_no", "invoice_num", "invoice", "number", "external_id", "id", "ref", "reference"],
  currency: ["currency", "ccy", "currency_code"],
  payLink: ["pay_link", "payment_link", "url", "link", "hosted_invoice_url"],
};

export function mapHeaders(headers: string[]): Record<string, string> {
  const norm = headers.map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""));
  const mapping: Record<string, string> = {};
  const used = new Set<number>();
  for (const field of Object.keys(HEADER_ALIASES)) {
    for (const alias of HEADER_ALIASES[field]) {
      const idx = norm.indexOf(alias);
      if (idx !== -1 && !used.has(idx)) {
        mapping[field] = headers[idx];
        used.add(idx);
        break;
      }
    }
  }
  return mapping;
}

/** "1,234.50", "$1234.5", "1 234,50 €" -> cents. Rejects ambiguous/negative values. */
export function toCents(value: string | undefined): number | null {
  if (!value) return null;
  let v = value.replace(/[^\d.,-]/g, "");
  if (!v || v.includes("-")) return null;
  const lastComma = v.lastIndexOf(",");
  const lastDot = v.lastIndexOf(".");
  if (lastComma > lastDot) {
    // European style "1.234,50" or "1234,5"
    v = v.replace(/\./g, "").replace(",", ".");
  } else {
    v = v.replace(/,/g, "");
  }
  const num = Number(v);
  if (!Number.isFinite(num) || num <= 0 || num > 1e10) return null;
  return Math.round(num * 100);
}

/**
 * Parse a calendar date without timezone shifting.
 * Accepts YYYY-MM-DD, YYYY/MM/DD, and D/M/Y or M/D/Y (disambiguated when a
 * component is > 12; otherwise `dayFirst` decides).
 */
export function parseCalendarDate(value: string | undefined, dayFirst = false): string | null {
  if (!value) return null;
  const v = value.trim();
  let y: number, m: number, d: number;
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(v);
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(v))) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    y = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
    if (a > 12) [d, m] = [a, b];
    else if (b > 12) [m, d] = [a, b];
    else [d, m] = dayFirst ? [a, b] : [b, a];
  } else {
    const t = Date.parse(v);
    if (Number.isNaN(t)) return null;
    const dt = new Date(t);
    [y, m, d] = [dt.getFullYear(), dt.getMonth() + 1, dt.getDate()];
  }
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** One customer per real client: keyed by email, else by name. */
function customerKey(name: string | undefined, email: string | undefined): string {
  return email ? `email:${email.toLowerCase()}` : `name:${(name ?? "").trim().toLowerCase()}`;
}

async function importOneRow(
  client: PoolClient,
  r: CsvRow,
  mapping: Record<string, string>,
  tenantId: string,
  workflowId: string | null,
  defaultCurrency: string,
  dayFirst: boolean,
): Promise<string> {
  const get = (field: string) => (mapping[field] ? r[mapping[field]]?.trim() : undefined) || undefined;

  const invoiceNumber = get("invoiceNumber");
  if (!invoiceNumber) throw new RowError("missing invoice number");
  const amountCents = toCents(get("amount"));
  if (amountCents === null) throw new RowError(`invalid amount "${get("amount") ?? ""}"`);
  const name = get("name");
  const email = get("email")?.toLowerCase();
  if (!name && !email) throw new RowError("missing client name/email");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new RowError(`invalid email "${email}"`);
  const currency = (get("currency") ?? defaultCurrency).toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) throw new RowError(`invalid currency "${currency}"`);
  const rawDue = get("dueDate");
  const dueDate = parseCalendarDate(rawDue, dayFirst);
  if (rawDue && !dueDate) throw new RowError(`invalid due date "${rawDue}"`);
  const payLink = get("payLink");
  if (payLink && !/^https:\/\//i.test(payLink)) throw new RowError("payment link must start with https://");

  await assertInvoiceCapacity(client, tenantId, "csv", invoiceNumber);

  const cu = await client.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, source, external_id, name, email, phone)
     VALUES ($1, 'csv', $2, $3, $4, $5)
     ON CONFLICT (tenant_id, source, external_id)
     DO UPDATE SET name = COALESCE(EXCLUDED.name, customers.name),
                   email = COALESCE(EXCLUDED.email, customers.email),
                   phone = COALESCE(EXCLUDED.phone, customers.phone)
     RETURNING id`,
    [tenantId, customerKey(name, email), name ?? null, email ?? null, get("phone") ?? null],
  );

  await client.query(
    `INSERT INTO invoices (tenant_id, customer_id, external_id, source, amount_due, currency, issue_date, due_date,
                           status, payment_link, workflow_id)
     VALUES ($1, $2, $3, 'csv', $4, $5, $6, $7, 'open', $8, $9)
     ON CONFLICT (tenant_id, source, external_id)
     DO UPDATE SET amount_due = EXCLUDED.amount_due,
                   currency = EXCLUDED.currency,
                   customer_id = EXCLUDED.customer_id,
                   issue_date = COALESCE(EXCLUDED.issue_date, invoices.issue_date),
                   due_date = COALESCE(EXCLUDED.due_date, invoices.due_date),
                   payment_link = COALESCE(EXCLUDED.payment_link, invoices.payment_link),
                   updated_at = now()`,
    [tenantId, cu.rows[0].id, invoiceNumber, amountCents, currency, parseCalendarDate(get("issueDate"), dayFirst), dueDate, payLink ?? null, workflowId],
  );
  return invoiceNumber;
}

class RowError extends Error {}

export async function csvRoutes(app: FastifyInstance) {
  /**
   * Upload + auto-map a CSV of invoices. Each row is imported independently
   * (SAVEPOINT per row), so one bad row never breaks the rest of the file.
   * Re-uploading the same file updates invoices instead of duplicating them.
   */
  app.post(
    "/integrations/csv/import",
    { preHandler: requireRole("admin"), config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const data = await req.file();
      if (!data) throw badRequest("Missing CSV file");
      const dayFirst = String((data.fields?.dateFormat as { value?: string } | undefined)?.value ?? "").toLowerCase() === "dmy";

      const chunks: Buffer[] = [];
      for await (const chunk of data.file) chunks.push(chunk as Buffer);
      if (data.file.truncated) throw new ApiError(413, "FILE_TOO_LARGE", "CSV is larger than 10 MB");
      const text = Buffer.concat(chunks).toString("utf8").replace(/^﻿/, "");

      let records: CsvRow[];
      try {
        records = parseCsv(text, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true, bom: true }) as CsvRow[];
      } catch (err) {
        throw badRequest("Could not read this CSV: " + (err instanceof Error ? err.message : "invalid file"), "INVALID_CSV");
      }
      if (records.length === 0) throw badRequest("The CSV has no data rows", "EMPTY_CSV");
      if (records.length > MAX_ROWS) throw badRequest(`Import up to ${MAX_ROWS} rows at a time (this file has ${records.length})`, "TOO_MANY_ROWS");

      const mapping = mapHeaders(Object.keys(records[0]));
      const missing = ["amount", "invoiceNumber"].filter((f) => !mapping[f]);
      if (!mapping.name && !mapping.email) missing.push("client name or email");
      if (missing.length > 0) {
        throw badRequest(`Couldn't find these columns: ${missing.join(", ")}. Expected headers like invoice_number, client_name, client_email, amount, due_date.`, "MISSING_COLUMNS");
      }

      const errors: { row: number; error: string }[] = [];
      let imported = 0;
      const tenantId = req.user.tenantId;

      // Runs on the request's own (tenant-scoped) connection — acquiring a second
      // connection from the same pool while holding req.db can deadlock under load.
      const client = req.db;
      await client.query("BEGIN");
      try {
        await client.query(
          `INSERT INTO integrations (tenant_id, source, status) VALUES ($1, 'csv', 'active') ON CONFLICT (tenant_id, source) DO NOTHING`,
          [tenantId],
        );
        const meta = await client.query<{ workflow_id: string | null; currency: string }>(
          `SELECT (SELECT id FROM workflows WHERE tenant_id = $1 AND is_default = TRUE ORDER BY created_at LIMIT 1) AS workflow_id,
                  (SELECT currency FROM tenants WHERE id = $1) AS currency`,
          [tenantId],
        );
        const { workflow_id: workflowId, currency } = meta.rows[0];

        for (let i = 0; i < records.length; i++) {
          await client.query("SAVEPOINT csv_row");
          try {
            await importOneRow(client, records[i], mapping, tenantId, workflowId, currency ?? "usd", dayFirst);
            await client.query("RELEASE SAVEPOINT csv_row");
            imported += 1;
          } catch (err) {
            await client.query("ROLLBACK TO SAVEPOINT csv_row");
            const msg = err instanceof RowError || err instanceof ApiError ? err.message : "could not import this row";
            if (!(err instanceof RowError || err instanceof ApiError)) req.log.warn({ err, row: i + 2 }, "csv row failed");
            errors.push({ row: i + 2, error: msg });
          }
        }
        await client.query(`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, 'csv_imported', $3::jsonb)`, [
          tenantId,
          req.user.email,
          JSON.stringify({ imported, failed: errors.length, total: records.length }),
        ]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }

      return { imported, failed: errors.length, total: records.length, errors: errors.slice(0, 200), mapping };
    },
  );
}
