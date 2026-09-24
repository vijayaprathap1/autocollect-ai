/**
 * Exercises the code paths a real deployment uses (not the dev simulators):
 *  - brand-new signup gets a working 4-step reminder sequence
 *  - Stripe webhooks verified by signature (real `constructEvent` path)
 *  - the background scheduler sends reminders on its own
 *  - out-of-order / replayed / forged Stripe events
 *  - Payment Link payments close CSV invoices
 *  - Postmark webhook auth + hard bounce pauses the invoice
 *
 * Needs an API started with:
 *   STRIPE_SECRET_KEY=sk_test_dummy STRIPE_WEBHOOK_SECRET=whsec_e2e
 *   POSTMARK_WEBHOOK_TOKEN=pm_e2e DUNNING_SCAN_INTERVAL_MS=2000
 * and API_LOG pointing at its stdout (to read the verification link).
 *
 *   API=http://localhost:4001 API_LOG=/tmp/api2.log DATABASE_URL=... npx tsx scripts/e2e-production-paths.ts
 */
import Stripe from "stripe";
import pg from "pg";
import { readFileSync } from "node:fs";

const API = process.env.API ?? "http://localhost:4001";
const WHSEC = process.env.STRIPE_WEBHOOK_SECRET || "whsec_e2e";
const PM_TOKEN = process.env.POSTMARK_WEBHOOK_TOKEN || "pm_e2e";
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const stripe = new Stripe("sk_test_dummy");

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}  -> expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await db.query(sql, params)).rows[0] as T | undefined;
}

let cookie = "";
async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, headers: res.headers };
}

let evtSeq = 0;
async function stripeEvent(type: string, account: string, object: Record<string, unknown>, opts: { id?: string; badSig?: boolean } = {}) {
  const payload = JSON.stringify({
    id: opts.id ?? `evt_e2e_${Date.now()}_${evtSeq++}`,
    object: "event",
    type,
    account,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: opts.badSig ? "whsec_wrong" : WHSEC });
  return http("POST", "/integrations/stripe/webhook", payload, { "stripe-signature": header });
}

async function main() {
  await db.connect();
  const run = Date.now().toString(36);
  const email = `owner-${run}@example.com`;
  const acct = `acct_e2e_${run}`;

  console.log("== New signup gets a working reminder sequence");
  const su = await http("POST", "/auth/signup", { email, password: "Passw0rd!x", organizationName: `Org ${run}` });
  check("signup ok", su.status, 200);
  await sleep(300);
  const log = readFileSync(process.env.API_LOG ?? "/tmp/api2.log", "utf8");
  const m = log.match(new RegExp(`verification link for ${email.replace(/[.]/g, "\\.")}:\\s+\\S+token=([\\w-]+)`));
  check("verification link issued", Boolean(m), true);
  check("verify email", (await http("POST", "/auth/verify-email", { token: m?.[1] })).status, 200);
  cookie = "";
  check("login", (await http("POST", "/auth/login", { email, password: "Passw0rd!x" })).status, 200);
  const wf = (await http("GET", "/workflows")).json.workflows[0];
  check("default workflow has 4 steps", wf.steps.length, 4);
  check("every step linked to a template", wf.steps.every((s: any) => s.templateId), true);
  const tpls = (await http("GET", "/templates")).json.templates as any[];
  check("4 templates, unapproved", [tpls.length, tpls.every((t) => !t.approved)], [4, true]);
  for (const t of tpls) await http("PUT", `/templates/${t.id}`, { approved: true });
  await http("PUT", `/workflows/${wf.id}`, { enabled: true });
  const me = (await http("GET", "/me")).json;
  const tenantId: string = me.tenant?.id ?? me.tenantId ?? me.user?.tenantId;
  check("has credits", ((await one<{ balance: number }>(`SELECT balance FROM credit_wallets WHERE tenant_id = $1`, [tenantId]))?.balance ?? 0) > 0, true);

  // Real OAuth can't run here; connect the tenant the way the callback does.
  await db.query(
    `INSERT INTO integrations (tenant_id, source, status, credentials)
     VALUES ($1, 'stripe', 'active', $2::jsonb)`,
    [tenantId, JSON.stringify({ stripe_account_id: acct })],
  );

  console.log("== Signed Stripe webhooks");
  const due = Math.floor(Date.now() / 1000) - 3 * 86400; // 3 days overdue -> step 2 (+1d) is due
  const baseInv = {
    object: "invoice", amount_due: 42000, currency: "usd", created: due - 86400,
    customer: `cus_${run}`, customer_name: "Real Customer", customer_email: `payer-${run}@example.com`,
    hosted_invoice_url: "https://invoice.stripe.com/i/test", due_date: due, period_start: due - 86400,
    lines: { data: [{ description: "Consulting", quantity: 1, amount: 42000 }] },
  };
  check("forged signature rejected", (await stripeEvent("invoice.finalized", acct, { ...baseInv, id: `in_x_${run}`, status: "open" }, { badSig: true })).status, 400);
  check("draft invoice.created ignored", (await stripeEvent("invoice.created", acct, { ...baseInv, id: `in_1_${run}`, status: "draft" })).status, 200);
  check("draft not stored", await one(`SELECT 1 FROM invoices WHERE external_id = $1`, [`in_1_${run}`]), undefined);
  check("invoice.finalized accepted", (await stripeEvent("invoice.finalized", acct, { ...baseInv, id: `in_1_${run}`, status: "open" })).status, 200);
  const inv1 = await one<{ id: string; status: string; email: string }>(
    `SELECT i.id, i.status, c.email FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.external_id = $1`, [`in_1_${run}`]);
  check("finalized invoice stored open with customer email", [inv1?.status, inv1?.email], ["open", `payer-${run}@example.com`]);

  console.log("== Scheduler sends on its own (no manual send)");
  let sent: { status: string; provider_msg_id: string } | undefined;
  for (let i = 0; i < 20 && !sent; i++) {
    await sleep(1000);
    sent = await one(`SELECT status, provider_msg_id FROM messages WHERE invoice_id = $1 AND status = 'sent'`, [inv1?.id]);
  }
  check("reminder sent by scheduler", sent?.status, "sent");
  const adv = await one<{ next_step_index: number }>(`SELECT next_step_index FROM invoices WHERE id = $1`, [inv1?.id]);
  check("sequence advanced past sent step", (adv?.next_step_index ?? 0) >= 1, true);

  console.log("== Postmark webhook");
  check("no token -> 401", (await http("POST", "/email/webhook/postmark", { RecordType: "Delivery", MessageID: sent?.provider_msg_id })).status, 401);
  check("with token -> 200", (await http("POST", `/email/webhook/postmark?token=${PM_TOKEN}`, { RecordType: "Delivery", MessageID: sent?.provider_msg_id })).status, 200);
  check("delivered", (await one<{ status: string }>(`SELECT status FROM messages WHERE provider_msg_id = $1`, [sent?.provider_msg_id]))?.status, "delivered");
  await http("POST", `/email/webhook/postmark?token=${PM_TOKEN}`, { RecordType: "Bounce", Type: "HardBounce", MessageID: sent?.provider_msg_id });
  check("hard bounce -> message bounced", (await one<{ status: string }>(`SELECT status FROM messages WHERE provider_msg_id = $1`, [sent?.provider_msg_id]))?.status, "bounced");
  check("hard bounce -> invoice paused", (await one<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [inv1?.id]))?.status, "paused");
  await stripeEvent("invoice.updated", acct, { ...baseInv, id: `in_1_${run}`, status: "open" });
  check("Stripe 'open' update does not un-pause", (await one<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [inv1?.id]))?.status, "paused");

  console.log("== Payment, ordering, replay, void");
  await stripeEvent("invoice.finalized", acct, { ...baseInv, id: `in_2_${run}`, status: "open" });
  const paidEvt = `evt_paid_${run}`;
  check("invoice.paid", (await stripeEvent("invoice.paid", acct, { ...baseInv, id: `in_2_${run}`, status: "paid" }, { id: paidEvt })).status, 200);
  check("paid", (await one<{ status: string }>(`SELECT status FROM invoices WHERE external_id = $1`, [`in_2_${run}`]))?.status, "paid");
  await stripeEvent("invoice.updated", acct, { ...baseInv, id: `in_2_${run}`, status: "open" });
  check("late 'open' update does not reopen paid invoice", (await one<{ status: string }>(`SELECT status FROM invoices WHERE external_id = $1`, [`in_2_${run}`]))?.status, "paid");
  check("replayed event accepted (idempotent)", (await stripeEvent("invoice.paid", acct, { ...baseInv, id: `in_2_${run}`, status: "paid" }, { id: paidEvt })).status, 200);
  await stripeEvent("invoice.finalized", acct, { ...baseInv, id: `in_3_${run}`, status: "open" });
  await stripeEvent("invoice.voided", acct, { ...baseInv, id: `in_3_${run}`, status: "void" });
  check("invoice.voided stops chasing", (await one<{ status: string }>(`SELECT status FROM invoices WHERE external_id = $1`, [`in_3_${run}`]))?.status, "void");
  await stripeEvent("invoice.finalized", acct, { ...baseInv, id: `in_4_${run}`, status: "open" });
  const otherBefore = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM invoices WHERE tenant_id <> $1 AND last_payment_failure_code IS NOT NULL`, [tenantId]);
  await stripeEvent("invoice.payment_failed", acct, { ...baseInv, id: `in_4_${run}`, status: "open", last_payment_error: { message: "Your card was declined.", code: "card_declined" } });
  const pf = await one<{ status: string; last_payment_failure_code: string }>(`SELECT status, last_payment_failure_code FROM invoices WHERE external_id = $1`, [`in_4_${run}`]);
  check("payment_failed recorded, invoice stays open", [pf?.status, pf?.last_payment_failure_code], ["open", "card_declined"]);
  const otherAfter = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM invoices WHERE tenant_id <> $1 AND last_payment_failure_code IS NOT NULL`, [tenantId]);
  check("payment_failed touched no other tenant", otherAfter?.n, otherBefore?.n);

  console.log("== Payment Link payment closes a CSV invoice");
  const csvInv = await one<{ id: string }>(
    `INSERT INTO invoices (tenant_id, external_id, source, amount_due, currency, status, workflow_id)
     VALUES ($1, $2, 'csv', 10000, 'usd', 'open', (SELECT id FROM workflows WHERE tenant_id = $1 AND is_default LIMIT 1))
     RETURNING id`, [tenantId, `CSV-${run}`]);
  await stripeEvent("checkout.session.completed", acct, {
    object: "checkout.session", id: `cs_${run}`, payment_status: "paid", payment_link: `plink_${run}`,
    metadata: { autocollect_invoice_id: csvInv!.id },
  });
  check("CSV invoice marked paid", (await one<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [csvInv!.id]))?.status, "paid");

  console.log("== Unknown connected account is ignored safely");
  check("unknown account -> 200 ignored", (await stripeEvent("invoice.paid", "acct_nobody", { ...baseInv, id: "in_nobody", status: "paid" })).json?.ignored, "unknown_account");

  await db.end();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
