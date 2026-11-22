import { servicePool, withServiceTenant } from "../../lib/db.js";
import { assertInvoiceCapacity } from "../../lib/billing.js";
import { qboEnabled, qboMockInvoices, qboMockPayments, qboQueryInvoices, qboQueryPayments, qboRefreshTokens, QboAuthError, type QboInvoiceLike, type QboPaymentLike } from "../../lib/qbo.js";
import { applyCash, recordPayment } from "../../lib/cash-ledger.js";
import { isProduction } from "../../config.js";
import { decryptSecret, encryptSecret } from "../../lib/crypto.js";

const MIN_SYNC_INTERVAL_MS = 5 * 60 * 1000;

type QboIntegration = {
  id: string;
  tenant_id: string;
  credentials: {
    realm_id?: string;
    access_token?: string;
    refresh_token?: string;
    expires_at?: string;
  };
  settings: { last_sync_at?: string };
};

function toCents(value: string | number | undefined): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

async function upsertQboInvoice(
  tenantId: string,
  realmId: string,
  inv: QboInvoiceLike,
): Promise<void> {
  await withServiceTenant(tenantId, async (client) => {
    const outstanding = toCents(inv.Balance ?? inv.TotalAmt);
    if (outstanding > 0) await assertInvoiceCapacity(client, tenantId, "qbo", String(inv.Id));

    const customerId = inv.CustomerRef?.value ?? null;
    const email = inv.BillEmail?.Address ?? null;
    const name = inv.CustomerRef?.name ?? null;

    let resolvedCustomer: string | null = null;
    if (customerId) {
      const cu = await client.query<{ id: string }>(
        `INSERT INTO customers (tenant_id, source, external_id, name, email)
         VALUES ($1, 'qbo', $2, $3, $4)
         ON CONFLICT (tenant_id, source, external_id)
         DO UPDATE SET name = COALESCE(EXCLUDED.name, customers.name),
                       email = COALESCE(EXCLUDED.email, customers.email)
         RETURNING id`,
        [tenantId, customerId, name, email],
      );
      resolvedCustomer = cu.rows[0].id;
    }

    const amountDue = toCents(inv.Balance ?? inv.TotalAmt);
    const status = amountDue > 0 ? "open" : "paid";
    const lineItems = (inv.Line ?? []).map((l) => ({
      description: l.Description ?? null,
      quantity: 1,
      amount: toCents(l.Amount),
    }));

    await client.query(
      `INSERT INTO invoices (tenant_id, customer_id, external_id, source,
                             amount_due, currency, issue_date, due_date, status,
                             line_items, workflow_id)
       VALUES ($1, $2, $3, 'qbo', $4, $5, $6, $7, $8, $9::jsonb,
               (SELECT id FROM workflows WHERE tenant_id = $1 AND is_default = TRUE LIMIT 1))
       ON CONFLICT (tenant_id, source, external_id)
       DO UPDATE SET amount_due = EXCLUDED.amount_due,
                     currency = EXCLUDED.currency,
                     issue_date = EXCLUDED.issue_date,
                     due_date = EXCLUDED.due_date,
                     -- never reopen an invoice someone paused; paid/closed always wins
                     status = CASE WHEN EXCLUDED.status = 'open' AND invoices.status IN ('paused','paid') THEN invoices.status
                                   ELSE EXCLUDED.status END,
                     next_step_index = CASE WHEN EXCLUDED.status = 'paid' THEN 9999 ELSE invoices.next_step_index END,
                     next_step_due_at = CASE WHEN EXCLUDED.status = 'paid' THEN NULL ELSE invoices.next_step_due_at END,
                     customer_id = COALESCE(EXCLUDED.customer_id, invoices.customer_id),
                     line_items = EXCLUDED.line_items,
                     updated_at = now()`,
      [
        tenantId,
        resolvedCustomer,
        String(inv.Id),
        amountDue,
        inv.CurrencyRef?.value?.toLowerCase() ?? "usd",
        inv.TxnDate ?? null,
        inv.DueDate ?? null,
        status,
        JSON.stringify(lineItems),
      ],
    );
  });
  void realmId;
}

async function upsertQboPayment(tenantId: string, payment: QboPaymentLike): Promise<void> {
  const amount = toCents(payment.TotalAmt);
  if (amount <= 0) return;
  await withServiceTenant(tenantId, async (client) => {
    let customerId: string | null = null;
    const externalCustomer = payment.CustomerRef?.value;
    if (externalCustomer) {
      const found = await client.query<{ id: string }>(
        `SELECT id FROM customers WHERE tenant_id = $1 AND source = 'qbo' AND external_id = $2`,
        [tenantId, externalCustomer],
      );
      customerId = found.rows[0]?.id ?? null;
    }
    const recorded = await recordPayment(client, {
      tenantId,
      customerId,
      source: "qbo",
      externalId: String(payment.Id),
      amount,
      currency: payment.CurrencyRef?.value?.toLowerCase() ?? "usd",
      paidAt: payment.TxnDate ? `${payment.TxnDate}T00:00:00Z` : undefined,
      reference: "QuickBooks payment",
    });
    if (Number(recorded.unapplied) <= 0) return;
    const links = (payment.Line ?? []).flatMap((line) =>
      (line.LinkedTxn ?? [])
        .filter((txn) => txn.TxnType === "Invoice" && txn.TxnId)
        .map((txn) => ({ invoiceExternalId: String(txn.TxnId), amount: toCents(line.Amount) })),
    );
    const lines: { invoiceId: string; amount: number }[] = [];
    for (const link of links) {
      if (link.amount <= 0) continue;
      const invoice = await client.query<{ id: string; status: string; amount_due: number }>(
        `SELECT id, status, amount_due FROM invoices WHERE tenant_id = $1 AND source = 'qbo' AND external_id = $2`,
        [tenantId, link.invoiceExternalId],
      );
      const row = invoice.rows[0];
      if (!row) continue;
      if ((row.status === "open" || row.status === "paused") && Number(row.amount_due) >= link.amount) {
        lines.push({ invoiceId: row.id, amount: link.amount });
      } else if (row.status === "paid") {
        await client.query(
          `INSERT INTO cash_applications (tenant_id, payment_id, invoice_id, amount, method) VALUES ($1, $2, $3, $4, 'exact')`,
          [tenantId, recorded.id, row.id, link.amount],
        );
        await client.query(`UPDATE payments SET unapplied = GREATEST(unapplied - $3, 0) WHERE id = $1 AND tenant_id = $2`, [
          recorded.id,
          tenantId,
          link.amount,
        ]);
      }
    }
    if (lines.length) {
      await applyCash(
        client,
        { tenantId, paymentId: recorded.id, lines, userId: null, method: lines.length > 1 ? "multi" : "exact" },
        { transaction: false },
      );
    }
  });
}

async function syncOne(integration: QboIntegration): Promise<number> {
  const { tenant_id: tenantId, credentials } = integration;

  let invoices: QboInvoiceLike[];
  let accessToken = "";
  if (qboEnabled) {
    accessToken = credentials.access_token ? decryptSecret(credentials.access_token) : "";
    if (credentials.refresh_token && credentials.expires_at && Date.parse(credentials.expires_at) <= Date.now()) {
      const refreshed = await qboRefreshTokens(decryptSecret(credentials.refresh_token));
      accessToken = refreshed.accessToken;
      await servicePool.query(
        `UPDATE integrations SET credentials = $2::jsonb WHERE id = $1`,
        [
          integration.id,
          JSON.stringify({
            ...credentials,
            access_token: encryptSecret(refreshed.accessToken),
            refresh_token: encryptSecret(refreshed.refreshToken),
            expires_at: refreshed.expiresAt,
          }),
        ],
      );
    }
    if (!credentials.realm_id || !accessToken) return 0;
    invoices = await qboQueryInvoices(accessToken, credentials.realm_id, integration.settings.last_sync_at);
  } else {
    if (isProduction) throw new Error("QuickBooks is not configured on this server");
    invoices = qboMockInvoices();
  }

  for (const inv of invoices) {
    await upsertQboInvoice(tenantId, credentials.realm_id ?? "", inv);
  }

  let payments: QboPaymentLike[];
  if (qboEnabled) {
    payments = credentials.realm_id && accessToken ? await qboQueryPayments(accessToken, credentials.realm_id, integration.settings.last_sync_at) : [];
  } else {
    payments = isProduction ? [] : qboMockPayments();
  }
  for (const payment of payments) {
    await upsertQboPayment(tenantId, payment);
  }

  await servicePool.query(
    `UPDATE integrations
        SET settings = (COALESCE(settings, '{}'::jsonb) - 'last_error') || jsonb_build_object('last_sync_at', $2::text),
            status = 'active', updated_at = now()
      WHERE id = $1`,
    [integration.id, new Date().toISOString()],
  );

  return invoices.length;
}

/** Pull changed invoices from every active QBO connection that is due for a sync. */
export async function syncAllQuickBooks(): Promise<{ tenants: number; invoices: number }> {
  const rows = await servicePool.query<QboIntegration>(
    `SELECT ig.id, ig.tenant_id, ig.credentials, COALESCE(ig.settings, '{}'::jsonb) AS settings
       FROM integrations ig JOIN tenants t ON t.id = ig.tenant_id
      WHERE ig.source = 'qbo' AND ig.status = 'active' AND t.status = 'active'`,
  );

  let tenants = 0;
  let invoices = 0;
  for (const integration of rows.rows) {
    const lastSync = integration.settings?.last_sync_at
      ? Date.parse(integration.settings.last_sync_at)
      : 0;
    if (Date.now() - lastSync < MIN_SYNC_INTERVAL_MS) continue;
    try {
      invoices += await syncOne(integration);
      tenants += 1;
    } catch (err) {
      // Only an auth failure needs the user to reconnect; transient errors retry next cycle.
      await servicePool.query(
        `UPDATE integrations
            SET status = CASE WHEN $3 THEN 'error' ELSE status END,
                settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('last_error', $2::text, 'last_error_at', now()::text),
                updated_at = now()
          WHERE id = $1`,
        [integration.id, (err instanceof Error ? err.message : String(err)).slice(0, 500), err instanceof QboAuthError],
      );
    }
  }
  return { tenants, invoices };
}

/** Manual sync for a single tenant (admin endpoint). */
export async function syncQuickBooksForTenant(tenantId: string): Promise<{ synced: number; mock: boolean }> {
  const row = await servicePool.query<QboIntegration>(
    `SELECT id, tenant_id, credentials, settings
       FROM integrations
      WHERE tenant_id = $1 AND source = 'qbo' AND status = 'active'
      LIMIT 1`,
    [tenantId],
  );
  const integration = row.rows[0];
  if (!integration) throw new Error("QuickBooks is not connected");
  const count = await syncOne(integration);
  return { synced: count, mock: !qboEnabled };
}