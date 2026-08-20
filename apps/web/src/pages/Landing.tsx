import { Link } from "react-router-dom";

const FEATURES = [
  {
    title: "Connect Stripe or upload a CSV",
    body: "Invoices sync automatically from Stripe (or drop in a spreadsheet). No manual entry, ever.",
    icon: "🔌",
  },
  {
    title: "AI-drafted, human-approved reminders",
    body: "Polite, escalating emails written for you. You approve once — then they send on schedule.",
    icon: "✍️",
  },
  {
    title: "One-click payment links",
    body: "Every reminder carries a Stripe payment link, so clients pay in seconds, not weeks.",
    icon: "💳",
  },
  {
    title: "Automatic replies, handled",
    body: "When a client replies, we classify it — disputes pause reminders, promises are honored.",
    icon: "🤖",
  },
  {
    title: "Never chase manually again",
    body: "Set it once and forget it. Cash comes in while you focus on the work that pays for itself.",
    icon: "⚡",
  },
  {
    title: "White-label for agencies",
    body: "Run collections under your own brand for every client account with the Agency plan.",
    icon: "🏷️",
  },
];

const STEPS = [
  { n: "01", title: "Connect", body: "Link Stripe or upload a CSV of unpaid invoices." },
  { n: "02", title: "Approve", body: "Review AI-drafted reminders and approve them once." },
  { n: "03", title: "Automate", body: "Turn on your workflow. Escalating reminders send on schedule." },
  { n: "04", title: "Get paid", body: "Clients pay via one-click links. Replies are triaged automatically." },
];

const PLANS = [
  {
    name: "Starter",
    price: "$0",
    period: "free forever",
    desc: "For freelancers getting started.",
    features: ["50 invoices", "1 seat", "Email reminders", "CSV import"],
    cta: "Start free",
    highlight: false,
  },
  {
    name: "Growth",
    price: "$29",
    period: "/month",
    desc: "For busy small businesses.",
    features: ["Unlimited invoices", "3 seats", "AI drafting + reply inbox", "SMS reminders"],
    cta: "Start free, upgrade later",
    highlight: true,
  },
  {
    name: "Agency",
    price: "$199",
    period: "/month",
    desc: "For agencies running client accounts.",
    features: ["Unlimited seats", "White-label branding", "Multi-client workflows"],
    cta: "Talk to us",
    highlight: false,
  },
];

function PricingCTA({ plan }: { plan: (typeof PLANS)[number] }) {
  if (plan.highlight) {
    return (
      <Link
        to="/login"
        className="inline-flex items-center justify-center rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover"
      >
        {plan.cta}
      </Link>
    );
  }
  return (
    <Link
      to="/login"
      className="inline-flex items-center justify-center rounded-lg border border-slate-300 px-5 py-2.5 text-sm font-semibold text-ink hover:bg-slate-50"
    >
      {plan.cta}
    </Link>
  );
}

export function Landing() {
  return (
    <div className="min-h-screen bg-bg text-ink">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-bg/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <div className="text-lg font-bold text-primary">AutoCollect AI</div>
          <nav className="hidden items-center gap-6 text-sm font-medium text-muted md:flex">
            <a href="#features" className="hover:text-ink">Features</a>
            <a href="#how-it-works" className="hover:text-ink">How it works</a>
            <a href="#pricing" className="hover:text-ink">Pricing</a>
          </nav>
          <Link
            to="/login"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover"
          >
            Get started
          </Link>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-4 pt-20 pb-16 text-center">
        <h1 className="mx-auto max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
          Stop chasing invoices.
          <span className="block text-primary">Start getting paid.</span>
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-muted">
          AutoCollect AI sends polite, escalating reminders to your overdue clients — with one-click
          payment links — and handles their replies automatically. Set it once. Cash comes in on its own.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            to="/login"
            className="rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-white hover:bg-primary-hover"
          >
            Start collecting — it's free
          </Link>
          <a
            href="#how-it-works"
            className="rounded-lg border border-slate-300 px-6 py-3 text-sm font-semibold text-ink hover:bg-slate-50"
          >
            See how it works
          </a>
        </div>
      </section>

      <section id="features" className="mx-auto max-w-6xl px-4 py-16">
        <h2 className="text-center text-3xl font-bold">Everything you need to get paid</h2>
        <p className="mx-auto mt-3 max-w-xl text-center text-muted">
          Built for freelancers, agencies, and small businesses who would rather work than chase money.
        </p>
        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-xl border border-slate-200 bg-surface p-6 shadow-sm">
              <div className="text-2xl">{f.icon}</div>
              <h3 className="mt-3 text-base font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm text-muted">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="how-it-works" className="border-y border-slate-200 bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-16">
          <h2 className="text-center text-3xl font-bold">From overdue to paid in four steps</h2>
          <div className="mt-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s) => (
              <div key={s.n} className="text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                  {s.n}
                </div>
                <h3 className="mt-4 text-base font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm text-muted">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="pricing" className="mx-auto max-w-6xl px-4 py-16">
        <h2 className="text-center text-3xl font-bold">Simple pricing that pays for itself</h2>
        <p className="mx-auto mt-3 max-w-xl text-center text-muted">
          Every paid plan starts free. You only pay when collections start working for you.
        </p>
        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              className={
                "flex flex-col rounded-xl border p-6 shadow-sm " +
                (plan.highlight
                  ? "border-primary bg-surface ring-2 ring-primary/20"
                  : "border-slate-200 bg-surface")
              }
            >
              <div className="flex items-baseline justify-between">
                <h3 className="text-lg font-semibold">{plan.name}</h3>
                {plan.highlight && (
                  <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                    Popular
                  </span>
                )}
              </div>
              <div className="mt-3">
                <span className="text-3xl font-bold">{plan.price}</span>
                <span className="text-sm text-muted"> {plan.period}</span>
              </div>
              <p className="mt-1 text-sm text-muted">{plan.desc}</p>
              <ul className="mt-5 space-y-2 text-sm">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-center gap-2">
                    <span className="text-green-600">✓</span>
                    {f}
                  </li>
                ))}
              </ul>
              <div className="mt-6">
                <PricingCTA plan={plan} />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-slate-200 bg-primary">
        <div className="mx-auto max-w-3xl px-4 py-16 text-center">
          <h2 className="text-3xl font-bold text-white">
            Your invoices are waiting. Start collecting.
          </h2>
          <Link
            to="/login"
            className="mt-6 inline-block rounded-lg bg-white px-6 py-3 text-sm font-semibold text-primary hover:bg-slate-100"
          >
            Get started free
          </Link>
        </div>
      </section>

      <footer className="border-t border-slate-200 bg-surface">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-muted sm:flex-row">
          <div className="font-semibold text-ink">AutoCollect AI</div>
          <div className="flex items-center gap-5">
            <a href="#features" className="hover:text-ink">Features</a>
            <a href="#pricing" className="hover:text-ink">Pricing</a>
            <Link to="/login" className="hover:text-ink">Sign in</Link>
          </div>
          <div>© {new Date().getFullYear()} AutoCollect AI</div>
        </div>
      </footer>
    </div>
  );
}