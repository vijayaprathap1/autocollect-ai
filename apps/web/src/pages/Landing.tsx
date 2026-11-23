import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import "@fontsource-variable/inter";
import { fetchMe } from "@/lib/api";
import { cn } from "@/components/ui";
import { Logo, SiteFooter, btnGhost, btnInverse, btnOnDark, btnPrimary } from "@/components/marketing";

/**
 * Public marketing page at "/". Everything it claims mirrors real behaviour:
 * the reminder sequence is the default workflow, the reply outcomes are the
 * inbound service's, the platform cards are shipped modules, and PLANS
 * matches apps/api/src/lib/billing.ts.
 */

// Keep in sync with PLANS in apps/api/src/lib/billing.ts.
const PLANS = [
  { name: "Starter", price: 0, blurb: "Try it on real invoices.", features: ["50 open invoices", "50 reminders a month", "1 seat"], cta: "Start free" },
  { name: "Growth", price: 29, blurb: "For a growing client list.", features: ["Unlimited invoices", "500 reminders a month", "3 seats"], cta: "Start with Growth", featured: true },
  { name: "Pro", price: 59, blurb: "For a finance team that invoices daily.", features: ["Unlimited invoices", "2,000 reminders a month", "Unlimited seats"], cta: "Start with Pro" },
  { name: "Agency", price: 199, blurb: "Collect on behalf of clients.", features: ["Unlimited invoices", "10,000 reminders a month", "Unlimited seats", "White-label branding"], cta: "Start with Agency" },
];

// The default sequence every workspace starts with (days relative to the due date).
const SEQUENCE = [
  { day: "2 days before", tone: "Heads-up", subject: "Quick heads-up: invoice $4,800.00 coming due" },
  { day: "1 day after", tone: "Now due", subject: "Invoice $4,800.00 is now due" },
  { day: "7 days after", tone: "Past due", subject: "Reminder: invoice $4,800.00 from Harbor & Pine" },
  { day: "14 days after", tone: "Overdue", subject: "Overdue: invoice $4,800.00 (Harbor & Pine)" },
];

const FAQS = [
  {
    q: "Will this annoy my customers?",
    a: "It is built not to. Reminders go out at the hour you choose, in your timezone, and can skip weekends. Two reminders are never sent less than about a day apart, and an invoice that arrives already long overdue gets one relevant reminder instead of the whole backlog.",
  },
  {
    q: "What happens when a customer pays?",
    a: "Reminders stop. A paid invoice in Stripe, a completed payment link, a zero balance in QuickBooks, a matched bank receipt or you marking it paid all end the sequence for that invoice.",
  },
  {
    q: "Can I change what the emails say?",
    a: "Yes. Every workspace starts with four editable templates, and nothing is sent until you have approved them. You can change the wording, the timing and the number of steps.",
  },
  {
    q: "What does the AI actually do?",
    a: "It reads replies to your reminders and sorts them into a dispute, a promise to pay or a question, then drafts a suggested response. A dispute pauses reminders and a promise snoozes them until the day after the promised date. The draft is only ever a suggestion: you decide what gets sent.",
  },
  {
    q: "My clients pay in different currencies. Does that work?",
    a: "Yes. Every invoice keeps its own currency, whether it comes from Stripe, QuickBooks or a currency column in your CSV, and reminders show the amount in that currency. Plans themselves are billed in US dollars.",
  },
  {
    q: "Do I need to talk to sales or book a demo?",
    a: "No. You can sign up, import invoices and send your first reminder on the free plan without speaking to anyone. If you do have a question, email us and a person will answer.",
  },
  {
    q: "What is a reminder credit?",
    a: "One credit is one reminder sent. Each plan includes a monthly allowance, and a reminder that fails to send is retried rather than charged twice.",
  },
  {
    q: "How is my data protected?",
    a: "Each workspace is isolated at the database level with Postgres row-level security, passwords are hashed with argon2id, and integration tokens are encrypted at rest. Sessions are server-side, so you can see and revoke them per device. Data is stored in the United States; the Privacy Policy lists every provider involved.",
  },
];

// ─── Small building blocks ───────────────────────────────────────────────────

function Icon({ d, className }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("h-5 w-5", className)} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const ICONS = {
  check: "M5 12.5l4.5 4.5L19 7.5",
  clock: "M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  link: "M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1",
  stop: "M9 9h6v6H9zM21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  layers: "M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5",
  mail: "M4 6h16v12H4zM4 7l8 6 8-6",
  team: "M16 19v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M9.5 10a3 3 0 100-6 3 3 0 000 6zM21 19v-1a4 4 0 00-3-3.9M15.5 4.1a3 3 0 010 5.8",
  arrow: "M5 12h14M13 6l6 6-6 6",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.8 2.8M14.9 14.9l2.8 2.8M6.3 17.7l2.8-2.8M14.9 9.1l2.8-2.8",
  list: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  cash: "M3 7h18v10H3zM12 15a3 3 0 100-6 3 3 0 000 6zM6 10v.01M18 14v.01",
  gauge: "M12 14l4-4M3.5 17a9 9 0 1117 0",
  chart: "M4 19h16M7 15l3-4 3 2 4-6",
  shield: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3zM9 12l2 2 4-4",
  key: "M15 7a4 4 0 11-3.9 4.9L4 19v2h3v-2h2v-2h2l1.1-1.1A4 4 0 0115 7z",
  globe: "M21 12a9 9 0 11-18 0 9 9 0 0118 0zM3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z",
};

/** Fades content up as it scrolls into view; fully visible without JS motion support. */
function Reveal({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      style={{ transitionDelay: `${delay}ms` }}
      className={cn(
        "transition-all duration-700 ease-out motion-reduce:translate-y-0 motion-reduce:opacity-100 motion-reduce:transition-none",
        shown ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

function SectionHeading({ eyebrow, title, lead, light = false }: { eyebrow: string; title: ReactNode; lead?: string; light?: boolean }) {
  return (
    <Reveal className="mx-auto max-w-2xl text-center">
      <p className={cn("text-xs font-semibold uppercase tracking-[0.16em]", light ? "text-sky-300" : "text-primary")}>{eyebrow}</p>
      <h2 className={cn("mt-3 font-display text-3xl font-semibold leading-tight tracking-tight sm:text-4xl", light ? "text-white" : "text-navy")}>{title}</h2>
      {lead && <p className={cn("mt-4 text-base leading-relaxed sm:text-lg", light ? "text-slate-300" : "text-slate-600")}>{lead}</p>}
    </Reveal>
  );
}

// ─── Hero visual: the collections overview, with one invoice's story ─────────

function ThreadRow({ delay, children }: { delay: number; children: ReactNode }) {
  return (
    <li style={{ animationDelay: `${delay}ms` }} className="relative animate-rise pl-6 motion-reduce:animate-none">
      {children}
    </li>
  );
}

function Dot({ className }: { className: string }) {
  return <span className={cn("absolute left-0 top-1 h-2.5 w-2.5 rounded-full ring-4 ring-white", className)} aria-hidden="true" />;
}

function ProductPreview() {
  const kpis = [
    { label: "Outstanding", value: "$482,900", tone: "text-navy" },
    { label: "Overdue", value: "$96,400", tone: "text-red-600" },
    { label: "Recovered (30d)", value: "$138,250", tone: "text-emerald-600" },
    { label: "Avg DSO", value: "31 days", tone: "text-navy" },
  ];
  const aging = [
    { label: "0–30 days", width: "78%" },
    { label: "31–60 days", width: "46%" },
    { label: "61–90 days", width: "22%" },
    { label: "90+ days", width: "12%" },
  ];
  return (
    <figure className="relative mx-auto w-full max-w-xl">
      <div className="absolute -inset-6 -z-10 rounded-[2rem] bg-sky-400/20 blur-3xl" aria-hidden="true" />
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-white shadow-[0_30px_80px_-24px_rgba(2,8,23,0.65)]">
        {/* Window chrome */}
        <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
          <span className="ml-3 text-xs font-medium text-slate-500">Collections overview</span>
        </div>

        <div className="grid grid-cols-2 gap-px bg-slate-200 sm:grid-cols-4">
          {kpis.map((k) => (
            <div key={k.label} className="bg-white px-4 py-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{k.label}</p>
              <p className={cn("mt-1 text-lg font-semibold tabular-nums", k.tone)}>{k.value}</p>
            </div>
          ))}
        </div>

        <div className="grid gap-5 p-4 sm:grid-cols-[1fr_1.1fr]">
          <div>
            <p className="text-xs font-semibold text-navy">Aging</p>
            <ul className="mt-3 space-y-2.5">
              {aging.map((a, i) => (
                <li key={a.label}>
                  <p className="text-[11px] text-slate-500">{a.label}</p>
                  <div className="mt-1 h-1.5 rounded-full bg-slate-100">
                    <div className={cn("h-full rounded-full", ["bg-sky-500", "bg-amber-400", "bg-orange-500", "bg-red-500"][i])} style={{ width: a.width }} />
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-xl border border-slate-200 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-medium text-slate-500">INV-1042 · Harbor &amp; Pine</p>
              <span
                style={{ animationDelay: "2400ms" }}
                className="inline-flex animate-rise items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200 motion-reduce:animate-none"
              >
                <Icon d={ICONS.check} className="h-3 w-3" /> Paid
              </span>
            </div>
            <ol className="relative mt-3 space-y-3 before:absolute before:bottom-1 before:left-[4.5px] before:top-1 before:w-px before:bg-slate-200">
              <ThreadRow delay={300}>
                <Dot className="bg-slate-400" />
                <p className="text-[11px] text-slate-500">Reminder sent · 1 day after due</p>
              </ThreadRow>
              <ThreadRow delay={900}>
                <Dot className="bg-primary" />
                <p className="text-[11px] text-slate-500">Customer replied</p>
                <p className="mt-1 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs text-slate-700">&ldquo;We&rsquo;ll pay this on Friday.&rdquo;</p>
              </ThreadRow>
              <ThreadRow delay={1500}>
                <Dot className="bg-violet-500" />
                <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                  <span className="rounded bg-violet-50 px-1.5 py-0.5 font-semibold text-violet-700 ring-1 ring-violet-200">Promise to pay</span>
                  reminders snoozed
                </p>
              </ThreadRow>
              <ThreadRow delay={2400}>
                <Dot className="bg-emerald-500" />
                <p className="text-[11px] font-medium text-emerald-700">Paid via link · sequence stopped</p>
              </ThreadRow>
            </ol>
          </div>
        </div>
      </div>
      <figcaption className="mt-3 text-center text-xs text-slate-400">Illustration with sample figures</figcaption>
    </figure>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function Landing() {
  // Signed-in visitors keep the page but get a way back into the app.
  const { data } = useQuery({ queryKey: ["me"], queryFn: fetchMe, retry: false, staleTime: 30_000 });
  const signedIn = Boolean(data?.user);
  const appHref = data?.user?.sessionType === "admin" ? "/admin" : "/dashboard";
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    document.title = "AutoCollect AI — Accounts receivable on autopilot";
  }, []);

  const navLinks = [
    { href: "#platform", label: "Platform" },
    { href: "#how-it-works", label: "How it works" },
    { href: "#replies", label: "AI replies" },
    { href: "#security", label: "Security" },
    { href: "#pricing", label: "Pricing" },
    { href: "#faq", label: "FAQ" },
  ];

  return (
    <div className="min-h-screen scroll-smooth bg-white font-display text-ink [&_section]:scroll-mt-20">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:shadow">
        Skip to content
      </a>

      {/* Navigation */}
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
        <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5" aria-label="Main">
          <Link to="/" aria-label="AutoCollect AI home">
            <Logo />
          </Link>
          <div className="hidden items-center gap-7 lg:flex">
            {navLinks.map((l) => (
              <a key={l.href} href={l.href} className="text-sm font-medium text-slate-600 transition-colors hover:text-navy">
                {l.label}
              </a>
            ))}
          </div>
          <div className="hidden items-center gap-3 lg:flex">
            {!signedIn && (
              <Link to="/login" className="px-2 text-sm font-semibold text-navy hover:text-primary">
                Sign in
              </Link>
            )}
            <Link to={signedIn ? appHref : "/signup"} className={cn(btnPrimary, "px-4 py-2")}>
              {signedIn ? "Open dashboard" : "Start free"}
            </Link>
          </div>
          <button
            type="button"
            className="rounded-md p-2 text-navy lg:hidden"
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <Icon d={menuOpen ? "M6 6l12 12M18 6L6 18" : "M4 7h16M4 12h16M4 17h16"} className="h-6 w-6" />
          </button>
        </nav>
        {menuOpen && (
          <div id="mobile-menu" className="border-t border-slate-200 bg-white px-5 py-4 lg:hidden">
            <div className="flex flex-col gap-1">
              {navLinks.map((l) => (
                <a key={l.href} href={l.href} onClick={() => setMenuOpen(false)} className="rounded-md px-2 py-2.5 text-sm font-medium text-navy hover:bg-slate-50">
                  {l.label}
                </a>
              ))}
            </div>
            <div className="mt-3 flex gap-3">
              {!signedIn && (
                <Link to="/login" className={cn(btnGhost, "flex-1 py-2.5")}>
                  Sign in
                </Link>
              )}
              <Link to={signedIn ? appHref : "/signup"} className={cn(btnPrimary, "flex-1 py-2.5")}>
                {signedIn ? "Open dashboard" : "Start free"}
              </Link>
            </div>
          </div>
        )}
      </header>

      <main id="main">
        {/* Hero */}
        <section className="relative overflow-hidden bg-navy">
          <div
            className="pointer-events-none absolute inset-0 opacity-50 [background-image:linear-gradient(rgba(148,163,184,0.09)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.09)_1px,transparent_1px)] [background-size:44px_44px] [mask-image:radial-gradient(ellipse_at_top,black,transparent_75%)]"
            aria-hidden="true"
          />
          <div className="pointer-events-none absolute -top-40 right-0 h-[520px] w-[720px] rounded-full bg-blue-600/25 blur-3xl" aria-hidden="true" />
          <div className="relative mx-auto grid max-w-7xl items-center gap-14 px-5 pb-20 pt-16 sm:pt-24 lg:grid-cols-[1fr_1.05fr] lg:pb-28">
            <div>
              <p className="inline-flex animate-rise items-center gap-2 rounded-full border border-sky-400/30 bg-sky-400/10 px-3 py-1 text-xs font-semibold text-sky-200 motion-reduce:animate-none">
                <Icon d={ICONS.spark} className="h-3.5 w-3.5" /> Accounts receivable automation
              </p>
              <h1
                style={{ animationDelay: "80ms" }}
                className="mt-5 animate-rise text-[2.6rem] font-semibold leading-[1.06] tracking-tight text-white motion-reduce:animate-none sm:text-[3.4rem]"
              >
                Stop chasing invoices. <span className="block text-sky-300">Run collections on autopilot.</span>
              </h1>
              <p style={{ animationDelay: "160ms" }} className="mt-6 max-w-xl animate-rise text-lg leading-relaxed text-slate-300 motion-reduce:animate-none">
                AutoCollect sends well-timed payment reminders with a one-click payment link, reads every reply with AI, and gives your finance team one
                place to work disputes, promises, cash and credit.
              </p>
              <div style={{ animationDelay: "240ms" }} className="mt-8 flex animate-rise flex-wrap items-center gap-3 motion-reduce:animate-none">
                {signedIn ? (
                  <Link to={appHref} className={btnInverse}>
                    Open dashboard <Icon d={ICONS.arrow} className="h-4 w-4" />
                  </Link>
                ) : (
                  <Link to="/signup" className={btnInverse}>
                    Start free <Icon d={ICONS.arrow} className="h-4 w-4" />
                  </Link>
                )}
                <a href="#how-it-works" className={btnOnDark}>
                  See how it works
                </a>
              </div>
              <ul style={{ animationDelay: "320ms" }} className="mt-8 flex animate-rise flex-wrap gap-x-6 gap-y-2 text-sm text-slate-300 motion-reduce:animate-none">
                {["Free up to 50 open invoices", "No card, no demo call", "Live in minutes"].map((t) => (
                  <li key={t} className="inline-flex items-center gap-2">
                    <Icon d={ICONS.check} className="h-4 w-4 text-emerald-400" /> {t}
                  </li>
                ))}
              </ul>
            </div>
            <ProductPreview />
          </div>
        </section>

        {/* Integrations strip */}
        <section aria-label="Works with" className="border-b border-slate-200 bg-slate-50">
          <div className="mx-auto flex max-w-7xl flex-col items-center gap-4 px-5 py-7 sm:flex-row sm:justify-between">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Brings invoices in from</p>
            <ul className="flex flex-wrap items-center justify-center gap-x-10 gap-y-3 text-base font-semibold text-slate-500">
              {["Stripe", "QuickBooks Online", "CSV import", "Bank receipts"].map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
        </section>

        {/* Platform */}
        <section id="platform" className="py-20 sm:py-28">
          <div className="mx-auto max-w-7xl px-5">
            <SectionHeading
              eyebrow="The platform"
              title="Everything between “invoice sent” and “cash in the bank”"
              lead="One workspace for the whole receivables cycle, from the first reminder to the reconciled payment."
            />
            <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {[
                { icon: ICONS.mail, title: "Automated dunning", body: "Multi-step email and SMS sequences sent in your customer’s working hours, with a payment link in every message." },
                { icon: ICONS.spark, title: "AI reply triage", body: "Replies are classified as a dispute, a promise to pay or a question, and a response is drafted for you to approve." },
                { icon: ICONS.list, title: "Collector worklist", body: "A daily queue ranked by risk, with disputes, promises, tasks and saved filters so nothing slips." },
                { icon: ICONS.cash, title: "Cash application", body: "Import bank receipts, get suggested matches to open invoices and apply payments in a couple of clicks." },
                { icon: ICONS.gauge, title: "Credit management", body: "Set credit limits per customer, review accounts that need attention and hold reminders on accounts on hold." },
                { icon: ICONS.chart, title: "Forecast & analytics", body: "Expected cash by week or month, DSO, collection effectiveness, aging and promise-kept rates." },
              ].map((f, i) => (
                <Reveal key={f.title} delay={(i % 3) * 80} className="group h-full rounded-2xl border border-slate-200 bg-white p-6 transition-shadow hover:shadow-[0_18px_40px_-24px_rgba(15,23,42,0.35)]">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Icon d={f.icon} />
                  </span>
                  <h3 className="mt-4 text-base font-semibold text-navy">{f.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-slate-600">{f.body}</p>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* How it works */}
        <section id="how-it-works" className="border-y border-slate-200 bg-slate-50 py-20 sm:py-28">
          <div className="mx-auto max-w-7xl px-5">
            <SectionHeading
              eyebrow="How it works"
              title="Set it up once. It follows up until the invoice is paid."
              lead="Three steps, and you approve every word before anything is sent."
            />
            <ol className="mt-14 grid gap-5 md:grid-cols-3">
              {[
                {
                  title: "Connect your invoices",
                  body: "Connect Stripe or QuickBooks and open invoices import and stay in sync. Prefer a spreadsheet? Upload a CSV; re-uploading updates what is already there.",
                },
                {
                  title: "Approve your reminders",
                  body: "You start with four ready-made templates. Edit the wording and timing to match your brand, then approve them. Nothing sends until you do.",
                },
                {
                  title: "Let it run",
                  body: "Reminders go out on schedule with a payment link. Replies are read and routed. The moment an invoice is paid, its sequence stops.",
                },
              ].map((s, i) => (
                <li key={s.title}>
                  <Reveal delay={i * 90} className="h-full rounded-2xl border border-slate-200 bg-white p-6">
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-navy text-sm font-semibold text-white">{i + 1}</span>
                    <h3 className="mt-4 text-lg font-semibold text-navy">{s.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-slate-600">{s.body}</p>
                  </Reveal>
                </li>
              ))}
            </ol>

            {/* The default sequence */}
            <Reveal className="mt-10 rounded-2xl border border-slate-200 bg-white p-6 sm:p-8">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-lg font-semibold text-navy">The default sequence</h3>
                <p className="text-sm text-slate-500">Polite first, firmer later. Every step is editable.</p>
              </div>
              <ol className="relative mt-8 grid gap-6 md:grid-cols-4 md:gap-4">
                <span className="absolute left-[5px] top-2 hidden h-px w-[calc(100%-10px)] bg-gradient-to-r from-sky-300 via-amber-300 to-red-300 md:block" aria-hidden="true" />
                {SEQUENCE.map((s, i) => (
                  <li key={s.day} className="relative pl-6 md:pl-0 md:pt-7">
                    <span
                      className={cn("absolute left-0 top-1.5 h-3 w-3 rounded-full ring-4 ring-white md:top-0.5", ["bg-sky-500", "bg-amber-400", "bg-orange-500", "bg-red-500"][i])}
                      aria-hidden="true"
                    />
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{s.day}</p>
                    <p className="mt-1 text-sm font-semibold text-navy">{s.tone}</p>
                    <p className="mt-1 text-sm leading-snug text-slate-600">&ldquo;{s.subject}&rdquo;</p>
                  </li>
                ))}
              </ol>
            </Reveal>
          </div>
        </section>

        {/* Reply handling */}
        <section id="replies" className="py-20 sm:py-28">
          <div className="mx-auto max-w-7xl px-5">
            <SectionHeading
              eyebrow="AI reply handling"
              title="Reminder tools send. This one also listens."
              lead="When a customer replies to a reminder, AutoCollect reads it, sorts it and acts on it, so you never nudge someone who already answered."
            />
            <div className="mt-14 grid gap-5 lg:grid-cols-3">
              {[
                {
                  quote: "The total doesn’t match our PO. Can you check?",
                  tag: "Dispute",
                  tagClass: "bg-red-50 text-red-700 ring-red-200",
                  outcome: "Reminders pause and your team is notified, so nobody chases an invoice that is being questioned.",
                },
                {
                  quote: "Approved on our side. Payment goes out on the 14th.",
                  tag: "Promise to pay",
                  tagClass: "bg-violet-50 text-violet-700 ring-violet-200",
                  outcome: "Reminders snooze until the day after the promised date, then resume only if it is still unpaid.",
                },
                {
                  quote: "Could you resend the invoice as a PDF?",
                  tag: "Question",
                  tagClass: "bg-sky-50 text-sky-700 ring-sky-200",
                  outcome: "A suggested response is drafted in your reply inbox, ready for you to edit and send.",
                },
              ].map((r, i) => (
                <Reveal key={r.tag} delay={i * 90} className="flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-6">
                  <p className="rounded-xl rounded-tl-sm bg-slate-100 px-4 py-3 text-sm leading-relaxed text-slate-800">&ldquo;{r.quote}&rdquo;</p>
                  <div className="my-4 flex items-center gap-2 text-xs text-slate-500">
                    <span className="h-px flex-1 bg-slate-200" />
                    classified as
                    <span className={cn("rounded-md px-2 py-0.5 text-xs font-semibold ring-1", r.tagClass)}>{r.tag}</span>
                    <span className="h-px flex-1 bg-slate-200" />
                  </div>
                  <p className="text-sm leading-relaxed text-slate-600">{r.outcome}</p>
                </Reveal>
              ))}
            </div>
            <Reveal className="mx-auto mt-8 max-w-2xl text-center text-sm text-slate-500">
              You stay in control: the AI classifies and drafts, and a person decides what is sent back.
            </Reveal>
          </div>
        </section>

        {/* Security */}
        <section id="security" className="bg-navy py-20 sm:py-28">
          <div className="mx-auto max-w-7xl px-5">
            <SectionHeading
              light
              eyebrow="Security & control"
              title="Built for finance data from the database up"
              lead="The controls a finance or IT reviewer asks about first are part of the product, not an add-on."
            />
            <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {[
                { icon: ICONS.layers, title: "Tenant isolation", body: "Every workspace is separated by Postgres row-level security, enforced on every query." },
                { icon: ICONS.key, title: "Two-factor sign-in", body: "Authenticator-app codes with recovery codes, plus Google sign-in and per-device session revocation." },
                { icon: ICONS.team, title: "Role-based access", body: "Owner, admin, manager, collector and viewer roles decide who can send, edit and approve." },
                { icon: ICONS.list, title: "Activity log", body: "Every reminder, reply and change is recorded, so you can see who did what and when." },
                { icon: ICONS.shield, title: "Encrypted credentials", body: "Integration tokens are encrypted at rest and passwords are hashed with argon2id." },
                { icon: ICONS.globe, title: "Privacy tooling", body: "Export a workspace’s data or delete it on request, with no advertising or tracking cookies." },
              ].map((f, i) => (
                <Reveal key={f.title} delay={(i % 3) * 80} className="h-full rounded-2xl border border-white/10 bg-white/[0.04] p-6">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-sky-400/15 text-sky-300">
                    <Icon d={f.icon} />
                  </span>
                  <h3 className="mt-4 text-base font-semibold text-white">{f.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-slate-300">{f.body}</p>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* Details */}
        <section className="py-20 sm:py-28">
          <div className="mx-auto max-w-7xl px-5">
            <SectionHeading eyebrow="The details" title="Considerate by design" lead="The small rules that keep automated follow-up from feeling automated." />
            <div className="mt-14 grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
              {[
                { icon: ICONS.clock, title: "Their working hours", body: "Choose the timezone and send hour and skip weekends, so reminders arrive at the start of your customer’s day." },
                { icon: ICONS.globe, title: "Their currency", body: "Each invoice is tracked and chased in the currency it was issued in, whatever its source." },
                { icon: ICONS.link, title: "One click to pay", body: "Every reminder carries a payment link, so settling the invoice takes less effort than replying to it." },
                { icon: ICONS.stop, title: "Stops when they pay", body: "Payment in Stripe, a completed payment link, a zero QuickBooks balance or “Mark paid” ends the sequence." },
                { icon: ICONS.layers, title: "Never a pile-on", body: "Reminders are at least about a day apart, and a long-overdue import gets one relevant message, not four at once." },
                { icon: ICONS.mail, title: "Bad addresses handled", body: "Hard bounces, spam complaints and unsubscribes pause the invoice instead of sending into the void." },
              ].map((f, i) => (
                <Reveal key={f.title} delay={(i % 3) * 80} className="flex gap-4">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Icon d={f.icon} />
                  </span>
                  <div>
                    <h3 className="text-base font-semibold text-navy">{f.title}</h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{f.body}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* Comparison */}
        <section className="border-y border-slate-200 bg-slate-50 py-20 sm:py-28">
          <div className="mx-auto max-w-5xl px-5">
            <SectionHeading
              eyebrow="How it compares"
              title="More than a reminder. Less overhead than a finance suite."
              lead="Enterprise receivables suites are sold on demo calls and long rollouts. Built-in invoice reminders send and hope. AutoCollect sits in between."
            />
            <Reveal className="mt-12 overflow-x-auto rounded-2xl border border-slate-200 bg-white">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                    <th scope="col" className="px-5 py-4 font-semibold"><span className="sr-only">Capability</span></th>
                    <th scope="col" className="px-5 py-4 font-semibold">Chasing by hand</th>
                    <th scope="col" className="px-5 py-4 font-semibold">Built-in invoice reminders</th>
                    <th scope="col" className="bg-primary/[0.07] px-5 py-4 font-semibold text-primary">AutoCollect AI</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {[
                    ["Follows up on schedule", "When you remember", "Yes", "Yes"],
                    ["Stops when the invoice is paid", "You have to check", "Usually", "Yes"],
                    ["Reads the customer’s reply", "You do", "Rarely", "Yes"],
                    ["Pauses when an invoice is disputed", "If you see it in time", "Rarely", "Yes"],
                    ["Waits for a promised payment date", "If you remember", "Rarely", "Yes"],
                    ["Matches bank receipts to invoices", "In a spreadsheet", "No", "Yes"],
                    ["Getting started", "Nothing to set up", "A setting to switch on", "Self-serve, free plan"],
                  ].map(([cap, hand, basic, ours]) => (
                    <tr key={cap}>
                      <th scope="row" className="px-5 py-3.5 font-medium text-navy">{cap}</th>
                      <td className="px-5 py-3.5 text-slate-500">{hand}</td>
                      <td className="px-5 py-3.5 text-slate-500">{basic}</td>
                      <td className="bg-primary/[0.07] px-5 py-3.5 font-semibold text-navy">
                        <span className="inline-flex items-center gap-1.5">
                          <Icon d={ICONS.check} className="h-4 w-4 text-emerald-600" />
                          {ours}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Reveal>
            <p className="mt-4 text-center text-xs text-slate-500">
              &ldquo;Built-in invoice reminders&rdquo; describes the reminder settings typical of invoicing tools; features vary by product.
            </p>
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="py-20 sm:py-28">
          <div className="mx-auto max-w-7xl px-5">
            <SectionHeading eyebrow="Pricing" title="Start free. Upgrade when it is paying for itself." lead="One reminder sent uses one credit. Change or cancel your plan at any time." />
            <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {PLANS.map((p, i) => (
                <Reveal
                  key={p.name}
                  delay={i * 70}
                  className={cn(
                    "flex h-full flex-col rounded-2xl border p-6",
                    p.featured ? "border-primary bg-white shadow-[0_24px_50px_-26px_rgba(29,78,216,0.6)] ring-1 ring-primary" : "border-slate-200 bg-white",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <h3 className="text-base font-semibold text-navy">{p.name}</h3>
                    {p.featured && <span className="rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-semibold text-white">Most popular</span>}
                  </div>
                  <p className="mt-4 flex items-baseline gap-1">
                    <span className="text-4xl font-semibold tracking-tight text-navy">${p.price}</span>
                    <span className="text-sm text-slate-500">/ month</span>
                  </p>
                  <p className="mt-2 text-sm text-slate-500">{p.blurb}</p>
                  <ul className="mt-5 flex-1 space-y-2.5 text-sm text-slate-700">
                    {p.features.map((f) => (
                      <li key={f} className="flex items-start gap-2">
                        <Icon d={ICONS.check} className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                        {f}
                      </li>
                    ))}
                  </ul>
                  <Link to={signedIn ? "/settings?tab=billing" : "/signup"} className={cn(p.featured ? btnPrimary : btnGhost, "mt-6 w-full py-2.5")}>
                    {signedIn ? "Manage plan" : p.cta}
                  </Link>
                </Reveal>
              ))}
            </div>
            <p className="mt-6 text-center text-sm text-slate-500">Every account starts on Starter. Paid plans are billed monthly through Stripe.</p>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="border-t border-slate-200 bg-slate-50 py-20 sm:py-28">
          <div className="mx-auto max-w-3xl px-5">
            <SectionHeading eyebrow="FAQ" title="Questions people ask first" />
            <Reveal className="mt-10 divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white">
              {FAQS.map((f) => (
                <details key={f.q} className="group px-6 py-5">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-base font-semibold text-navy [&::-webkit-details-marker]:hidden">
                    {f.q}
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-slate-300 text-slate-500 transition-transform group-open:rotate-45" aria-hidden="true">
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                    </span>
                  </summary>
                  <p className="mt-3 text-sm leading-relaxed text-slate-600">{f.a}</p>
                </details>
              ))}
            </Reveal>
          </div>
        </section>

        {/* Closing call to action */}
        <section className="px-5 py-20 sm:py-28">
          <Reveal className="relative mx-auto max-w-7xl overflow-hidden rounded-3xl bg-navy px-6 py-16 text-center sm:px-12 sm:py-20">
            <div className="pointer-events-none absolute -bottom-32 left-1/2 h-72 w-[640px] -translate-x-1/2 rounded-full bg-blue-600/30 blur-3xl" aria-hidden="true" />
            <h2 className="relative mx-auto max-w-2xl text-3xl font-semibold leading-tight tracking-tight text-white sm:text-5xl">
              Your next overdue invoice can chase <span className="text-sky-300">itself.</span>
            </h2>
            <p className="relative mx-auto mt-4 max-w-xl text-base text-slate-300">
              Import your open invoices, approve four emails and let AutoCollect do the following up.
            </p>
            <div className="relative mt-8 flex flex-wrap items-center justify-center gap-3">
              {signedIn ? (
                <Link to={appHref} className={btnInverse}>
                  Open dashboard <Icon d={ICONS.arrow} className="h-4 w-4" />
                </Link>
              ) : (
                <>
                  <Link to="/signup" className={btnInverse}>
                    Start free <Icon d={ICONS.arrow} className="h-4 w-4" />
                  </Link>
                  <Link to="/login" className={btnOnDark}>
                    Sign in
                  </Link>
                </>
              )}
            </div>
          </Reveal>
        </section>
      </main>

      <SiteFooter links={navLinks} />
    </div>
  );
}
