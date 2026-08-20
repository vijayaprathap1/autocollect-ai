import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

/**
 * Service-role pool for background/platform work that spans tenants
 * (webhooks, the dunning scheduler, QBO sync). Under FORCE RLS this role is
 * expected to be BYPASSRLS. In dev it defaults to the same URL as `pool`,
 * so behavior is identical to before.
 */
export const servicePool = new Pool({
  connectionString: config.databaseServiceUrl || config.databaseUrl,
  max: 5,
  idleTimeoutMillis: 30_000,
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as never[]);
}

/**
 * Run work inside a transaction with the given tenant scoped via
 * `SET LOCAL app.tenant_id`. Combined with RLS this isolates data.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function setTenantForRequest(
  client: pg.PoolClient | typeof pool,
  tenantId: string,
): Promise<void> {
  await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenantId]);
}

export async function closeDb(): Promise<void> {
  await pool.end();
  await servicePool.end();
}