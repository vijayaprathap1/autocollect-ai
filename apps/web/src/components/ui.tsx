import { clsx, type ClassValue } from "clsx";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const buttonStyles: Record<ButtonVariant, string> = {
  primary: "bg-primary hover:bg-primary-hover text-white shadow-sm",
  secondary: "bg-surface border border-line text-ink hover:bg-bg",
  ghost: "text-primary hover:bg-primary/10",
  danger: "bg-danger text-white hover:opacity-90",
};

export function Button({
  variant = "primary",
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition duration-200 active:scale-[0.98]",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        buttonStyles[variant],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function Card({ className, children }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div className={cn("rounded-2xl border border-line bg-surface p-6 shadow-card", className)}>
      {children}
    </div>
  );
}

const badgeTones: Record<string, string> = {
  open: "bg-primary/10 text-primary border-primary/20",
  paid: "bg-success/10 text-success border-success/25",
  overdue: "bg-warning/15 text-warning border-warning/30",
  paused: "bg-warning/15 text-warning border-warning/30",
  void: "bg-bg text-muted border-line",
  uncollectible: "bg-danger/10 text-danger border-danger/25",
  sent: "bg-primary/10 text-primary border-primary/20",
  delivered: "bg-bg text-ink border-line",
  opened: "bg-primary/10 text-primary border-primary/20",
  clicked: "bg-success/10 text-success border-success/25",
  bounced: "bg-danger/10 text-danger border-danger/25",
  failed: "bg-danger/10 text-danger border-danger/25",
  dispute: "bg-danger/10 text-danger border-danger/25",
  promise: "bg-success/10 text-success border-success/25",
  question: "bg-primary/10 text-primary border-primary/20",
  junk: "bg-bg text-muted border-line",
};

export function Badge({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium capitalize",
        badgeTones[tone] ?? "bg-bg text-muted border-line",
      )}
    >
      {children}
    </span>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        "w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink outline-none",
        "focus:ring-2 focus:ring-primary/30 focus:border-primary",
        props.className,
      )}
    />
  );
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cn(
        "w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink outline-none",
        "focus:ring-2 focus:ring-primary/30 focus:border-primary",
        props.className,
      )}
    />
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      {label}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <Card className="flex flex-col items-center gap-3 py-16 text-center">
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="max-w-md text-sm text-muted">{description}</p>
      {action}
    </Card>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex items-start justify-between">
      <div>
        <h1 className="text-[1.75rem] font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

export function Pagination({
  page,
  hasMore,
  onPageChange,
  disabled = false,
}: {
  page: number;
  hasMore: boolean;
  onPageChange: (page: number) => void;
  disabled?: boolean;
}) {
  if (page === 0 && !hasMore) return null;

  return (
    <div className="flex items-center justify-between border-t border-line px-4 py-3">
      <span className="text-sm text-muted">Page {page + 1}</span>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          className="px-3 py-1.5 text-sm"
          disabled={disabled || page === 0}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </Button>
        <Button
          variant="secondary"
          className="px-3 py-1.5 text-sm"
          disabled={disabled || !hasMore}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

export { ToastProvider, useToast, type ToastVariant } from "./Toast";
export { OnboardingModal, shouldShowOnboarding } from "./OnboardingModal";
