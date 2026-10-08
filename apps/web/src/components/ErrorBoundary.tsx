import { Component, type ErrorInfo, type ReactNode } from "react";

type State = { error: Error | null };

/**
 * Catches render errors so one broken page never blanks the whole app.
 * Lazy-loaded chunks that fail after a deploy (stale index.html) trigger a
 * one-time reload to pick up the new build.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const chunkFailed = /Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed/i.test(error.message);
    if (chunkFailed && !sessionStorage.getItem("ac-chunk-reload")) {
      sessionStorage.setItem("ac-chunk-reload", "1");
      window.location.reload();
      return;
    }
    console.error("UI error", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="max-w-md rounded-xl border border-slate-200 bg-surface p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="mt-2 text-sm text-muted">This page hit an unexpected error. Your data is safe.</p>
          <div className="mt-4 flex justify-center gap-2">
            <button className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white" onClick={() => window.location.reload()}>
              Reload
            </button>
            <a className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium" href="/dashboard">
              Go to dashboard
            </a>
          </div>
        </div>
      </div>
    );
  }
}
