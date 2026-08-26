import { clsx, type ClassValue } from "clsx";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const buttonStyles: Record<ButtonVariant, string> = {
  primary: "bg-primary hover:bg-primary-hover text-white",
  secondary: "bg-surface border border-slate-200 text-ink hover:bg-slate-50",
  ghost: "text-primary hover:bg-blue-50",
  danger: "bg-danger hover:bg-red-700 text-white",
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
        "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
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
    <div className={cn("rounded-xl border border-slate-200 bg-surface p-6 shadow-sm", className)}>
      {children}
    </div>
  );
}

const badgeTones: Record<string, string> = {
  open: "bg-blue-50 text-blue-700 border-blue-200",
  paid: "bg-green-50 text-green-700 border-green-200",
  overdue: "bg-amber-50 text-amber-700 border-amber-200",
  paused: "bg-orange-50 text-orange-700 border-orange-200",
  void: "bg-slate-100 text-slate-600 border-slate-200",
  uncollectible: "bg-red-50 text-red-700 border-red-200",
  sent: "bg-blue-50 text-blue-700 border-blue-200",
  delivered: "bg-slate-100 text-slate-700 border-slate-200",
  opened: "bg-blue-50 text-blue-700 border-blue-200",
  clicked: "bg-green-50 text-green-700 border-green-200",
  bounced: "bg-red-50 text-red-700 border-red-200",
  failed: "bg-red-50 text-red-700 border-red-200",
  dispute: "bg-red-50 text-red-700 border-red-200",
  promise: "bg-green-50 text-green-700 border-green-200",
  question: "bg-blue-50 text-blue-700 border-blue-200",
  junk: "bg-slate-100 text-slate-600 border-slate-200",
};

export function Badge({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium capitalize",
        badgeTones[tone] ?? "bg-slate-100 text-slate-600 border-slate-200",
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
        "w-full rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm outline-none",
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
        "w-full rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm outline-none",
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
        <h1 className="text-2xl font-bold">{title}</h1>
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
    <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3">
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