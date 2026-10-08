import { Link } from "react-router-dom";
import { cn } from "@/components/ui";

/** Shared pieces of the public site (landing, terms, privacy). */

export const CONTACT_EMAIL = "support@botly.in";

const focusRing = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";
const btnBase = "inline-flex items-center justify-center gap-2 rounded-lg px-5 py-3 text-sm font-semibold transition-colors";
export const btnPrimary = cn(btnBase, focusRing, "bg-primary text-white shadow-sm hover:bg-primary-hover focus-visible:outline-primary");
export const btnGhost = cn(btnBase, focusRing, "border border-slate-300 bg-white/70 text-ink hover:bg-white focus-visible:outline-primary");
export const btnInverse = cn(btnBase, focusRing, "bg-white text-navy shadow-sm hover:bg-slate-100 focus-visible:outline-white");

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2 text-base font-bold text-ink">
      <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary" aria-hidden="true">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      </span>
      AutoCollect AI
    </span>
  );
}

export function SiteFooter({ links = [] }: { links?: { href: string; label: string }[] }) {
  return (
    <footer className="border-t border-slate-200">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-5 px-5 py-8 lg:flex-row">
        <Link to="/" aria-label="AutoCollect AI home">
          <Logo />
        </Link>
        <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted" aria-label="Footer">
          {links.map((l) => (
            <a key={l.href} href={l.href} className="hover:text-ink">
              {l.label}
            </a>
          ))}
          <Link to="/terms" className="hover:text-ink">
            Terms
          </Link>
          <Link to="/privacy" className="hover:text-ink">
            Privacy
          </Link>
          <a href={`mailto:${CONTACT_EMAIL}`} className="hover:text-ink">
            Contact
          </a>
        </nav>
        <p className="text-sm text-muted">&copy; {new Date().getFullYear()} AutoCollect AI</p>
      </div>
    </footer>
  );
}
