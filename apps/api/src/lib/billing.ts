import { ApiError } from "./errors.js";
import type { Queryable } from "./db.js";

export const PLANS = {
  starter: { name: "Starter", invoiceLimit: 50, seatLimit: 1, creditsPerMonth: 50, monthlyPriceCents: 0, whiteLabel: false },
  growth: { name: "Growth", invoiceLimit: null, seatLimit: 3, creditsPerMonth: 500, monthlyPriceCents: 2900, whiteLabel: false },
  pro: { name: "Pro", invoiceLimit: null, seatLimit: null, creditsPerMonth: 2000, monthlyPriceCents: 5900, whiteLabel: false },
  agency: { name: "Agency", invoiceLimit: null, seatLimit: null, creditsPerMonth: 10000, monthlyPriceCents: 19900, whiteLabel: true },
} as const;

export type PlanKey = keyof typeof PLANS;
export const PLAN_KEYS = Object.keys(PLANS) as PlanKey[];

export function isPlanKey(v: unknown): v is PlanKey {
  return typeof v === "string" && (PLAN_KEYS as string[]).includes(v);
}

/** Legacy rows used "free"; anything unknown degrades to Starter. */
export function normalizePlan(v: unknown): PlanKey {
  return isPlanKey(v) ? v : "starter";
}

type Db = Queryable;

export async function tenantPlan(
  db: Db,
  tenantId: string,
): Promise<{ plan: PlanKey; invoiceLimit: number | null; seatLimit: number | null }> {
  const row = await db.query<{ plan: string; invoice_limit: number | null; seat_limit: number | null }>(
    `SELECT plan, invoice_limit, seat_limit FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const plan = normalizePlan(row.rows[0]?.plan);
  return {
    plan,
    invoiceLimit: row.rows[0] ? row.rows[0].invoice_limit : PLANS[plan].invoiceLimit,
    seatLimit: row.rows[0] ? row.rows[0].seat_limit : PLANS[plan].seatLimit,
  };
}

/**
 * Throw if the tenant cannot hold another OPEN invoice.
 * Only invoices still being chased count toward the limit, so paid/void
 * history never blocks new work. Updates to an existing invoice always pass.
 */
export async function assertInvoiceCapacity(
  db: Db,
  tenantId: string,
  source?: string,
  externalId?: string | null,
): Promise<void> {
  const { invoiceLimit } = await tenantPlan(db, tenantId);
  if (invoiceLimit === null) return;

  if (source && externalId) {
    const existing = await db.query(
      `SELECT 1 FROM invoices WHERE tenant_id = $1 AND source = $2 AND external_id = $3`,
      [tenantId, source, externalId],
    );
    if (existing.rows.length > 0) return;
  }

  const count = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM invoices WHERE tenant_id = $1 AND status IN ('open', 'paused')`,
    [tenantId],
  );
  if ((count.rows[0]?.count ?? 0) >= invoiceLimit) {
    throw new ApiError(
      402,
      "PLAN_LIMIT_EXCEEDED",
      `Your plan tracks up to ${invoiceLimit} open invoices. Upgrade for unlimited invoices.`,
    );
  }
}

/** Set a tenant's plan and keep the limits consistent. */
export async function setTenantPlan(db: Db, tenantId: string, plan: PlanKey): Promise<void> {
  await db.query(
    `UPDATE tenants SET plan = $2, invoice_limit = $3, seat_limit = $4, updated_at = now() WHERE id = $1`,
    [tenantId, plan, PLANS[plan].invoiceLimit, PLANS[plan].seatLimit],
  );
  await db.query(
    `UPDATE subscriptions SET plan = $2, credits_per_month = $3, updated_at = now() WHERE tenant_id = $1`,
    [tenantId, plan, PLANS[plan].creditsPerMonth],
  );
}

/** Throw if the tenant cannot add another member (pending invitations count too). */
export async function assertSeatCapacity(
  db: Db,
  tenantId: string,
  opts: { countInvitations?: boolean; excludeInvitationEmail?: string } = {},
): Promise<void> {
  const { seatLimit } = await tenantPlan(db, tenantId);
  if (seatLimit === null) return;
  const count = await db.query<{ count: number }>(
    `SELECT (SELECT count(*) FROM memberships m WHERE m.tenant_id = $1 AND m.status = 'active')
          + CASE WHEN $2 THEN (SELECT count(*) FROM invitations i
                                WHERE i.tenant_id = $1 AND i.status = 'pending' AND i.expires_at > now()
                                  AND ($3::text IS NULL OR i.email <> $3))
                 ELSE 0 END AS count`,
    [tenantId, opts.countInvitations ?? true, opts.excludeInvitationEmail ?? null],
  );
  if ((count.rows[0]?.count ?? 0) >= seatLimit) {
    throw new ApiError(
      402,
      "SEAT_LIMIT_EXCEEDED",
      `Your plan includes ${seatLimit} seat${seatLimit === 1 ? "" : "s"}. Upgrade to invite more teammates.`,
    );
  }
}

export async function getCreditBalance(db: Db, tenantId: string): Promise<number> {
  const row = await db.query<{ balance: number }>(`SELECT balance FROM credit_wallets WHERE tenant_id = $1`, [tenantId]);
  return row.rows[0]?.balance ?? 0;
}

/**
 * Atomically deduct one credit. Returns false when the balance is exhausted.
 * A single conditional UPDATE — no row lock is held across other work.
 */
export async function deductCredit(db: Db, tenantId: string, reason: string, referenceId?: string): Promise<boolean> {
  const res = await db.query(
    `UPDATE credit_wallets SET balance = balance - 1, updated_at = now()
      WHERE tenant_id = $1 AND balance > 0
      RETURNING balance`,
    [tenantId],
  );
  if (!res.rows.length) return false;
  await db.query(
    `INSERT INTO credit_transactions (tenant_id, delta, reason, reference_id, actor) VALUES ($1, -1, $2, $3, 'engine')`,
    [tenantId, reason, referenceId ?? null],
  );
  return true;
}

export async function refundCredit(db: Db, tenantId: string, reason: string, referenceId?: string): Promise<void> {
  await db.query(`UPDATE credit_wallets SET balance = balance + 1, updated_at = now() WHERE tenant_id = $1`, [tenantId]);
  await db.query(
    `INSERT INTO credit_transactions (tenant_id, delta, reason, reference_id, actor) VALUES ($1, 1, $2, $3, 'engine')`,
    [tenantId, reason, referenceId ?? null],
  );
}

/**
 * Grant a billing period's credit allowance exactly once per Stripe invoice.
 * Policy: allowances reset each period (no rollover) but never reduce a
 * balance that is already higher (e.g. a mid-trial upgrade keeps leftovers).
 * Returns false if this reference was already granted.
 */
export async function grantPlanCredits(db: Db, tenantId: string, plan: PlanKey, referenceId: string): Promise<boolean> {
  const allowance = PLANS[plan].creditsPerMonth;
  const inserted = await db.query(
    `INSERT INTO credit_transactions (tenant_id, delta, reason, reference_id, actor)
     VALUES ($1, $2, 'plan_grant', $3, 'stripe')
     ON CONFLICT (tenant_id, reason, reference_id) WHERE reference_id IS NOT NULL AND reason = 'plan_grant'
     DO NOTHING
     RETURNING id`,
    [tenantId, allowance, referenceId],
  );
  if (!inserted.rows.length) return false;
  await db.query(
    `INSERT INTO credit_wallets (tenant_id, balance) VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO UPDATE SET balance = GREATEST(credit_wallets.balance, EXCLUDED.balance), updated_at = now()`,
    [tenantId, allowance],
  );
  return true;
}
