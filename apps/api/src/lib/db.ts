import pg from "pg";
import { config } from "../config.js";

const { Pool, types } = pg;

// ─── Type parsing ────────────────────────────────────────────────────────────
// DATE (oid 1082): keep the calendar date as "YYYY-MM-DD". The pg default turns
// it into a JS Date at *server-local* midnight, which shifts due dates by a day
// depending on the host timezone and renders as "Tue Sep 30 2026 00:00:00 GMT…"
// inside reminder emails.
types.setTypeParser(1082, (v: string) => v);
// INT8 / BIGINT (oid 20): money is stored in minor units as BIGINT and count(*)
// returns BIGINT. Return numbers when they are exactly representable.
types.setTypeParser(20, (v: string) => {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v;
});

function poolOptions(connectionString: string, max: number, applicationName: string): pg.PoolConfig {
  return {
    connectionString,
    max,
    idleTimeoutMillis: config.dbIdleTimeoutMs,
    // Fail fast instead of hanging forever when the pool is exhausted.
    connectionTimeoutMillis: config.dbConnectionTimeoutMs,
    // Server-side guard against runaway queries.
    statement_timeout: config.dbStatementTimeoutMs || undefined,
    application_name: applicationName,
    ssl: config.dbSsl ? { rejectUnauthorized: false } : undefined,
  };
}

/** RLS-enforced pool for per-request, tenant-scoped work. */
export const pool = new Pool(poolOptions(config.databaseUrl, config.dbPoolMax, "autocollect-api"));

/**
 * Service-role pool for platform work that spans tenants or runs before a
 * tenant is known (auth lookups, webhooks, the dunning scheduler, QBO sync).
 * In production this MUST be a BYPASSRLS role. In dev it defaults to DATABASE_URL.
 */
export const servicePool = new Pool(
  poolOptions(config.databaseServiceUrl || config.databaseUrl, config.dbServicePoolMax, "autocollect-service"),
);

// An idle client that errors (e.g. DB restart) emits on the pool; without a
// listener Node treats it as an unhandled 'error' event and crashes.
for (const [name, p] of [["pool", pool], ["servicePool", servicePool]] as const) {
  p.on("error", (err) => {
    console.error(JSON.stringify({ level: "error", msg: `pg ${name} idle client error`, err: err.message }));
  });
}

export type Queryable = Pick<pg.PoolClient, "query">;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as never[]);
}

/**
 * Run work inside a transaction with the tenant scoped via a transaction-local
 * `app.tenant_id` (reverts automatically on COMMIT/ROLLBACK). Combined with
 * RLS this isolates data even on the service pool when used for tenant work.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
  { usePool = pool }: { usePool?: pg.Pool } = {},
): Promise<T> {
  const client = await usePool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Tenant-scoped transaction on the SERVICE pool. Use for work that also runs
 * from webhooks/background jobs (ingest, sync). Never acquire from `pool` while
 * a request already holds `req.db`: with a saturated pool, requests would wait
 * on each other forever (pool-exhaustion deadlock).
 */
export function withServiceTenant<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return withTenant(tenantId, fn, { usePool: servicePool });
}

/** Run work in a transaction on the service pool (no tenant scoping). */
export async function withServiceTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await servicePool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Scope a request's dedicated connection to a tenant for the rest of the
 * request. This is SESSION-level, so the connection MUST be returned with
 * `releaseRequestClient()` which resets it — otherwise the next borrower of the
 * pooled connection would inherit this tenant's RLS scope.
 */
export async function setTenantForRequest(client: pg.PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenantId]);
}

/**
 * Return a request connection to the pool in a clean state: abort any
 * transaction a handler left open and clear tenant/user scoping. If the reset
 * fails the connection is destroyed rather than reused.
 */
export async function releaseRequestClient(client: pg.PoolClient): Promise<void> {
  try {
    // ROLLBACK outside a transaction is a harmless WARNING.
    await client.query("ROLLBACK; RESET app.tenant_id; RESET app.user_id;");
    client.release();
  } catch (err) {
    client.release(err instanceof Error ? err : new Error(String(err)));
  }
}

export async function closeDb(): Promise<void> {
  await Promise.allSettled([pool.end(), servicePool.end()]);
}
