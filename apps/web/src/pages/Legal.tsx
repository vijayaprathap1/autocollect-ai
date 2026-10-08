import { useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import "@fontsource-variable/fraunces";
import { CONTACT_EMAIL, Logo, SiteFooter, btnPrimary } from "@/components/marketing";
import { cn } from "@/components/ui";

/**
 * Terms of Service and Privacy Policy.
 *
 * These describe how the product actually behaves (sub-processors, cookies,
 * retention). Update them when that behaviour changes, and bump LAST_UPDATED.
 * OPERATOR is the legal party customers contract with.
 */
const LAST_UPDATED = "8 October 2026";
const OPERATOR = "an individual proprietor based in India, trading as AutoCollect AI";

const Mail = () => (
  <a href={`mailto:${CONTACT_EMAIL}`} className="font-medium text-primary hover:underline">
    {CONTACT_EMAIL}
  </a>
);

type Section = { id: string; title: string; body: ReactNode };

function LegalPage({ title, intro, sections }: { title: string; intro: ReactNode; sections: Section[] }) {
  useEffect(() => {
    document.title = `${title} — AutoCollect AI`;
    window.scrollTo(0, 0);
  }, [title]);

  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-paper/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <Link to="/" aria-label="AutoCollect AI home">
            <Logo />
          </Link>
          <div className="flex items-center gap-3">
            <Link to="/login" className="px-2 text-sm font-semibold text-ink hover:text-primary">
              Sign in
            </Link>
            <Link to="/signup" className={cn(btnPrimary, "px-4 py-2")}>
              Start free
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-12 px-5 py-14 lg:grid-cols-[220px_1fr] lg:py-20">
        <aside className="hidden lg:block">
          <nav className="sticky top-24 space-y-1 text-sm" aria-label="On this page">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-muted">On this page</p>
            {sections.map((s) => (
              <a key={s.id} href={`#${s.id}`} className="block rounded-md px-2 py-1.5 text-slate-600 hover:bg-white hover:text-ink">
                {s.title}
              </a>
            ))}
          </nav>
        </aside>

        <article className="max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Legal</p>
          <h1 className="mt-3 font-display text-4xl font-medium tracking-tight text-navy sm:text-5xl">{title}</h1>
          <p className="mt-3 text-sm text-muted">Last updated {LAST_UPDATED}</p>
          <div className="mt-6 text-base leading-relaxed text-slate-700">{intro}</div>

          <div className="mt-10 space-y-10">
            {sections.map((s, i) => (
              <section key={s.id} id={s.id} className="scroll-mt-24">
                <h2 className="text-xl font-semibold text-ink">
                  {i + 1}. {s.title}
                </h2>
                <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-slate-700 [&_li]:ml-5 [&_li]:list-disc [&_li]:pl-1 [&_strong]:font-semibold [&_strong]:text-ink [&_ul]:space-y-1.5">
                  {s.body}
                </div>
              </section>
            ))}
          </div>

          <p className="mt-12 rounded-xl border border-slate-200 bg-white p-5 text-sm text-muted">
            Questions about this page? Email <Mail />. See also our{" "}
            <Link to={title.startsWith("Terms") ? "/privacy" : "/terms"} className="font-medium text-primary hover:underline">
              {title.startsWith("Terms") ? "Privacy Policy" : "Terms of Service"}
            </Link>
            .
          </p>
        </article>
      </main>

      <SiteFooter />
    </div>
  );
}

// ─── Terms of Service ────────────────────────────────────────────────────────

export function Terms() {
  const sections: Section[] = [
    {
      id: "service",
      title: "The service",
      body: (
        <>
          <p>
            AutoCollect AI is software that sends payment reminders for your invoices, provides payment links, and helps you handle replies from your
            customers. It is operated by {OPERATOR} (&ldquo;AutoCollect AI&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;).
          </p>
          <p>
            We are a software provider. We are <strong>not a debt collection agency, a payment processor, a law firm or a financial adviser</strong>,
            and nothing in the service is legal or financial advice. Reminders are sent on your behalf, in your name, to your own customers.
          </p>
        </>
      ),
    },
    {
      id: "accounts",
      title: "Your account",
      body: (
        <ul>
          <li>You must be at least 18 and able to enter into a contract on behalf of yourself or the business you represent.</li>
          <li>Keep your sign-in details secure. You are responsible for activity in your workspace, including by teammates you invite.</li>
          <li>Give accurate information when you sign up and keep it up to date.</li>
        </ul>
      ),
    },
    {
      id: "acceptable-use",
      title: "Acceptable use",
      body: (
        <>
          <p>You agree to use the service only for invoices that are genuinely owed to you or to a client you are authorised to act for. You must not:</p>
          <ul>
            <li>send reminders for amounts that are not due, are disputed in bad faith, or that you have no right to collect;</li>
            <li>harass, threaten or mislead recipients, or impersonate another person or organisation;</li>
            <li>send marketing or any message unrelated to a specific invoice;</li>
            <li>break laws that apply to you or your recipients, including anti-spam, consumer-protection, debt-collection and data-protection laws;</li>
            <li>probe, overload or attempt to bypass the security of the service, or resell it without our written agreement.</li>
          </ul>
          <p>
            You are responsible for the content of your reminder templates and for having a lawful basis to contact each recipient. If a recipient
            asks not to be contacted, you must respect that.
          </p>
        </>
      ),
    },
    {
      id: "your-data",
      title: "Your data",
      body: (
        <>
          <p>
            You keep ownership of the invoices, customer details and messages you bring into the service (&ldquo;your data&rdquo;). You give us
            permission to store and process your data only to provide and support the service.
          </p>
          <p>
            For personal data about your customers, you are the controller and we act as your processor. How we handle personal data is described in
            the <Link to="/privacy" className="font-medium text-primary hover:underline">Privacy Policy</Link>.
          </p>
        </>
      ),
    },
    {
      id: "ai",
      title: "AI features",
      body: (
        <p>
          The service can use AI to classify replies and draft suggested responses. AI output can be wrong. Suggested responses are drafts for you to
          review, and automatic actions (pausing or snoozing reminders) are based on a best-effort reading of the reply. You remain responsible for
          what is sent to your customers.
        </p>
      ),
    },
    {
      id: "plans",
      title: "Plans, credits and billing",
      body: (
        <ul>
          <li>The Starter plan is free within its limits. Paid plans are billed monthly in advance through Stripe, in US dollars unless stated.</li>
          <li>Each plan includes a monthly allowance of reminder credits. One reminder sent uses one credit. Unused credits do not roll over.</li>
          <li>
            You can change or cancel your plan at any time from the billing settings. Cancellation takes effect at the end of the current billing
            period, and fees already paid are not refunded except where the law requires it.
          </li>
          <li>Prices exclude taxes. You are responsible for any taxes that apply to your purchase.</li>
          <li>We may change prices or plan limits with at least 30 days&rsquo; notice by email. Changes apply from your next billing period.</li>
        </ul>
      ),
    },
    {
      id: "third-parties",
      title: "Third-party services",
      body: (
        <p>
          The service connects to tools you choose to use, such as Stripe and QuickBooks. Your use of those tools is governed by their own terms, and
          we are not responsible for them. If a connected service is unavailable or changes, parts of AutoCollect AI may stop working until it is
          restored.
        </p>
      ),
    },
    {
      id: "availability",
      title: "Availability and changes",
      body: (
        <p>
          We work to keep the service available and reliable but do not guarantee uninterrupted operation, that every reminder will be delivered, or
          that any invoice will be paid. We may add, change or remove features, and will give reasonable notice of changes that materially reduce what
          you have paid for.
        </p>
      ),
    },
    {
      id: "termination",
      title: "Suspension and termination",
      body: (
        <>
          <p>You may stop using the service and ask us to delete your workspace at any time by emailing <Mail />.</p>
          <p>
            We may suspend or close a workspace that breaks these terms, puts the service or other customers at risk, or has unpaid fees. Where
            practical we will warn you first and give you a chance to fix the problem.
          </p>
        </>
      ),
    },
    {
      id: "warranty",
      title: "Disclaimer",
      body: (
        <p>
          The service is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. To the fullest extent the law allows, we disclaim all warranties,
          express or implied, including fitness for a particular purpose and non-infringement.
        </p>
      ),
    },
    {
      id: "liability",
      title: "Limitation of liability",
      body: (
        <p>
          To the fullest extent the law allows, we are not liable for indirect, incidental or consequential losses, or for lost profits, revenue or
          data. Our total liability for all claims relating to the service is limited to the amount you paid us in the 12 months before the claim
          arose, or USD 100 if you have paid nothing. Nothing in these terms limits liability that cannot be limited by law.
        </p>
      ),
    },
    {
      id: "indemnity",
      title: "Your responsibility for claims",
      body: (
        <p>
          If a third party brings a claim against us because of the reminders you sent, the data you provided or your breach of these terms, you agree
          to cover the reasonable costs and damages that result.
        </p>
      ),
    },
    {
      id: "law",
      title: "Governing law",
      body: (
        <p>
          These terms are governed by the laws of India, and the courts of India have jurisdiction over any dispute. If you are a consumer, this does
          not remove protections you have under the mandatory laws of the country where you live.
        </p>
      ),
    },
    {
      id: "changes",
      title: "Changes to these terms",
      body: (
        <p>
          We may update these terms. If a change is significant we will email workspace owners at least 14 days before it takes effect. Continuing to
          use the service after that date means you accept the updated terms.
        </p>
      ),
    },
    { id: "contact", title: "Contact", body: <p>Email <Mail /> with any question about these terms.</p> },
  ];

  return (
    <LegalPage
      title="Terms of Service"
      intro={
        <p>
          These terms are the agreement between you and AutoCollect AI for using the service. By creating an account or using the service, you agree
          to them. If you are using the service for a business, you agree on that business&rsquo;s behalf.
        </p>
      }
      sections={sections}
    />
  );
}

// ─── Privacy Policy ──────────────────────────────────────────────────────────

const SUBPROCESSORS = [
  ["Vercel", "Application hosting", "United States"],
  ["Neon", "Database hosting", "United States"],
  ["Postmark (ActiveCampaign)", "Sending and receiving email", "United States"],
  ["Stripe", "Subscription billing; invoice sync and payment links when you connect Stripe", "United States"],
  ["Intuit QuickBooks", "Invoice sync, only when you connect QuickBooks", "United States"],
  ["Anthropic", "AI classification of replies and drafted responses, when enabled", "United States"],
  ["Twilio", "SMS reminders, only when enabled for your workspace", "United States"],
  ["Google", "Sign-in, only when you choose “Continue with Google”", "United States"],
];

export function Privacy() {
  const sections: Section[] = [
    {
      id: "who",
      title: "Who we are",
      body: (
        <p>
          AutoCollect AI is operated by {OPERATOR}. For any privacy question or request, email <Mail />.
        </p>
      ),
    },
    {
      id: "roles",
      title: "Two kinds of data, two roles",
      body: (
        <ul>
          <li>
            <strong>Account data</strong> is about you and your teammates as users of the service. We decide how it is used, so we are the controller.
          </li>
          <li>
            <strong>Customer data</strong> is what you bring into the service about the people and businesses you invoice. You decide how it is used,
            so you are the controller and we process it on your instructions. If you received a reminder and have a question about it, contact the
            business that sent it; we will help them respond.
          </li>
        </ul>
      ),
    },
    {
      id: "collect",
      title: "What we collect",
      body: (
        <ul>
          <li><strong>Account details:</strong> name, work email, a hashed password (or your Google account identifier), workspace name and settings.</li>
          <li>
            <strong>Customer and invoice data you import:</strong> your customers&rsquo; names, email addresses and phone numbers, and invoice numbers,
            amounts, currencies, due dates and payment status.
          </li>
          <li><strong>Messages:</strong> reminders sent from your workspace and the replies your customers send back.</li>
          <li><strong>Connection tokens:</strong> access tokens for the tools you connect, stored encrypted.</li>
          <li><strong>Billing:</strong> your plan and subscription status. Card details are handled by Stripe and never reach our servers.</li>
          <li><strong>Technical logs:</strong> IP address, device and browser information, and a record of actions in your workspace, for security and troubleshooting.</li>
        </ul>
      ),
    },
    {
      id: "use",
      title: "How we use it",
      body: (
        <>
          <ul>
            <li>To provide the service: importing invoices, sending reminders, routing replies and showing you what happened.</li>
            <li>To keep the service secure: detecting abuse, limiting sign-in attempts and keeping an audit trail.</li>
            <li>To bill paid plans and to send service emails such as verification links and security notices.</li>
            <li>To fix problems and improve reliability.</li>
          </ul>
          <p>
            Under the GDPR and UK GDPR, our legal bases are performance of our contract with you, our legitimate interests in running a secure and
            reliable service, and compliance with legal obligations. <strong>We do not sell personal data, show advertising or use your data to train AI models.</strong>
          </p>
        </>
      ),
    },
    {
      id: "ai",
      title: "AI processing",
      body: (
        <p>
          When AI reply handling is enabled, the text of a customer&rsquo;s reply is sent to our AI provider to classify it and draft a suggested
          response. The result is shown to your team as a suggestion. It is not used to make decisions with legal or similarly significant effects
          about anyone.
        </p>
      ),
    },
    {
      id: "cookies",
      title: "Cookies and email tracking",
      body: (
        <>
          <p>
            We use one essential cookie to keep you signed in, and short-lived cookies during sign-in with Google. We do not use advertising or
            analytics cookies, so there is no cookie banner.
          </p>
          <p>
            Reminder emails record delivery, opens and link clicks so the sender can see whether a reminder was received. Recipients can block open
            tracking by turning off automatic image loading in their email app.
          </p>
        </>
      ),
    },
    {
      id: "sharing",
      title: "Who we share it with",
      body: (
        <>
          <p>We share personal data only with the service providers needed to run AutoCollect AI, and with authorities when the law requires it.</p>
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full min-w-[480px] text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th className="px-4 py-3 font-semibold">Provider</th>
                  <th className="px-4 py-3 font-semibold">Purpose</th>
                  <th className="px-4 py-3 font-semibold">Location</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {SUBPROCESSORS.map(([name, purpose, location]) => (
                  <tr key={name}>
                    <td className="px-4 py-3 font-medium text-ink">{name}</td>
                    <td className="px-4 py-3">{purpose}</td>
                    <td className="px-4 py-3 text-muted">{location}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ),
    },
    {
      id: "transfers",
      title: "International transfers",
      body: (
        <p>
          Our service is operated from India and our data is stored in the United States. If you are in the European Economic Area, the United Kingdom
          or another region with data-transfer rules, your data will be transferred outside that region. Where required, we rely on appropriate
          safeguards such as standard contractual clauses with our providers. If you need a data processing agreement, email <Mail />.
        </p>
      ),
    },
    {
      id: "retention",
      title: "How long we keep it",
      body: (
        <ul>
          <li>Workspace data (customers, invoices, messages) is kept while your workspace is active.</li>
          <li>When you ask us to delete your workspace, we delete its data within 30 days, except records we must keep for tax, accounting or legal reasons.</li>
          <li>Sign-in sessions are removed when they expire. Password-reset and verification tokens are removed within 7 days of expiring.</li>
          <li>Records of processed webhook events are removed after 30 days.</li>
        </ul>
      ),
    },
    {
      id: "security",
      title: "Security",
      body: (
        <ul>
          <li>Each workspace is isolated at the database level using row-level security.</li>
          <li>Passwords are hashed with argon2id. Connection tokens are encrypted at rest. All traffic uses HTTPS.</li>
          <li>Sessions are stored server-side, so you can review and revoke them from your account settings.</li>
        </ul>
      ),
    },
    {
      id: "rights",
      title: "Your rights",
      body: (
        <>
          <p>
            Depending on where you live, you may have the right to access, correct, delete or export your personal data, to object to or restrict its
            use, and to withdraw consent. This includes rights under the GDPR and UK GDPR, the California Consumer Privacy Act and India&rsquo;s
            Digital Personal Data Protection Act.
          </p>
          <p>
            To use any of these rights, email <Mail />. We respond within 30 days. If your data is in the service because a business sent you a
            reminder, we will pass your request to that business. You also have the right to complain to your local data-protection authority.
          </p>
        </>
      ),
    },
    {
      id: "children",
      title: "Children",
      body: <p>The service is for businesses and is not directed at anyone under 18. We do not knowingly collect personal data from children.</p>,
    },
    {
      id: "changes",
      title: "Changes to this policy",
      body: <p>We will update this page when our practices change and, for significant changes, email workspace owners before they take effect.</p>,
    },
  ];

  return (
    <LegalPage
      title="Privacy Policy"
      intro={
        <p>
          This policy explains what personal data AutoCollect AI handles, why, who it is shared with and the choices you have. We have tried to write
          it in plain language. In short: we use your data to run the service, we do not sell it, and we do not use tracking or advertising cookies.
        </p>
      }
      sections={sections}
    />
  );
}
