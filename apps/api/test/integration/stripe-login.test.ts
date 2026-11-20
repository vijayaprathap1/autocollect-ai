/**
 * "Continue with Stripe": sign-up / sign-in through Stripe Connect (mock mode),
 * automatic connection + import, identity rules, and the one-click
 * "approve default reminders & start" leading to a real reminder send.
 *
 * Runs only when DATABASE_URL is set (same as the other integration tests).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DB_POOL_MAX = "2";
process.env.WEB_ORIGIN = "http://localhost:5175";
process.env.APP_URL = "http://localhost:4000";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

type App = Awaited<ReturnType<typeof import("../../src/app.js").buildApp>>;
let app: App;
let db: typeof import("../../src/lib/db.js");
let engine: typeof import("../../src/modules/workflows/engine.js");
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
      if (attrs.some((a) => /max-age=0/i.test(a.trim())) || v.join("=") === "") this.cookies.delete(k.trim());
      else this.cookies.set(k.trim(), v.join("="));
    }
  }
}

type Res = { status: number; location: string; body: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(jar: Jar | null, method: "GET" | "POST", url: string, body?: unknown): Promise<Res> {
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
  let parsed: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    parsed = res.body ? JSON.parse(res.body) : {};
  } catch {
    parsed = {};
  }
  return { status: res.statusCode, location: String(res.headers.location ?? ""), body: parsed };
}

/**
 * Run the mock Stripe OAuth round trip in one browser (cookie jar):
 * GET /auth/stripe -> (mock Stripe) -> GET /auth/stripe/callback.
 */
async function continueWithStripe(jar: Jar, dev: { account: string; email: string; name?: string }): Promise<Res> {
  const start = await call(jar, "GET", "/auth/stripe");
  expect(start.status).toBe(302);
  const u = new URL(start.location);
  expect(u.pathname).toBe("/auth/stripe/callback");
  u.searchParams.set("dev_account", dev.account);
  u.searchParams.set("dev_email", dev.email);
  if (dev.name) u.searchParams.set("dev_name", dev.name);
  return call(jar, "GET", `${u.pathname}${u.search}`);
}

function landing(res: Res): URL {
  expect(res.status).toBe(302);
  return new URL(res.location);
}

d("Continue with Stripe", () => {
  beforeAll(async () => {
    const { migrate } = await import("../../src/scripts/migrate.js");
    await migrate();
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      mail.push(args.map(String).join(" "));
    });
    const mod = await import("../../src/app.js");
    db = await import("../../src/lib/db.js");
    engine = await import("../../src/modules/workflows/engine.js");
    app = mod.buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db?.closeDb();
  });

  it("is advertised as a sign-in option", async () => {
    const p = await call(null, "GET", "/auth/providers");
    expect(p.body.stripe).toBe(true);
  });

  const acct = `acct_login_${run}`;
  const email = `stripe-owner-${run}@acme-stripe.example`;
  const owner = new Jar();
  let userId = "";
  let tenantId = "";

  it("signs up a new user: workspace, Stripe connection, identity, session, unverified email", async () => {
    const res = await continueWithStripe(owner, { account: acct, email, name: `Acme ${run}` });
    const to = landing(res);
    expect(to.pathname).toBe("/dashboard");
    expect(to.searchParams.get("welcome")).toBe("stripe");
    expect(to.searchParams.get("imported")).toBe("0"); // mock mode: nothing to import

    const me = await call(owner, "GET", "/me");
    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe("owner");
    tenantId = me.body.tenant.id;
    userId = me.body.user.id;

    const integ = await call(owner, "GET", "/integrations");
    const stripe = (integ.body.integrations as { source: string; status: string; accountId: string }[]).find((i) => i.source === "stripe");
    expect(stripe).toMatchObject({ status: "active", accountId: acct });

    const ident = await db.servicePool.query(`SELECT user_id FROM user_identities WHERE provider = 'stripe' AND subject = $1`, [acct]);
    expect(ident.rows[0].user_id).toBe(userId);

    const u = await db.servicePool.query<{ email_verified_at: string | null; password_hash: string | null }>(
      `SELECT email_verified_at, password_hash FROM users WHERE id = $1`,
      [userId],
    );
    expect(u.rows[0].email_verified_at).toBeNull();
    expect(u.rows[0].password_hash).toBeNull();
    expect(mail.join("\n")).toContain("verify-email?token=");
  });

  it("signs the same user back in with the same Stripe account", async () => {
    const again = new Jar();
    const res = await continueWithStripe(again, { account: acct, email });
    const to = landing(res);
    expect(to.pathname).toBe("/dashboard");
    expect(to.searchParams.get("welcome")).toBeNull(); // already connected: no re-import
    const me = await call(again, "GET", "/me");
    expect(me.body.user.id).toBe(userId);
    expect(me.body.tenant.id).toBe(tenantId);
  });

  it("never links a Stripe account to an existing user by email", async () => {
    const existing = `existing-${run}@example.com`;
    const signup = await call(null, "POST", "/auth/signup", { email: existing, password: "Str0ngPass!", name: "Existing" });
    expect(signup.status).toBe(202);

    const jar = new Jar();
    const res = await continueWithStripe(jar, { account: `acct_hijack_${run}`, email: existing });
    expect(landing(res).searchParams.get("error")).toBe("stripe_email_exists");
    expect((await call(jar, "GET", "/me")).status).toBe(401);
    const ident = await db.servicePool.query(`SELECT 1 FROM user_identities WHERE subject = $1`, [`acct_hijack_${run}`]);
    expect(ident.rowCount).toBe(0);
  });

  it("refuses an account that another workspace already syncs", async () => {
    const taken = `acct_taken_${run}`;
    await db.servicePool.query(
      `INSERT INTO integrations (tenant_id, source, status, credentials, settings)
       VALUES ($1, 'stripe', 'active', $2::jsonb, '{}'::jsonb)
       ON CONFLICT (tenant_id, source) DO UPDATE SET credentials = EXCLUDED.credentials, status = 'active'`,
      [tenantId, JSON.stringify({ stripe_account_id: taken, connected_at: new Date().toISOString() })],
    );
    const jar = new Jar();
    const res = await continueWithStripe(jar, { account: taken, email: `newcomer-${run}@example.com` });
    expect(landing(res).searchParams.get("error")).toBe("stripe_account_in_use");
    // restore the owner's real connection for the next tests
    await db.servicePool.query(
      `UPDATE integrations SET credentials = jsonb_set(credentials, '{stripe_account_id}', to_jsonb($2::text)) WHERE tenant_id = $1 AND source = 'stripe'`,
      [tenantId, acct],
    );
  });

  it("rejects a callback from a different browser (login CSRF)", async () => {
    const victim = new Jar();
    const start = await call(new Jar(), "GET", "/auth/stripe"); // attacker's browser starts
    const u = new URL(start.location);
    u.searchParams.set("dev_account", `acct_csrf_${run}`);
    u.searchParams.set("dev_email", `csrf-${run}@example.com`);
    const res = await call(victim, "GET", `${u.pathname}${u.search}`); // victim has no nonce cookie
    expect(landing(res).searchParams.get("error")).toBe("stripe_state");
    expect(victim.cookies.has("autocollect_session")).toBe(false);
  });

  it("one click approves the default reminders and the next run sends a reminder", async () => {
    const before = await call(owner, "GET", "/me");
    expect(before.body.tenant.workflowEnabled).toBe(false);

    const start = await call(owner, "POST", "/onboarding/start-reminders", {});
    expect(start.status).toBe(200);
    expect(start.body.steps).toBe(4);

    const me = await call(owner, "GET", "/me");
    expect(me.body.tenant.workflowEnabled).toBe(true);
    expect(me.body.tenant.hasUnapprovedTemplates).toBe(false);

    // A Stripe invoice arrives through the Connect webhook for this account.
    const ev = await call(owner, "POST", "/integrations/stripe/dev-event", {
      account: acct,
      type: "invoice.finalized",
      invoice: { id: `in_login_${run}`, customer_email: `payer-${run}@client.example`, customer_name: "Payer", due_days: -9 },
    });
    expect(ev.status).toBe(200);

    await engine.runDunningDetailed(new Date());
    const sent = await db.servicePool.query<{ status: string }>(
      `SELECT m.status FROM messages m JOIN invoices i ON i.id = m.invoice_id
        WHERE i.tenant_id = $1 AND i.external_id = $2`,
      [tenantId, `in_login_${run}`],
    );
    expect(sent.rows[0]?.status).toBe("sent");
    expect(mail.join("\n")).toContain(`payer-${run}@client.example`);
  });
});
