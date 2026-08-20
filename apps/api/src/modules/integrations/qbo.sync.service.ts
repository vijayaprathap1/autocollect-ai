import { servicePool, withTenant } from "../../lib/db.js";
import { assertInvoiceCapacity } from "../../lib/billing.js";
import { qboEnabled, qboMockInvoices, qboQueryInvoices, qboRefreshTokens, type QboInvoiceLike } from "../../lib/qbo.js";
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
  await withTenant(tenantId, async (client) => {
    await assertInvoiceCapacity(client, tenantId, "qbo", String(inv.Id));

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
                     status = EXCLUDED.status,
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

async function syncOne(integration: QboIntegration): Promise<number> {
  const { tenant_id: tenantId, credentials } = integration;

  let invoices: QboInvoiceLike[];
  if (qboEnabled) {
    let accessToken = credentials.access_token ? decryptSecret(credentials.access_token) : "";
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
    invoices = qboMockInvoices();
  }

  for (const inv of invoices) {
    await upsertQboInvoice(tenantId, credentials.realm_id ?? "", inv);
  }

  await servicePool.query(
    `UPDATE integrations SET settings = jsonb_set(settings, '{last_sync_at}', to_jsonb($2::text)) WHERE id = $1`,
    [integration.id, new Date().toISOString()],
  );

  return invoices.length;
}

/** Pull changed invoices from every active QBO connection that is due for a sync. */
export async function syncAllQuickBooks(): Promise<{ tenants: number; invoices: number }> {
  const rows = await servicePool.query<QboIntegration>(
    `SELECT id, tenant_id, credentials, settings
       FROM integrations
      WHERE source = 'qbo' AND status = 'active'`,
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
      await servicePool.query(
        `UPDATE integrations SET status = 'error', settings = jsonb_set(settings, '{last_error}', to_jsonb($2::text)) WHERE id = $1`,
        [integration.id, err instanceof Error ? err.message : String(err)],
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