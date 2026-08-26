import type { PoolClient } from "pg";
import { ApiError } from "./errors.js";

export const PLANS = {
  starter: { name: "Starter", invoiceLimit: 50, seatLimit: 1, creditsPerMonth: 50, monthlyPriceCents: 0, whiteLabel: false },
  growth: { name: "Growth", invoiceLimit: null, seatLimit: 3, creditsPerMonth: 500, monthlyPriceCents: 2900, whiteLabel: false },
  pro: { name: "Pro", invoiceLimit: null, seatLimit: null, creditsPerMonth: 2000, monthlyPriceCents: 5900, whiteLabel: false },
  agency: { name: "Agency", invoiceLimit: null, seatLimit: null, creditsPerMonth: 10000, monthlyPriceCents: 19900, whiteLabel: true },
} as const;

export type PlanKey = keyof typeof PLANS;
export const PLAN_KEYS = Object.keys(PLANS) as PlanKey[];

type Db = Pick<PoolClient, "query">;

export async function tenantPlan(
  db: Db,
  tenantId: string,
): Promise<{ plan: PlanKey; invoiceLimit: number | null; seatLimit: number | null }> {
  const row = await db.query<{ plan: string; invoice_limit: number | null; seat_limit: number | null }>(
    `SELECT plan, invoice_limit, seat_limit FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const plan = (row.rows[0]?.plan ?? "starter") as PlanKey;
  return {
    plan,
    invoiceLimit: row.rows[0]?.invoice_limit ?? PLANS[plan].invoiceLimit,
    seatLimit: row.rows[0]?.seat_limit ?? PLANS[plan].seatLimit,
  };
}

/**
 * Throw if the tenant cannot hold another invoice.
 * Pass the source + external id so updates to existing invoices are not blocked
 * at the boundary. `externalId = null` is always treated as a new invoice.
 */
export async function assertInvoiceCapacity(
  db: Db,
  tenantId: string,
  source?: string,
  externalId?: string | null,
): Promise<void> {
  const { invoiceLimit } = await tenantPlan(db, tenantId);
  if (invoiceLimit === null) return; // Growth = unlimited

  if (source && externalId) {
    const existing = await db.query(
      `SELECT 1 FROM invoices WHERE tenant_id = $1 AND source = $2 AND external_id = $3`,
      [tenantId, source, externalId],
    );
    if (existing.rows.length > 0) return; // update of an existing invoice
  }

  const count = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM invoices WHERE tenant_id = $1`,
    [tenantId],
  );
  if ((count.rows[0]?.count ?? 0) >= invoiceLimit) {
    throw new ApiError(
      402,
      "PLAN_LIMIT_EXCEEDED",
      `Invoice limit reached (${invoiceLimit}). Upgrade to Growth for unlimited invoices.`,
    );
  }
}

/** Set a tenant's plan and keep the limits consistent. */
export async function setTenantPlan(db: Db, tenantId: string, plan: PlanKey): Promise<void> {
  await db.query(
    `UPDATE tenants SET plan = $2, invoice_limit = $3, seat_limit = $4 WHERE id = $1`,
    [tenantId, plan, PLANS[plan].invoiceLimit, PLANS[plan].seatLimit],
  );
}

/**
 * Throw if the tenant cannot hold another member. Pass an optional role so
 * the current user's own seat is not counted against the limit.
 */
export async function assertSeatCapacity(
  db: Db,
  tenantId: string,
  excludeUserId?: string,
): Promise<void> {
  const { seatLimit } = await tenantPlan(db, tenantId);
  if (seatLimit === null) return; // unlimited
  const count = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM memberships m
     WHERE m.tenant_id = $1 AND m.status = 'active'
     AND ($2::uuid IS NULL OR m.user_id <> $2::uuid)`,
    [tenantId, excludeUserId ?? null],
  );
  if ((count.rows[0]?.count ?? 0) >= seatLimit) {
    throw new ApiError(
      402,
      "SEAT_LIMIT_EXCEEDED",
      `Member limit reached (${seatLimit}). Upgrade your plan for more seats.`,
    );
  }
}

/** Get the current credit balance for a tenant. */
export async function getCreditBalance(db: Db, tenantId: string): Promise<number> {
  const row = await db.query<{ balance: number }>(
    `SELECT balance FROM credit_wallets WHERE tenant_id = $1`,
    [tenantId],
  );
  return row.rows[0]?.balance ?? 0;
}

/**
 * Deduct credits for a send. Returns true if credits were available and deducted,
 * false if insufficient. Uses SELECT ... FOR UPDATE to prevent races.
 */
export async function deductCredit(
  db: Db,
  tenantId: string,
  reason: string,
  referenceId?: string,
): Promise<boolean> {
  const wallet = await db.query<{ balance: number }>(
    `SELECT balance FROM credit_wallets WHERE tenant_id = $1 FOR UPDATE`,
    [tenantId],
  );
  const balance = wallet.rows[0]?.balance ?? 0;
  if (balance <= 0) return false;

  await db.query(
    `UPDATE credit_wallets SET balance = balance - 1, updated_at = now() WHERE tenant_id = $1`,
    [tenantId],
  );
  await db.query(
    `INSERT INTO credit_transactions (tenant_id, delta, reason, reference_id, actor, created_at)
     VALUES ($1, -1, $2, $3, 'engine', now())`,
    [tenantId, reason, referenceId ?? null],
  );
  return true;
}