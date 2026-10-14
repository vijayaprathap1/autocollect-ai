import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/fraunces/wght-italic.css";
import { fetchMe } from "@/lib/api";
import { cn } from "@/components/ui";
import { Logo, SiteFooter, btnGhost, btnInverse, btnPrimary } from "@/components/marketing";

/**
 * Public marketing page at "/". Everything it claims mirrors real behaviour:
 * the reminder sequence is the default workflow, the reply outcomes are the
 * inbound service's, and PLANS matches apps/api/src/lib/billing.ts.
 */

// Keep in sync with PLANS in apps/api/src/lib/billing.ts.
const PLANS = [
  { name: "Starter", price: 0, blurb: "Try it on real invoices.", features: ["50 open invoices", "50 reminders a month", "1 seat"], cta: "Start free" },
  { name: "Growth", price: 29, blurb: "For a growing client list.", features: ["Unlimited invoices", "500 reminders a month", "3 seats"], cta: "Start with Growth", featured: true },
  { name: "Pro", price: 59, blurb: "For a team that invoices daily.", features: ["Unlimited invoices", "2,000 reminders a month", "Unlimited seats"], cta: "Start with Pro" },
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
    a: "Reminders stop. A paid invoice in Stripe, a completed payment link, a zero balance in QuickBooks or you marking it paid all end the sequence for that invoice.",
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
      <p className={cn("text-xs font-semibold uppercase tracking-[0.18em]", light ? "text-blue-300" : "text-primary")}>{eyebrow}</p>
      <h2 className={cn("mt-3 font-display text-3xl font-medium leading-tight tracking-tight sm:text-[2.6rem]", light ? "text-white" : "text-ink")}>{title}</h2>
      {lead && <p className={cn("mt-4 text-base leading-relaxed sm:text-lg", light ? "text-slate-300" : "text-muted")}>{lead}</p>}
    </Reveal>
  );
}

// ─── Hero visual: one invoice, from first reminder to paid ───────────────────

function ThreadRow({ delay, children }: { delay: number; children: ReactNode }) {
  return (
    <li style={{ animationDelay: `${delay}ms` }} className="relative animate-rise pl-7 motion-reduce:animate-none">
      {children}
    </li>
  );
}

function Dot({ className }: { className: string }) {
  return <span className={cn("absolute left-0 top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-white", className)} aria-hidden="true" />;
}

function InvoiceThread() {
  return (
    <figure className="relative mx-auto w-full max-w-md">
      <div className="absolute -inset-4 -z-10 rounded-[2rem] bg-gradient-to-br from-primary/10 via-transparent to-amber-200/40 blur-2xl" aria-hidden="true" />
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_24px_60px_-20px_rgba(11,23,48,0.25)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div>
            <p className="text-xs font-medium text-muted">Invoice INV-1042 · Harbor &amp; Pine Studio</p>
            <p className="mt-0.5 font-display text-2xl font-medium tracking-tight text-ink">$4,800.00</p>
          </div>
          <span
            style={{ animationDelay: "2700ms" }}
            className="mt-1 inline-flex animate-rise items-center gap-1.5 rounded-full border border-green-200 bg-green-50 px-2.5 py-1 text-xs font-semibold text-green-700 motion-reduce:animate-none"
          >
            <Icon d={ICONS.check} className="h-3.5 w-3.5" /> Paid
          </span>
        </div>

        <ol className="relative space-y-5 px-5 py-5 before:absolute before:bottom-6 before:left-[1.55rem] before:top-6 before:w-px before:bg-slate-200">
          <ThreadRow delay={300}>
            <Dot className="bg-slate-300" />
            <p className="text-xs font-medium text-muted">2 days before due · Reminder sent</p>
            <p className="mt-0.5 text-sm text-ink">Quick heads-up: invoice $4,800.00 coming due</p>
          </ThreadRow>
          <ThreadRow delay={900}>
            <Dot className="bg-amber-400" />
            <p className="text-xs font-medium text-muted">1 day after due · Reminder sent</p>
            <p className="mt-0.5 text-sm text-ink">Invoice $4,800.00 is now due</p>
            <span className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
              <Icon d={ICONS.link} className="h-3.5 w-3.5" /> One-click payment link
            </span>
          </ThreadRow>
          <ThreadRow delay={1500}>
            <Dot className="bg-primary" />
            <p className="text-xs font-medium text-muted">Customer replied</p>
            <p className="mt-1.5 rounded-xl rounded-tl-sm bg-slate-100 px-3.5 py-2.5 text-sm text-ink">
              &ldquo;Thanks for the nudge. We&rsquo;ll get this paid on Friday.&rdquo;
            </p>
          </ThreadRow>
          <ThreadRow delay={2100}>
            <Dot className="bg-violet-500" />
            <p className="text-xs font-medium text-muted">Read by AI</p>
            <p className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-ink">
              <span className="rounded-md border border-violet-200 bg-violet-50 px-2 py-0.5 text-xs font-semibold text-violet-700">Promise to pay</span>
              Reminders snoozed until Saturday
            </p>
          </ThreadRow>
          <ThreadRow delay={2700}>
            <Dot className="bg-green-500" />
            <p className="text-xs font-medium text-muted">Friday · Paid through the payment link</p>
            <p className="mt-0.5 text-sm font-medium text-green-700">Sequence stopped automatically</p>
          </ThreadRow>
        </ol>
      </div>
      <figcaption className="mt-3 text-center text-xs text-muted">Example of one invoice moving through AutoCollect</figcaption>
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
    document.title = "AutoCollect AI — Stop chasing invoices. Start getting paid.";
  }, []);

  const navLinks = [
    { href: "#how-it-works", label: "How it works" },
    { href: "#replies", label: "Reply handling" },
    { href: "#borders", label: "Across borders" },
    { href: "#pricing", label: "Pricing" },
    { href: "#faq", label: "FAQ" },
  ];

  const primaryCta = signedIn ? (
    <Link to={appHref} className={btnPrimary}>
      Open dashboard <Icon d={ICONS.arrow} className="h-4 w-4" />
    </Link>
  ) : (
    <Link to="/signup" className={btnPrimary}>
      Start free <Icon d={ICONS.arrow} className="h-4 w-4" />
    </Link>
  );

  return (
    <div className="min-h-screen scroll-smooth bg-paper text-ink [&_section]:scroll-mt-20">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:shadow">
        Skip to content
      </a>

      {/* Navigation */}
      <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-paper/85 backdrop-blur">
        <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5" aria-label="Main">
          <Link to="/" aria-label="AutoCollect AI home">
            <Logo />
          </Link>
          <div className="hidden items-center gap-8 md:flex">
            {navLinks.map((l) => (
              <a key={l.href} href={l.href} className="text-sm font-medium text-slate-600 transition-colors hover:text-ink">
                {l.label}
              </a>
            ))}
          </div>
          <div className="hidden items-center gap-3 md:flex">
            {!signedIn && (
              <Link to="/login" className="px-2 text-sm font-semibold text-ink hover:text-primary">
                Sign in
              </Link>
            )}
            <Link to={signedIn ? appHref : "/signup"} className={cn(btnPrimary, "px-4 py-2")}>
              {signedIn ? "Open dashboard" : "Start free"}
            </Link>
          </div>
          <button
            type="button"
            className="rounded-md p-2 text-ink md:hidden"
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <Icon d={menuOpen ? "M6 6l12 12M18 6L6 18" : "M4 7h16M4 12h16M4 17h16"} className="h-6 w-6" />
          </button>
        </nav>
        {menuOpen && (
          <div id="mobile-menu" className="border-t border-slate-200 bg-paper px-5 py-4 md:hidden">
            <div className="flex flex-col gap-1">
              {navLinks.map((l) => (
                <a key={l.href} href={l.href} onClick={() => setMenuOpen(false)} className="rounded-md px-2 py-2.5 text-sm font-medium text-ink hover:bg-white">
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
        <section className="relative overflow-hidden">
          <div
            className="pointer-events-none absolute inset-0 -z-10 opacity-60 [background-image:radial-gradient(rgba(11,23,48,0.07)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:linear-gradient(to_bottom,black,transparent_85%)]"
            aria-hidden="true"
          />
          <div className="mx-auto grid max-w-6xl items-center gap-14 px-5 pb-20 pt-14 sm:pt-20 lg:grid-cols-[1.05fr_0.95fr] lg:pb-28">
            <div>
              <p className="animate-rise text-xs font-semibold uppercase tracking-[0.18em] text-primary motion-reduce:animate-none">
                For freelancers, agencies and small teams with clients anywhere
              </p>
              <h1
                style={{ animationDelay: "80ms" }}
                className="mt-4 animate-rise font-display text-[2.7rem] font-medium leading-[1.04] tracking-tight text-navy motion-reduce:animate-none sm:text-6xl lg:text-[3.9rem]"
              >
                Stop chasing invoices. <em className="block font-normal text-primary">Start getting paid.</em>
              </h1>
              <p style={{ animationDelay: "160ms" }} className="mt-6 max-w-xl animate-rise text-lg leading-relaxed text-slate-600 motion-reduce:animate-none">
                AutoCollect sends polite, well-timed payment reminders with a one-click payment link, and reads the replies for you. A dispute pauses
                the sequence, a promise to pay snoozes it, and a payment ends it.
              </p>
              <div style={{ animationDelay: "240ms" }} className="mt-8 flex animate-rise flex-wrap items-center gap-3 motion-reduce:animate-none">
                {primaryCta}
                <a href="#how-it-works" className={btnGhost}>
                  See how it works
                </a>
              </div>
              {!signedIn && (
                <p style={{ animationDelay: "320ms" }} className="mt-4 animate-rise text-sm text-muted motion-reduce:animate-none">
                  Free plan for up to 50 open invoices. No card needed to start.
                </p>
              )}
            </div>
            <InvoiceThread />
          </div>
        </section>

        {/* What you can count on (in place of a logo wall) */}
        <section aria-label="At a glance" className="border-y border-slate-200 bg-white">
          <dl className="mx-auto grid max-w-6xl grid-cols-2 gap-x-6 gap-y-6 px-5 py-8 lg:grid-cols-4">
            {[
              ["No demo call", "Self-serve from sign-up to first reminder"],
              ["Any currency", "Each invoice is chased in its own"],
              ["Stripe · QuickBooks · CSV", "Bring invoices in from where they live"],
              ["Free to start", "Up to 50 open invoices, no card"],
            ].map(([term, detail]) => (
              <div key={term}>
                <dt className="font-display text-xl font-medium text-navy">{term}</dt>
                <dd className="mt-1 text-sm text-muted">{detail}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* Problem */}
        <section className="bg-navy py-20 sm:py-28">
          <div className="mx-auto max-w-6xl px-5">
            <SectionHeading
              light
              eyebrow="The problem"
              title={
                <>
                  The work is done. The invoice is sent. <em className="font-normal text-blue-300">Then the silence starts.</em>
                </>
              }
              lead="Getting paid late is rarely about a customer refusing to pay. It is about follow-up that is awkward to write, easy to forget and hard to keep track of."
            />
            <div className="mt-14 grid gap-5 md:grid-cols-3">
              {[
                {
                  title: "Following up feels awkward",
                  body: "Nobody enjoys writing the third “just checking in” email to a client they like, so it gets put off for another week.",
                },
                {
                  title: "It depends on someone remembering",
                  body: "Reminders happen when there is a quiet afternoon. Busy months, which are exactly when cash matters, are when they get skipped.",
                },
                {
                  title: "Replies get lost in the inbox",
                  body: "“We’ll pay Friday” or “this amount looks wrong” lands in one person’s email, and the next automated nudge goes out anyway.",
                },
              ].map((p, i) => (
                <Reveal key={p.title} delay={i * 90} className="rounded-2xl border border-white/10 bg-white/[0.04] p-6">
                  <h3 className="font-display text-xl font-medium text-white">{p.title}</h3>
                  <p className="mt-3 text-sm leading-relaxed text-slate-300">{p.body}</p>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* How it works */}
        <section id="how-it-works" className="py-20 sm:py-28">
          <div className="mx-auto max-w-6xl px-5">
            <SectionHeading
              eyebrow="How it works"
              title="Set it up once. It follows up until the invoice is paid."
              lead="Three steps, and you approve every word before anything is sent."
            />
            <ol className="mt-14 grid gap-5 md:grid-cols-3">
              {[
                {
                  title: "Bring in your invoices",
                  body: "Connect Stripe or QuickBooks and open invoices import and stay in sync. Prefer a spreadsheet? Upload a CSV; re-uploading updates what is already there.",
                },
                {
                  title: "Approve your reminders",
                  body: "You start with four ready-made templates. Edit the wording and timing to sound like you, then approve them. Nothing sends until you do.",
                },
                {
                  title: "Let it run",
                  body: "Reminders go out on schedule with a payment link. Replies are read and routed. The moment an invoice is paid, its sequence stops.",
                },
              ].map((s, i) => (
                <li key={s.title}>
                  <Reveal delay={i * 90} className="h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                    <span className="font-display text-4xl font-medium text-primary/30">{i + 1}</span>
                    <h3 className="mt-3 text-lg font-semibold text-ink">{s.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted">{s.body}</p>
                  </Reveal>
                </li>
              ))}
            </ol>

            {/* The default sequence */}
            <Reveal className="mt-10 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-lg font-semibold text-ink">The default sequence</h3>
                <p className="text-sm text-muted">Polite first, firmer later. Every step is editable.</p>
              </div>
              <ol className="relative mt-8 grid gap-6 md:grid-cols-4 md:gap-4">
                <span className="absolute left-[5px] top-2 hidden h-px w-[calc(100%-10px)] bg-gradient-to-r from-slate-300 via-amber-300 to-red-300 md:block" aria-hidden="true" />
                {SEQUENCE.map((s, i) => (
                  <li key={s.day} className="relative pl-6 md:pl-0 md:pt-7">
                    <span
                      className={cn(
                        "absolute left-0 top-1.5 h-3 w-3 rounded-full ring-4 ring-white md:top-0.5",
                        ["bg-slate-400", "bg-amber-400", "bg-orange-500", "bg-red-500"][i],
                      )}
                      aria-hidden="true"
                    />
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted">{s.day}</p>
                    <p className="mt-1 text-sm font-semibold text-ink">{s.tone}</p>
                    <p className="mt-1 text-sm leading-snug text-muted">&ldquo;{s.subject}&rdquo;</p>
                  </li>
                ))}
              </ol>
            </Reveal>
          </div>
        </section>

        {/* Reply handling */}
        <section id="replies" className="border-t border-slate-200 bg-white py-20 sm:py-28">
          <div className="mx-auto max-w-6xl px-5">
            <SectionHeading
              eyebrow="Reply handling"
              title="Reminder tools send. This one also listens."
              lead="When a customer replies to a reminder, AutoCollect reads it, sorts it and acts on it, so you never send a nudge to someone who already answered."
            />
            <div className="mt-14 grid gap-5 lg:grid-cols-3">
              {[
                {
                  quote: "The total doesn’t match our PO. Can you check?",
                  tag: "Dispute",
                  tagClass: "border-red-200 bg-red-50 text-red-700",
                  outcome: "Reminders pause and your team is notified, so nobody chases an invoice that is being questioned.",
                },
                {
                  quote: "Approved on our side. Payment goes out on the 14th.",
                  tag: "Promise to pay",
                  tagClass: "border-violet-200 bg-violet-50 text-violet-700",
                  outcome: "Reminders snooze until the day after the promised date, then resume only if it is still unpaid.",
                },
                {
                  quote: "Could you resend the invoice as a PDF?",
                  tag: "Question",
                  tagClass: "border-blue-200 bg-blue-50 text-blue-700",
                  outcome: "A suggested response is drafted in your reply inbox, ready for you to edit and send.",
                },
              ].map((r, i) => (
                <Reveal key={r.tag} delay={i * 90} className="flex h-full flex-col rounded-2xl border border-slate-200 bg-paper p-6">
                  <p className="rounded-xl rounded-tl-sm bg-white px-4 py-3 text-sm leading-relaxed text-ink shadow-sm">&ldquo;{r.quote}&rdquo;</p>
                  <div className="my-4 flex items-center gap-2 text-xs text-muted">
                    <span className="h-px flex-1 bg-slate-200" />
                    read as
                    <span className={cn("rounded-md border px-2 py-0.5 text-xs font-semibold", r.tagClass)}>{r.tag}</span>
                    <span className="h-px flex-1 bg-slate-200" />
                  </div>
                  <p className="text-sm leading-relaxed text-slate-600">{r.outcome}</p>
                </Reveal>
              ))}
            </div>
            <Reveal className="mx-auto mt-8 max-w-2xl text-center text-sm text-muted">
              You stay in control: the AI classifies and drafts, and a person decides what is sent back.
            </Reveal>
          </div>
        </section>

        {/* Across borders */}
        <section id="borders" className="py-20 sm:py-28">
          <div className="mx-auto grid max-w-6xl items-center gap-14 px-5 lg:grid-cols-2">
            <Reveal>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Across borders</p>
              <h2 className="mt-3 font-display text-3xl font-medium leading-tight tracking-tight text-ink sm:text-[2.6rem]">
                Your clients are in another country. <em className="font-normal text-primary">Your follow-up should not be a day late.</em>
              </h2>
              <p className="mt-4 text-base leading-relaxed text-muted sm:text-lg">
                Billing overseas means your working day ends as theirs begins. AutoCollect is built for that gap.
              </p>
              <dl className="mt-8 space-y-6">
                {[
                  ["Their morning, not yours", "Pick the timezone and hour reminders go out, so they arrive at the start of your client’s working day while you are offline."],
                  ["Their currency on every reminder", "Dollars, pounds, euros or anything else: each invoice is tracked and chased in the currency it was issued in."],
                  ["Privacy that travels", "No advertising or tracking cookies, each workspace isolated at the database level, and data-protection requests answered within 30 days."],
                ].map(([term, detail]) => (
                  <div key={term} className="border-l-2 border-primary/30 pl-4">
                    <dt className="text-base font-semibold text-ink">{term}</dt>
                    <dd className="mt-1 text-sm leading-relaxed text-muted">{detail}</dd>
                  </div>
                ))}
              </dl>
              <Link to="/privacy" className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline">
                Read the privacy policy <Icon d={ICONS.arrow} className="h-4 w-4" />
              </Link>
            </Reveal>

            <Reveal delay={120}>
              <figure className="mx-auto max-w-md">
                <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-[0_24px_60px_-24px_rgba(11,23,48,0.25)]">
                  <div className="flex items-stretch gap-3">
                    <div className="flex-1 rounded-xl bg-navy p-4 text-white">
                      <p className="text-xs font-medium text-slate-300">You · New York</p>
                      <p className="mt-1 whitespace-nowrap font-display text-2xl font-medium sm:text-3xl">6:00 PM</p>
                      <p className="mt-1 text-xs text-slate-300">Laptop closed</p>
                    </div>
                    <div className="flex items-center text-slate-400" aria-hidden="true">
                      <Icon d={ICONS.arrow} />
                    </div>
                    <div className="flex-1 rounded-xl border border-amber-200 bg-amber-50 p-4">
                      <p className="text-xs font-medium text-amber-800">Client · Sydney</p>
                      <p className="mt-1 whitespace-nowrap font-display text-2xl font-medium text-navy sm:text-3xl">9:00 AM</p>
                      <p className="mt-1 text-xs font-medium text-amber-800">Reminder delivered</p>
                    </div>
                  </div>
                  <ul className="mt-5 divide-y divide-slate-100 text-sm">
                    {[
                      ["Kestrel Design Ltd", "London", "£3,250.00"],
                      ["Atelier Nord GmbH", "Berlin", "€2,900.00"],
                      ["Harbor & Pine Studio", "Sydney", "A$6,400.00"],
                      ["Brightline Labs Inc", "Austin", "$4,800.00"],
                    ].map(([name, city, amount]) => (
                      <li key={name} className="flex items-center justify-between gap-4 py-2.5">
                        <span>
                          <span className="font-medium text-ink">{name}</span>
                          <span className="ml-2 text-xs text-muted">{city}</span>
                        </span>
                        <span className="font-display text-base font-medium tabular-nums text-navy">{amount}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <figcaption className="mt-3 text-center text-xs text-muted">Illustration: one workspace, clients in four countries</figcaption>
              </figure>
            </Reveal>
          </div>
        </section>

        {/* Comparison */}
        <section className="border-y border-slate-200 bg-white py-20 sm:py-28">
          <div className="mx-auto max-w-5xl px-5">
            <SectionHeading
              eyebrow="How it compares"
              title="More than a reminder. Less than a finance department."
              lead="Enterprise receivables suites are built for finance teams and sold on demo calls. Built-in invoice reminders send and hope. AutoCollect sits in between."
            />
            <Reveal className="mt-12 overflow-x-auto rounded-2xl border border-slate-200">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-paper text-xs uppercase tracking-wider text-muted">
                    <th scope="col" className="px-5 py-4 font-semibold"><span className="sr-only">Capability</span></th>
                    <th scope="col" className="px-5 py-4 font-semibold">Chasing by hand</th>
                    <th scope="col" className="px-5 py-4 font-semibold">Built-in invoice reminders</th>
                    <th scope="col" className="bg-primary/[0.06] px-5 py-4 font-semibold text-primary">AutoCollect AI</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {[
                    ["Follows up on schedule", "When you remember", "Yes", "Yes"],
                    ["Stops when the invoice is paid", "You have to check", "Usually", "Yes"],
                    ["Reads the customer’s reply", "You do", "Rarely", "Yes"],
                    ["Pauses when an invoice is disputed", "If you see it in time", "Rarely", "Yes"],
                    ["Waits for a promised payment date", "If you remember", "Rarely", "Yes"],
                    ["Drafts a response for you", "No", "No", "Yes"],
                    ["Getting started", "Nothing to set up", "A setting to switch on", "Self-serve, free plan"],
                  ].map(([cap, hand, basic, ours]) => (
                    <tr key={cap}>
                      <th scope="row" className="px-5 py-3.5 font-medium text-ink">{cap}</th>
                      <td className="px-5 py-3.5 text-muted">{hand}</td>
                      <td className="px-5 py-3.5 text-muted">{basic}</td>
                      <td className="bg-primary/[0.06] px-5 py-3.5 font-semibold text-ink">
                        <span className="inline-flex items-center gap-1.5">
                          <Icon d={ICONS.check} className="h-4 w-4 text-green-600" />
                          {ours}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Reveal>
            <p className="mt-4 text-center text-xs text-muted">
              &ldquo;Built-in invoice reminders&rdquo; describes the reminder settings typical of invoicing tools; features vary by product.
            </p>
          </div>
        </section>

        {/* Details */}
        <section className="py-20 sm:py-28">
          <div className="mx-auto max-w-6xl px-5">
            <SectionHeading eyebrow="The details" title="Considerate by design" lead="The small rules that keep automated follow-up from feeling automated." />
            <div className="mt-14 grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
              {[
                { icon: ICONS.clock, title: "Sent at a sensible hour", body: "Choose your timezone and send hour, and skip weekends, so reminders arrive during the working day." },
                { icon: ICONS.link, title: "One click to pay", body: "Every reminder carries a payment link, so settling the invoice takes less effort than replying to it." },
                { icon: ICONS.stop, title: "Stops when they pay", body: "Payment in Stripe, a completed payment link, a zero QuickBooks balance or “Mark paid” ends the sequence." },
                { icon: ICONS.layers, title: "Never a pile-on", body: "Reminders are at least about a day apart, and a long-overdue import gets one relevant message, not four at once." },
                { icon: ICONS.mail, title: "Bad addresses handled", body: "Hard bounces, spam complaints and unsubscribes pause the invoice instead of sending into the void." },
                { icon: ICONS.team, title: "Made for a team", body: "Invite teammates with roles, share one reply inbox and see every action in the activity log." },
              ].map((f, i) => (
                <Reveal key={f.title} delay={(i % 3) * 80}>
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Icon d={f.icon} />
                  </span>
                  <h3 className="mt-4 text-base font-semibold text-ink">{f.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted">{f.body}</p>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="border-t border-slate-200 bg-white py-20 sm:py-28">
          <div className="mx-auto max-w-6xl px-5">
            <SectionHeading eyebrow="Pricing" title="Start free. Upgrade when it is paying for itself." lead="One reminder sent uses one credit. Change or cancel your plan at any time." />
            <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {PLANS.map((p, i) => (
                <Reveal
                  key={p.name}
                  delay={i * 70}
                  className={cn(
                    "flex h-full flex-col rounded-2xl border p-6",
                    p.featured ? "border-primary bg-primary/[0.03] shadow-[0_18px_40px_-22px_rgba(5,55,170,0.55)]" : "border-slate-200 bg-white",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <h3 className="text-base font-semibold text-ink">{p.name}</h3>
                    {p.featured && <span className="rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-semibold text-white">Most popular</span>}
                  </div>
                  <p className="mt-4 flex items-baseline gap-1">
                    <span className="font-display text-4xl font-medium tracking-tight text-navy">${p.price}</span>
                    <span className="text-sm text-muted">/ month</span>
                  </p>
                  <p className="mt-2 text-sm text-muted">{p.blurb}</p>
                  <ul className="mt-5 flex-1 space-y-2.5 text-sm text-ink">
                    {p.features.map((f) => (
                      <li key={f} className="flex items-start gap-2">
                        <Icon d={ICONS.check} className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
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
            <p className="mt-6 text-center text-sm text-muted">Every account starts on Starter. Paid plans are billed monthly through Stripe.</p>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="py-20 sm:py-28">
          <div className="mx-auto max-w-3xl px-5">
            <SectionHeading eyebrow="FAQ" title="Questions people ask first" />
            <Reveal className="mt-10 divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white">
              {FAQS.map((f) => (
                <details key={f.q} className="group px-6 py-5">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-base font-semibold text-ink [&::-webkit-details-marker]:hidden">
                    {f.q}
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-slate-300 text-muted transition-transform group-open:rotate-45" aria-hidden="true">
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                    </span>
                  </summary>
                  <p className="mt-3 text-sm leading-relaxed text-muted">{f.a}</p>
                </details>
              ))}
            </Reveal>
          </div>
        </section>

        {/* Closing call to action */}
        <section className="px-5 pb-20 sm:pb-28">
          <Reveal className="relative mx-auto max-w-6xl overflow-hidden rounded-3xl bg-navy px-6 py-16 text-center sm:px-12 sm:py-20">
            <div
              className="pointer-events-none absolute inset-0 opacity-40 [background-image:radial-gradient(rgba(255,255,255,0.12)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_70%)]"
              aria-hidden="true"
            />
            <h2 className="relative mx-auto max-w-2xl font-display text-3xl font-medium leading-tight tracking-tight text-white sm:text-5xl">
              Your next overdue invoice can chase <em className="font-normal text-blue-300">itself.</em>
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
                  <Link to="/login" className="px-3 py-3 text-sm font-semibold text-white hover:text-blue-200">
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
