/**
 * Cash application, credit decisions, role gates and tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.WEB_ORIGIN = "http://localhost:5175";
process.env.APP_URL = "http://localhost:4000";

type App = Awaited<ReturnType<typeof import("../../src/app.js").buildApp>>;
let app: App;
let db: typeof import("../../src/lib/db.js");
const ORIGIN = { origin: "http://localhost:5175" };
const mail: string[] = [];

class Jar {
  cookies = new Map<string, string>();
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  store(setCookie: string | string[] | undefined) {
    for (const c of [setCookie ?? []].flat()) {
      const [pair, ...attrs] = c.split(";");
      const [k, ...v] = pair.split("=");
      if (attrs.some((a) => /max-age=0/i.test(a.trim()))) this.cookies.delete(k.trim());
      else this.cookies.set(k.trim(), v.join("="));
    }
  }
}

async function call(jar: Jar | null, method: "GET" | "POST" | "PATCH", url: string, body?: unknown) {
  const res = await app.inject({
    method,
    url,
    payload: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(jar ? { cookie: jar.header(), "x-requested-with": "test" } : {}),
      ...ORIGIN,
    },
  });
  jar?.store(res.headers["set-cookie"] as string | string[] | undefined);
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, any>) : {}, text: res.body }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function workspace(email: string, org: string) {
  const jar = new Jar();
  expect((await call(null, "POST", "/auth/signup", { email, password: "Str0ngPass!", name: org, organizationName: org })).status).toBe(202);
  const token = new URLSearchParams([...mail.join("\n").matchAll(/verify-email\?([^\s]+)/g)].pop()?.[1] ?? "").get("token");
  expect((await call(jar, "POST", "/auth/verify-email", { token })).status).toBe(200);
  const me = await call(jar, "GET", "/me");
  return { jar, tenantId: me.body.tenant.id as string, userId: me.body.user.id as string };
}

describe("enterprise AR", () => {
  beforeAll(async () => {
    const { migrate } = await import("../../src/scripts/migrate.js");
    await migrate();
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      mail.push(args.map(String).join(" "));
    });
    db = await import("../../src/lib/db.js");
    app = (await import("../../src/app.js")).buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await db?.closeDb();
  });

  it("applies a receipt, hides it from another tenant, and blocks a viewer", async () => {
    const a = await workspace(`ent-a-${Date.now().toString(36)}@example.com`, "Ent A");
    const b = await workspace(`ent-b-${Date.now().toString(36)}@example.com`, "Ent B");
    const customer = await db.servicePool.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, source, external_id, name) VALUES ($1, 'csv', 'c', 'Acme Buyer') RETURNING id`,
      [a.tenantId],
    );
    const invoice = await db.servicePool.query<{ id: string }>(
      `INSERT INTO invoices (tenant_id, customer_id, source, external_id, amount_due, currency, due_date, status)
       VALUES ($1, $2, 'csv', 'INV-1', 10000, 'usd', CURRENT_DATE - 10, 'open') RETURNING id`,
      [a.tenantId, customer.rows[0].id],
    );
    const created = await call(a.jar, "POST", "/cash/payments", { customerId: customer.rows[0].id, externalId: "wire-1", amount: 10000, currency: "usd" });
    expect(created.status).toBe(201);
    const suggestions = await call(a.jar, "GET", `/cash/payments/${created.body.payment.id}/suggestions`);
    expect(suggestions.body.suggestions[0].method).toBe("exact");
    const applied = await call(a.jar, "POST", `/cash/payments/${created.body.payment.id}/apply`, {
      lines: [{ invoiceId: invoice.rows[0].id, amount: 10000 }],
      acceptSuggestion: true,
    });
    expect(applied.status).toBe(200);
    const dash = await call(a.jar, "GET", "/dashboard");
    expect(dash.body.recovered30d).toBe(10000);
    const cust = await call(a.jar, "GET", `/customers/${customer.rows[0].id}`);
    expect(cust.body.payments[0].amount).toBe(10000);
    const task = await call(a.jar, "POST", "/tasks", { title: "Call them", customerId: customer.rows[0].id });
    expect(task.status).toBe(201);
    const exported = await app.inject({
      method: "GET",
      url: "/exports/invoices?format=csv&status=paid",
      headers: { cookie: a.jar.header(), ...ORIGIN },
    });
    expect(exported.body).toContain("0.00");
    expect(exported.body).not.toContain("10000");
    const other = await call(b.jar, "GET", "/cash/payments?unapplied=1");
    expect(other.body.payments.find((p: { id: string }) => p.id === created.body.payment.id)).toBeUndefined();

    await db.servicePool.query(`UPDATE memberships SET role = 'viewer' WHERE user_id = $1 AND tenant_id = $2`, [a.userId, a.tenantId]);
    const denied = await call(a.jar, "POST", "/cash/payments", { externalId: "wire-2", amount: 1000 });
    expect(denied.status).toBe(403);
    const taskDenied = await call(a.jar, "PATCH", `/tasks/${task.body.task.id}`, { status: "done" });
    expect(taskDenied.status).toBe(403);

    const forecast = await call(b.jar, "GET", "/forecast");
    expect(forecast.status).toBe(200);
    const analytics = await call(b.jar, "GET", "/analytics/process");
    expect(analytics.status).toBe(200);
    expect(analytics.body.bottlenecks.length).toBeGreaterThan(0);

    const started = Date.now();
    const burst = await Promise.all(Array.from({ length: 20 }, () => call(b.jar, "GET", "/forecast")));
    expect(burst.every((r) => r.status === 200)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("row level security hides the new tables from another tenant", async () => {
    const pg = (await import("pg")).default;
    const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL });
    await owner.connect();
    try {
      const role = await owner.query(`SELECT 1 FROM pg_roles WHERE rolname = 'autocollect_app'`);
      expect(role.rowCount, "run npm run db:roles so autocollect_app exists").toBe(1);
      const a = await workspace(`rls-a-${Date.now().toString(36)}@example.com`, "RLS A");
      const b = await workspace(`rls-b-${Date.now().toString(36)}@example.com`, "RLS B");
      const customer = await db.servicePool.query<{ id: string }>(
        `INSERT INTO customers (tenant_id, source, external_id, name) VALUES ($1, 'csv', 'rls-c', 'RLS Buyer') RETURNING id`,
        [a.tenantId],
      );
      const invoice = await db.servicePool.query<{ id: string }>(
        `INSERT INTO invoices (tenant_id, customer_id, source, external_id, amount_due, currency, status)
         VALUES ($1, $2, 'csv', 'RLS-INV', 100, 'usd', 'open') RETURNING id`,
        [a.tenantId, customer.rows[0].id],
      );
      const payment = await db.servicePool.query<{ id: string }>(
        `INSERT INTO payments (tenant_id, customer_id, source, external_id, amount, unapplied, currency)
         VALUES ($1, $2, 'manual', 'rls-1', 100, 100, 'usd') RETURNING id`,
        [a.tenantId, customer.rows[0].id],
      );
      await db.servicePool.query(
        `INSERT INTO cash_applications (tenant_id, payment_id, invoice_id, amount, method) VALUES ($1, $2, $3, 100, 'manual')`,
        [a.tenantId, payment.rows[0].id, invoice.rows[0].id],
      );
      await db.servicePool.query(
        `INSERT INTO credit_reviews (tenant_id, customer_id, status) VALUES ($1, $2, 'open')`,
        [a.tenantId, customer.rows[0].id],
      );
      await db.servicePool.query(
        `INSERT INTO saved_filters (tenant_id, user_id, name, scope, query) VALUES ($1, $2, 'rls', 'invoices', '{}')`,
        [a.tenantId, a.userId],
      );
      await db.servicePool.query(`INSERT INTO notifications (tenant_id, kind, title) VALUES ($1, 'cash', 'hello')`, [a.tenantId]);
      await owner.query("BEGIN");
      await owner.query("SET LOCAL ROLE autocollect_app");
      await owner.query(`SELECT set_config('app.tenant_id', $1, true)`, [b.tenantId]);
      for (const table of ["payments", "cash_applications", "credit_reviews", "saved_filters", "notifications"]) {
        const seen = await owner.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect(seen.rows[0].n, table).toBe(0);
      }
      await owner.query("ROLLBACK");
    } finally {
      await owner.end();
    }
  });
});
