/**
 * Full customer journey, end to end, against a real Postgres (mock providers):
 *
 *   signup -> verify email -> default templates -> approve + enable workflow
 *   -> Stripe Connect (mock) + invoice webhook -> CSV import -> QuickBooks (mock)
 *   -> pay link -> dunning run (emails rendered + sent) -> customer replies
 *   (promise / dispute) -> payments close invoices -> no re-send -> plan upgrade
 *   grants credits -> team invite -> activity log.
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
      if (attrs.some((a) => /max-age=0/i.test(a.trim()))) this.cookies.delete(k.trim());
      else this.cookies.set(k.trim(), v.join("="));
    }
  }
}

type Res = { status: number; headers: Record<string, unknown>; body: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(
  jar: Jar | null,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Res> {
  const raw = typeof body === "string";
  const res = await app.inject({
    method,
    url,
    payload: body === undefined ? undefined : raw ? (body as string) : JSON.stringify(body),
    headers: {
      ...(body === undefined || raw ? {} : { "content-type": "application/json" }),
      ...(jar ? { cookie: jar.header(), "x-requested-with": "test" } : {}),
      ...ORIGIN,
      ...headers,
    },
  });
  jar?.store(res.headers["set-cookie"] as string | string[] | undefined);
  let parsed: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    parsed = res.body ? JSON.parse(res.body) : {};
  } catch {
    parsed = { raw: res.body };
  }
  return { status: res.statusCode, headers: res.headers as Record<string, unknown>, body: parsed };
}

function lastLink(kind: string): string {
  const all = mail.join("\n");
  const m = [...all.matchAll(new RegExp(`${kind}\\?([^\\s"\\\\]+)`, "g"))].pop();
  if (!m) throw new Error(`no ${kind} link captured`);
  return m[1];
}

/** Follow an in-app OAuth redirect (mock Stripe/QBO) back into the API. */
async function followCallback(jar: Jar, url: string): Promise<Res> {
  const u = new URL(url);
  return call(jar, "GET", `${u.pathname}${u.search}`);
}

function csvMultipart(csv: string) {
  const boundary = `----journey${run}`;
  const payload =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="invoices.csv"\r\n` +
    `Content-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`;
  return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

const isoDaysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

d("Customer journey: onboarding to reminder email, reply and payment", () => {
  const owner = new Jar();
  const email = `journey-${run}@example.com`;
  let tenantId = "";
  const ids: Record<string, string> = {};

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

  it("1. signs up, verifies the email and lands in a provisioned workspace", async () => {
    const s = await call(null, "POST", "/auth/signup", {
      email,
      password: "Str0ngPass!",
      name: "Journey Owner",
      organizationName: `Journey Co ${run}`,
    });
    expect(s.status).toBe(202);
    const token = new URLSearchParams(lastLink("verify-email")).get("token")!;
    const v = await call(owner, "POST", "/auth/verify-email", { token });
    expect(v.body.signedIn).toBe(true);

    const me = await call(owner, "GET", "/me");
    expect(me.status).toBe(200);
    tenantId = me.body.tenant.id;
    expect(me.body.user.role).toBe("owner");
    expect(me.body.tenant.plan).toBe("starter");
    expect(me.body.tenant.creditBalance).toBeGreaterThan(0);
  });

  it("2. starts with the default 4-step sequence; templates approve and the workflow enables", async () => {
    const t = await call(owner, "GET", "/templates");
    expect(t.status).toBe(200);
    const templates = t.body.templates as { id: string; stepKey: string; approved: boolean; unknownPlaceholders: string[] }[];
    expect(templates.map((x) => x.stepKey).sort()).toEqual(["reminder_14d", "reminder_1d", "reminder_7d", "reminder_pre"]);
    expect(templates.every((x) => !x.approved)).toBe(true);
    expect(templates.every((x) => x.unknownPlaceholders.length === 0)).toBe(true);

    // AI drafting falls back to deterministic drafts without an API key.
    const draft = await call(owner, "POST", "/templates/draft");
    expect(draft.status).toBe(200);

    for (const tpl of (await call(owner, "GET", "/templates")).body.templates as { id: string }[]) {
      const a = await call(owner, "PUT", `/templates/${tpl.id}`, { approved: true });
      expect(a.status).toBe(200);
    }

    const w = await call(owner, "GET", "/workflows");
    const wf = (w.body.workflows as { id: string; isDefault: boolean; steps: unknown[] }[]).find((x) => x.isDefault)!;
    expect(wf.steps).toHaveLength(4);
    ids.workflow = wf.id;
    const en = await call(owner, "PUT", `/workflows/${wf.id}`, { enabled: true });
    expect(en.status).toBe(200);
    expect(en.body.workflow?.enabled ?? en.body.enabled).toBe(true);
  });

  it("3. connects Stripe (mock OAuth) and ingests an overdue invoice from the webhook simulator", async () => {
    const c = await call(owner, "POST", "/integrations/stripe/connect");
    expect(c.status).toBe(200);
    const cb = await followCallback(owner, c.body.url);
    expect(cb.status).toBe(302);
    expect(String(cb.headers.location)).toContain("stripe=connected");

    const ev = await call(owner, "POST", "/integrations/stripe/dev-event", {
      type: "invoice.finalized",
      invoice: {
        id: `in_journey_${run}`,
        amount_due: 250000,
        currency: "usd",
        customer: `cus_journey_${run}`,
        customer_name: "Stripe Customer",
        customer_email: `stripe-customer-${run}@acme-stripe.example`,
        due_days: -10,
      },
    });
    expect(ev.status).toBe(200);
    expect(ev.body.action).toBe("ingested");
  });

  it("4. imports invoices from CSV with per-row validation errors", async () => {
    const csv = [
      "invoice_number,client_name,client_email,amount,due_date",
      `CSV-${run}-1,CSV Client,csv-client-${run}@acme-csv.example,1500.50,${isoDaysFromNow(-8)}`,
      `CSV-${run}-2,Dispute Client,dispute-${run}@acme-dispute.example,900,${isoDaysFromNow(-9)}`,
      `CSV-${run}-3,Bad Row,bad-${run}@example.com,not-a-number,${isoDaysFromNow(5)}`,
    ].join("\n");
    const m = csvMultipart(csv);
    const r = await call(owner, "POST", "/integrations/csv/import", m.payload, m.headers);
    expect(r.status).toBe(200);
    expect(r.body.imported).toBe(2);
    expect(r.body.failed ?? r.body.errors?.length).toBe(1);
  });

  it("5. connects QuickBooks (mock OAuth) and syncs invoices", async () => {
    const c = await call(owner, "POST", "/integrations/qbo/connect");
    expect(c.status).toBe(200);
    const cb = await followCallback(owner, c.body.url);
    expect(cb.status).toBe(302);
    expect(String(cb.headers.location)).toContain("qbo=connected");

    const s = await call(owner, "POST", "/integrations/qbo/sync");
    expect(s.status).toBe(200);
    expect(s.body.mock).toBe(true);
    expect(s.body.synced).toBeGreaterThan(0);

    const integ = await call(owner, "GET", "/integrations");
    const sources = (integ.body.integrations as { source: string; status: string }[]).map((i) => `${i.source}:${i.status}`);
    expect(sources).toEqual(expect.arrayContaining(["stripe:active", "csv:active", "qbo:active"]));
  });

  it("6. lists all invoices and creates a pay link", async () => {
    const list = await call(owner, "GET", "/invoices?limit=100");
    expect(list.status).toBe(200);
    const invoices = (list.body.invoices ?? list.body.items) as { id: string; source: string; externalId: string; status: string }[];
    expect(new Set(invoices.map((i) => i.source))).toEqual(new Set(["stripe", "csv", "qbo"]));
    ids.stripeInv = invoices.find((i) => i.externalId === `in_journey_${run}`)!.id;
    ids.csvInv = invoices.find((i) => i.externalId === `CSV-${run}-1`)!.id;
    ids.disputeInv = invoices.find((i) => i.externalId === `CSV-${run}-2`)!.id;

    const pl = await call(owner, "POST", `/invoices/${ids.csvInv}/pay-link`);
    expect(pl.status).toBe(200);
    expect(pl.body.paymentLink).toMatch(/^https:\/\//);
    ids.payLink = pl.body.paymentLink;
  });

  it("7. the dunning run sends rendered reminder emails and spends credits", async () => {
    const before = (await call(owner, "GET", "/me")).body.tenant.creditBalance as number;
    const mailBefore = mail.length;
    const res = await engine.runDunningDetailed(new Date());
    expect(res.skippedLease).toBe(false);

    const sent = await db.servicePool.query<{ invoice_id: string; status: string; channel: string; provider_msg_id: string | null }>(
      `SELECT invoice_id, status, channel, provider_msg_id FROM messages WHERE tenant_id = $1`,
      [tenantId],
    );
    const byInvoice = new Map(sent.rows.map((r) => [r.invoice_id, r]));
    for (const key of ["stripeInv", "csvInv", "disputeInv"]) {
      expect(byInvoice.get(ids[key])?.status, `reminder for ${key}`).toBe("sent");
      expect(byInvoice.get(ids[key])?.provider_msg_id).toBeTruthy();
    }

    const out = mail.slice(mailBefore).join("\n");
    if (process.env.JOURNEY_PRINT_MAIL) process.stderr.write(`\n----- captured reminder output -----\n${out.slice(0, 4000)}\n-----\n`);
    expect(out).toContain(`csv-client-${run}@acme-csv.example`);
    expect(out).toContain(ids.payLink); // pay link rendered into the reminder
    expect(out).not.toMatch(/\{(client_name|amount|pay_link|due_date|company_name)\}/); // no unrendered placeholders
    expect(out).not.toMatch(/: *\n/); // no dangling "pay here:" when an invoice has no link
    expect(out).toContain("Reply to this email and we'll send you payment details."); // QBO/CSV invoices without a link

    const after = (await call(owner, "GET", "/me")).body.tenant.creditBalance as number;
    expect(before - after).toBe(sent.rows.filter((r) => r.status === "sent").length);

    // Idempotent: an immediate second run sends nothing new.
    const again = await engine.runDunningDetailed(new Date());
    expect(again.sent).toBe(0);
  });

  it("8. customer replies are classified: promise snoozes, dispute pauses", async () => {
    const promise = await call(owner, "POST", "/integrations/postmark/dev-inbound", {
      invoiceId: ids.csvInv,
      text: "Thanks, we will pay on Friday.",
    });
    expect(promise.status).toBe(200);
    expect(promise.body.classification).toBe("promise");

    const dispute = await call(owner, "POST", "/integrations/postmark/dev-inbound", {
      invoiceId: ids.disputeInv,
      text: "This invoice is wrong, we never received the goods.",
    });
    expect(dispute.status).toBe(200);
    expect(dispute.body.classification).toBe("dispute");

    const disputed = await call(owner, "GET", `/invoices/${ids.disputeInv}`);
    expect((disputed.body.invoice ?? disputed.body).status).toBe("paused");

    const replies = await call(owner, "GET", "/replies");
    expect(replies.status).toBe(200);
    const list = (replies.body.replies ?? replies.body.items) as { classification: string }[];
    expect(list.map((r) => r.classification)).toEqual(expect.arrayContaining(["promise", "dispute"]));
  });

  it("9. payments close invoices and stop reminders", async () => {
    const paid = await call(owner, "POST", "/integrations/stripe/dev-event", { type: "invoice.paid", invoice: { id: `in_journey_${run}` } });
    expect(paid.status).toBe(200);
    expect(paid.body.action).toBe("marked_paid");
    const inv = await call(owner, "GET", `/invoices/${ids.stripeInv}`);
    expect((inv.body.invoice ?? inv.body).status).toBe("paid");

    const mp = await call(owner, "POST", `/invoices/${ids.csvInv}/actions`, { action: "mark_paid" });
    expect(mp.status).toBe(200);

    // Even 30 days later, paid (stripe, csv) and disputed/paused invoices get no further reminder.
    const closed = [ids.stripeInv, ids.csvInv, ids.disputeInv];
    const countClosed = async () =>
      (
        await db.servicePool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1 AND invoice_id = ANY($2::uuid[])`,
          [tenantId, closed],
        )
      ).rows[0].n;
    const before = await countClosed();
    await engine.runDunningDetailed(new Date(Date.now() + 30 * 86_400_000));
    expect(await countClosed()).toBe(before);
  });

  it("10. upgrading the plan (mock checkout) grants the plan's credits", async () => {
    const before = (await call(owner, "GET", "/me")).body.tenant.creditBalance as number;
    const co = await call(owner, "POST", "/billing/checkout", { plan: "growth" });
    expect(co.status).toBe(200);
    const cb = await followCallback(owner, co.body.url);
    expect([200, 302]).toContain(cb.status);
    const me = await call(owner, "GET", "/me");
    expect(me.body.tenant.plan).toBe("growth");
    expect(me.body.tenant.creditBalance).toBeGreaterThan(before);
  });

  it("11. invites a teammate and records the journey in the activity log", async () => {
    const inv = await call(owner, "POST", "/invitations", { email: `teammate-${run}@example.com`, role: "member" });
    expect(inv.status).toBe(200);
    expect(mail.join("\n")).toContain("accept-invite?");

    const act = await call(owner, "GET", "/activity");
    expect(act.status).toBe(200);
    const actions = JSON.stringify(act.body);
    for (const a of ["dunning_sent", "reply_received"]) expect(actions).toContain(a);
  });
});
