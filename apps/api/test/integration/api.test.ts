/**
 * End-to-end API tests against a real Postgres (the same migrations as prod).
 *
 * Run locally:
 *   DATABASE_URL=postgres://autocollect_app:...@localhost:5433/autocollect \
 *   SERVICE_DATABASE_URL=postgres://autocollect_service:...@localhost:5433/autocollect \
 *   MIGRATION_DATABASE_URL=postgres://autocollect:...@localhost:5433/autocollect \
 *   npm test -w @autocollect/api
 *
 * With DATABASE_URL pointing at the RLS-enforced app role (as CI does), these
 * tests also prove Row-Level Security isolation. The request pool is forced to
 * ONE connection so every request reuses the same pooled connection — the
 * exact condition under which a leaked tenant scope would surface.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DB_POOL_MAX = "1";
process.env.WEB_ORIGIN = "http://localhost:5175";
process.env.APP_URL = "http://localhost:4000";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

type App = Awaited<ReturnType<typeof import("../../src/app.js").buildApp>>;
let app: App;
let db: typeof import("../../src/lib/db.js");
const mail: string[] = [];
const ORIGIN = { origin: "http://localhost:5175" };
const run = Date.now().toString(36);

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

async function call(jar: Jar | null, method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({
    method,
    url,
    payload: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(jar ? { cookie: jar.header(), "x-requested-with": "test" } : {}),
      ...headers,
    },
  });
  jar?.store(res.headers["set-cookie"] as string | string[] | undefined);
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, any>) : {} }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function lastLink(kind: string): string {
  const all = mail.join("\n");
  const m = [...all.matchAll(new RegExp(`${kind}\\?([^\\s]+)`, "g"))].pop();
  if (!m) throw new Error(`no ${kind} link captured`);
  return m[1];
}

async function signupAndVerify(email: string, org: string): Promise<Jar> {
  const jar = new Jar();
  const s = await call(null, "POST", "/auth/signup", { email, password: "Str0ngPass!", name: org, organizationName: org }, ORIGIN);
  expect(s.status).toBe(202);
  const token = new URLSearchParams(lastLink("verify-email")).get("token")!;
  const v = await call(jar, "POST", "/auth/verify-email", { token }, ORIGIN);
  expect(v.body.signedIn).toBe(true);
  return jar;
}

d("API integration", () => {
  beforeAll(async () => {
    const { migrate } = await import("../../src/scripts/migrate.js");
    await migrate();
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      mail.push(args.map(String).join(" "));
    });
    const mod = await import("../../src/app.js");
    db = await import("../../src/lib/db.js");
    app = mod.buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db?.closeDb();
  });

  it("serves liveness and readiness", async () => {
    expect((await call(null, "GET", "/health")).status).toBe(200);
    const ready = await call(null, "GET", "/ready");
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ db: "ok", serviceDb: "ok" });
  });

  it("never leaks a tenant scope to the next user of a pooled connection", async () => {
    const jar = await signupAndVerify(`leak-${run}@example.com`, "Leak Co");
    expect((await call(jar, "GET", "/invoices")).status).toBe(200);
    // The request pool has exactly one connection, so this is the same one.
    const r = await db.pool.query<{ t: string | null }>("SELECT current_setting('app.tenant_id', true) AS t");
    expect(r.rows[0].t ?? "").toBe("");
  });

  it("enforces Row-Level Security at the database for the runtime role", async () => {
    const role = await db.pool.query<{ bypass: boolean }>(
      "SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user",
    );
    if (role.rows[0].bypass) return; // running as a superuser locally — RLS not observable
    const client = await db.pool.connect();
    try {
      const unscoped = await client.query("SELECT count(*)::int AS n FROM tenants");
      expect(unscoped.rows[0].n).toBe(0);
    } finally {
      await db.releaseRequestClient(client);
    }
  });

  it("isolates tenants through the API", async () => {
    const a = await signupAndVerify(`iso-a-${run}@example.com`, "Tenant A");
    const b = await signupAndVerify(`iso-b-${run}@example.com`, "Tenant B");
    const ing = await call(a, "POST", "/integrations/stripe/dev-event", { invoice: { id: `in_iso_${run}`, due_days: 5 } });
    expect(ing.status).toBe(200);
    const list = await call(a, "GET", "/invoices");
    const id = list.body.invoices[0].id as string;
    expect((await call(b, "GET", `/invoices/${id}`)).status).toBe(404);
    expect((await call(b, "GET", "/invoices")).body.invoices).toHaveLength(0);
    expect((await call(b, "POST", `/invoices/${id}/actions`, { action: "mark_paid" })).status).toBe(404);
    expect((await call(a, "GET", "/invoices/not-a-uuid")).status).toBe(404);
  });

  it("covers the full password lifecycle", async () => {
    const email = `pw-${run}@example.com`;
    await call(null, "POST", "/auth/signup", { email, password: "Str0ngPass!", name: "Pat" }, ORIGIN);

    const unverified = await call(null, "POST", "/auth/login", { email, password: "Str0ngPass!" }, ORIGIN);
    expect(unverified.body.error.code).toBe("EMAIL_NOT_VERIFIED");

    const token = new URLSearchParams(lastLink("verify-email")).get("token")!;
    await call(new Jar(), "POST", "/auth/verify-email", { token }, ORIGIN);
    expect((await call(new Jar(), "POST", "/auth/verify-email", { token }, ORIGIN)).body.error.code).toBe("INVALID_TOKEN");

    for (let i = 0; i < 5; i++) {
      expect((await call(null, "POST", "/auth/login", { email, password: "wrong-pass-1" }, ORIGIN)).status).toBe(401);
    }
    const locked = await call(null, "POST", "/auth/login", { email, password: "Str0ngPass!" }, ORIGIN);
    expect(locked.body.error.code).toBe("ACCOUNT_LOCKED");

    const unknown = await call(null, "POST", "/auth/forgot-password", { email: `nobody-${run}@example.com` }, ORIGIN);
    const known = await call(null, "POST", "/auth/forgot-password", { email }, ORIGIN);
    expect(unknown.body).toEqual(known.body); // no account enumeration

    const reset = new URLSearchParams(lastLink("reset-password")).get("token")!;
    expect((await call(null, "POST", "/auth/reset-password", { token: reset, password: "N3wPassw0rd!" }, ORIGIN)).status).toBe(200);
    expect((await call(null, "POST", "/auth/reset-password", { token: reset, password: "An0therPass!" }, ORIGIN)).status).toBe(400);

    const jar = new Jar();
    expect((await call(jar, "POST", "/auth/login", { email, password: "N3wPassw0rd!" }, ORIGIN)).status).toBe(200);
    expect((await call(jar, "GET", "/me")).body.user.email).toBe(email);
    await call(jar, "POST", "/auth/logout", undefined, ORIGIN);
    expect((await call(jar, "GET", "/me")).status).toBe(401);
  });

  it("blocks cross-site writes (CSRF)", async () => {
    const jar = await signupAndVerify(`csrf-${run}@example.com`, "Csrf Co");
    const evil = await call(jar, "PUT", "/auth/profile", { displayName: "x" }, { origin: "https://evil.example" });
    expect(evil.body.error.code).toBe("CSRF_ORIGIN_REJECTED");
    const noHeader = await app.inject({
      method: "PUT",
      url: "/auth/profile",
      payload: JSON.stringify({ displayName: "x" }),
      headers: { "content-type": "application/json", cookie: jar.header() },
    });
    expect(noHeader.statusCode).toBe(403);
  });

  it("lets an invited new user join only the inviting workspace", async () => {
    const owner = await signupAndVerify(`inv-owner-${run}@example.com`, "Invite Co");
    const seat = await call(owner, "POST", "/invitations", { email: `inv-new-${run}@example.com` });
    expect(seat.body.error.code).toBe("SEAT_LIMIT_EXCEEDED"); // Starter = 1 seat

    const me = await call(owner, "GET", "/me");
    const { applyMockUpgrade } = await import("../../src/lib/subscriptions.js");
    await applyMockUpgrade(me.body.tenant.id, "growth");

    expect((await call(owner, "POST", "/invitations", { email: `inv-new-${run}@example.com` })).status).toBe(200);
    const params = new URLSearchParams(lastLink("accept-invite"));
    const id = params.get("id")!;
    const token = params.get("token")!;

    const preview = await call(null, "GET", `/invitations/${id}/preview?token=${token}`);
    expect(preview.body).toMatchObject({ organizationName: "Invite Co", accountExists: false });

    const member = new Jar();
    const accepted = await call(member, "POST", `/invitations/${id}/accept`, { token, displayName: "Newbie", password: "Newb1ePass!" }, ORIGIN);
    expect(accepted.status).toBe(200);
    const mm = await call(member, "GET", "/me");
    expect(mm.body.tenant.name).toBe("Invite Co");
    expect(mm.body.user.role).toBe("member");
    expect(mm.body.user.organizationCount).toBe(1);

    expect((await call(member, "POST", "/invitations", { email: "x@example.com" })).status).toBe(403);
    expect((await call(member, "POST", `/invitations/${id}/accept`, { token }, ORIGIN)).status).toBe(410); // single use
  });

  it("grants plan credits exactly once per billing period", async () => {
    const jar = await signupAndVerify(`credits-${run}@example.com`, "Credit Co");
    const tenantId = (await call(jar, "GET", "/me")).body.tenant.id as string;
    const { applyMockUpgrade } = await import("../../src/lib/subscriptions.js");
    await applyMockUpgrade(tenantId, "growth");
    await applyMockUpgrade(tenantId, "growth");
    const billing = await call(jar, "GET", "/billing");
    expect(billing.body.plan).toBe("growth");
    expect(billing.body.credits.balance).toBe(500);
    const grants = await db.servicePool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM credit_transactions WHERE tenant_id = $1 AND reason = 'plan_grant'",
      [tenantId],
    );
    expect(grants.rows[0].n).toBe(1);
  });

  it("sends only the latest due reminder for a long-overdue invoice", async () => {
    const jar = await signupAndVerify(`dun-${run}@example.com`, "Dunning Co");
    const templates = await call(jar, "GET", "/templates");
    for (const t of templates.body.templates) await call(jar, "PUT", `/templates/${t.id}`, { approved: true });
    const wf = (await call(jar, "GET", "/workflows")).body.workflows[0];
    await call(jar, "PUT", `/workflows/${wf.id}`, { enabled: true });
    await call(jar, "POST", "/integrations/stripe/dev-event", {
      invoice: { id: `in_dun_${run}`, due_days: -30, customer_email: `ap-${run}@client.example` },
    });

    const { runDunningDetailed } = await import("../../src/modules/workflows/engine.js");
    await runDunningDetailed();
    await runDunningDetailed(); // a second run must not send again

    const tenantId = (await call(jar, "GET", "/me")).body.tenant.id as string;
    const sent = await db.servicePool.query<{ step_index: number }>(
      "SELECT step_index FROM messages WHERE tenant_id = $1 AND status = 'sent' ORDER BY step_index",
      [tenantId],
    );
    expect(sent.rows.map((r) => r.step_index)).toEqual([3]);
    const me = await call(jar, "GET", "/me");
    expect(me.body.tenant.creditBalance).toBe(49);
  });

  it("keeps admin and workspace audiences separate", async () => {
    const admin = new Jar();
    const login = await call(admin, "POST", "/auth/admin/login", { email: process.env.SUPER_ADMIN_EMAIL ?? "admin@autocollect.local", password: process.env.SUPER_ADMIN_PASSWORD ?? "admin123" }, ORIGIN);
    if (login.status !== 200) return; // super admin not seeded in this database
    expect((await call(admin, "GET", "/invoices")).body.error.code).toBe("ADMIN_SESSION");
    expect((await call(admin, "GET", "/admin/stats")).status).toBe(200);
    const tenant = await signupAndVerify(`aud-${run}@example.com`, "Aud Co");
    expect((await call(tenant, "GET", "/admin/stats")).status).toBe(403);
  });
});
