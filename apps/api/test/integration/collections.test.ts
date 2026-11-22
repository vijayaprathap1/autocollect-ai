/**
 * Collector records: a dispute reply becomes a case, a missed promise becomes
 * a task, and the worklist ranks the account.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reconcilePromises } from "../../src/lib/collections.js";

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
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, any>) : {} }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe("collections workbench", () => {
  beforeAll(async () => {
    const { migrate } = await import("../../src/scripts/migrate.js");
    await migrate();
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      mail.push(args.map(String).join(" "));
    });
    db = await import("../../src/lib/db.js");
    const mod = await import("../../src/app.js");
    app = mod.buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db?.closeDb();
  });

  it("ranks a customer, opens a dispute, and breaks a missed promise", async () => {
    const email = `ar-${Date.now().toString(36)}@example.com`;
    const jar = new Jar();
    expect((await call(null, "POST", "/auth/signup", { email, password: "Str0ngPass!", name: "AR", organizationName: "AR Co" })).status).toBe(202);
    const token = new URLSearchParams([...mail.join("\n").matchAll(/verify-email\?([^\s]+)/g)].pop()?.[1] ?? "").get("token");
    expect((await call(jar, "POST", "/auth/verify-email", { token })).status).toBe(200);
    const me = await call(jar, "GET", "/me");
    const tenantId = me.body.tenant.id as string;

    const customer = await db.servicePool.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, source, external_id, name, email) VALUES ($1, 'csv', 'c-1', 'Northwind', 'ap@northwind.test') RETURNING id`,
      [tenantId],
    );
    const invoice = await db.servicePool.query<{ id: string }>(
      `INSERT INTO invoices (tenant_id, customer_id, source, external_id, amount_due, currency, issue_date, due_date, status)
       VALUES ($1, $2, 'csv', 'INV-9', 250000, 'usd', CURRENT_DATE - 40, CURRENT_DATE - 20, 'open') RETURNING id`,
      [tenantId, customer.rows[0].id],
    );

    const work = await call(jar, "GET", "/worklist");
    expect(work.status).toBe(200);
    expect(work.body.worklist[0].name).toBe("Northwind");
    expect(work.body.worklist[0].riskScore).toBeGreaterThan(0);

    const dispute = await call(jar, "POST", "/disputes", { invoiceId: invoice.rows[0].id, reasonCode: "pricing", summary: "Rate card mismatch" });
    expect(dispute.status).toBe(201);
    const noted = await call(jar, "POST", `/disputes/${dispute.body.dispute.id}/notes`, { body: "Asked AP for the PO." });
    expect(noted.status).toBe(201);

    const promised = await call(jar, "POST", "/promises", { invoiceId: invoice.rows[0].id, promiseDate: "2020-01-01" });
    expect(promised.status).toBe(201);
    const result = await reconcilePromises();
    expect(result.broken).toBeGreaterThanOrEqual(1);
    expect(result.tasks).toBeGreaterThanOrEqual(1);
    const promises = await call(jar, "GET", "/promises?status=broken");
    expect(promises.body.promises.some((p: { id: string }) => p.id === promised.body.promise.id)).toBe(true);

    const detail = await call(jar, "GET", `/customers/${customer.rows[0].id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.disputes.length).toBeGreaterThan(0);
    expect(detail.body.invoices.length).toBe(1);

    const dash = await call(jar, "GET", "/dashboard");
    expect(dash.status).toBe(200);
    expect(dash.body.disputeKpis.open).toBeGreaterThan(0);
    expect(dash.body).toHaveProperty("cei");
  });
});
