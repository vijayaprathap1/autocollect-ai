import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { parse as parseCsv } from "csv-parse/sync";
import { requireRole } from "../../plugins/tenant.js";
import { ApiError, badRequest } from "../../lib/errors.js";
import { tenantPlan } from "../../lib/billing.js";

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

type ParsedInvoice = {
  row: number;
  invoiceNumber: string;
  amountCents: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  customerExternalId: string;
  currency: string;
  issueDate: string | null;
  dueDate: string | null;
  payLink: string | null;
};

function parseInvoiceRow(r: CsvRow, mapping: Record<string, string>, row: number, defaultCurrency: string, dayFirst: boolean): ParsedInvoice {
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
  return {
    row,
    invoiceNumber,
    amountCents,
    name: name ?? null,
    email: email ?? null,
    phone: get("phone") ?? null,
    customerExternalId: customerKey(name, email),
    currency,
    issueDate: parseCalendarDate(get("issueDate"), dayFirst),
    dueDate,
    payLink: payLink ?? null,
  };
}

/** One INSERT for many customers. Returns external id -> customer id. */
async function insertCustomers(
  client: PoolClient,
  tenantId: string,
  customers: Map<string, { externalId: string; name: string | null; email: string | null; phone: string | null }>,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const list = [...customers.values()];
  const chunkSize = 200;
  for (let i = 0; i < list.length; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    const values: unknown[] = [];
    const tuples = chunk.map((c, n) => {
      const base = n * 5;
      values.push(tenantId, c.externalId, c.name, c.email, c.phone);
      return `($${base + 1}, 'csv', $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
    });
    const inserted = await client.query<{ id: string; external_id: string }>(
      `INSERT INTO customers (tenant_id, source, external_id, name, email, phone)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (tenant_id, source, external_id)
       DO UPDATE SET name = COALESCE(EXCLUDED.name, customers.name),
                     email = COALESCE(EXCLUDED.email, customers.email),
                     phone = COALESCE(EXCLUDED.phone, customers.phone)
       RETURNING id, external_id`,
      values,
    );
    for (const row of inserted.rows) ids.set(row.external_id, row.id);
  }
  return ids;
}

/** One INSERT for many invoices. Duplicate numbers in one statement are already folded. */
async function insertInvoices(
  client: PoolClient,
  tenantId: string,
  workflowId: string | null,
  invoices: ParsedInvoice[],
  customerIds: Map<string, string>,
): Promise<void> {
  const chunkSize = 100;
  for (let i = 0; i < invoices.length; i += chunkSize) {
    const chunk = invoices.slice(i, i + chunkSize);
    const values: unknown[] = [];
    const tuples = chunk.map((inv, n) => {
      const base = n * 9;
      const customerId = customerIds.get(inv.customerExternalId);
      if (!customerId) throw new RowError("missing client");
      values.push(tenantId, customerId, inv.invoiceNumber, inv.amountCents, inv.currency, inv.issueDate, inv.dueDate, inv.payLink, workflowId);
      return `($${base + 1}, $${base + 2}, $${base + 3}, 'csv', $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, 'open', $${base + 8}, $${base + 9})`;
    });
    await client.query(
      `INSERT INTO invoices (tenant_id, customer_id, external_id, source, amount_due, currency, issue_date, due_date,
                             status, payment_link, workflow_id)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (tenant_id, source, external_id)
       DO UPDATE SET amount_due = EXCLUDED.amount_due,
                     currency = EXCLUDED.currency,
                     customer_id = EXCLUDED.customer_id,
                     issue_date = COALESCE(EXCLUDED.issue_date, invoices.issue_date),
                     due_date = COALESCE(EXCLUDED.due_date, invoices.due_date),
                     payment_link = COALESCE(EXCLUDED.payment_link, invoices.payment_link),
                     updated_at = now()`,
      values,
    );
  }
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
        const parsed: ParsedInvoice[] = [];
        for (let i = 0; i < records.length; i++) {
          try {
            parsed.push(parseInvoiceRow(records[i], mapping, i + 2, currency ?? "usd", dayFirst));
          } catch (err) {
            errors.push({ row: i + 2, error: err instanceof RowError ? err.message : "could not import this row" });
          }
        }

        const { invoiceLimit } = await tenantPlan(client, tenantId);
        const accepted: ParsedInvoice[] = [];
        if (invoiceLimit === null) {
          accepted.push(...parsed);
        } else {
          const numbers = [...new Set(parsed.map((row) => row.invoiceNumber))];
          const existing = new Set<string>();
          if (numbers.length) {
            const found = await client.query<{ external_id: string }>(
              `SELECT external_id FROM invoices WHERE tenant_id = $1 AND source = 'csv' AND external_id = ANY($2::text[])`,
              [tenantId, numbers],
            );
            for (const row of found.rows) existing.add(row.external_id);
          }
          const open = await client.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM invoices WHERE tenant_id = $1 AND status IN ('open', 'paused')`,
            [tenantId],
          );
          let room = invoiceLimit - (open.rows[0]?.count ?? 0);
          const reserved = new Set<string>();
          for (const row of parsed) {
            if (existing.has(row.invoiceNumber) || reserved.has(row.invoiceNumber)) {
              accepted.push(row);
              continue;
            }
            if (room <= 0) {
              errors.push({
                row: row.row,
                error: `Your plan tracks up to ${invoiceLimit} open invoices. Upgrade for unlimited invoices.`,
              });
              continue;
            }
            room -= 1;
            reserved.add(row.invoiceNumber);
            accepted.push(row);
          }
        }

        const customers = new Map<string, { externalId: string; name: string | null; email: string | null; phone: string | null }>();
        const invoices = new Map<string, ParsedInvoice>();
        for (const row of accepted) {
          const prevCustomer = customers.get(row.customerExternalId);
          customers.set(row.customerExternalId, {
            externalId: row.customerExternalId,
            name: row.name ?? prevCustomer?.name ?? null,
            email: row.email ?? prevCustomer?.email ?? null,
            phone: row.phone ?? prevCustomer?.phone ?? null,
          });
          const prevInvoice = invoices.get(row.invoiceNumber);
          invoices.set(row.invoiceNumber, {
            ...row,
            issueDate: row.issueDate ?? prevInvoice?.issueDate ?? null,
            dueDate: row.dueDate ?? prevInvoice?.dueDate ?? null,
            payLink: row.payLink ?? prevInvoice?.payLink ?? null,
          });
        }
        if (customers.size) {
          const customerIds = await insertCustomers(client, tenantId, customers);
          await insertInvoices(client, tenantId, workflowId, [...invoices.values()], customerIds);
        }
        imported = accepted.length;
        errors.sort((a, b) => a.row - b.row);
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
