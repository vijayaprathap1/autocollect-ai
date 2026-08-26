import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "@/lib/api";

export function VerifyEmail() {
  const [params] = useSearchParams();
  const [status, setStatus] = useState<"loading" | "done" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    const token = params.get("token");
    if (!token) {
      setStatus("error");
      setError("No verification token provided");
      return;
    }
    api.post("/auth/verify-email", { token })
      .then(() => setStatus("done"))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "Verification failed";
        setStatus("error");
        setError(msg);
      });
  }, [params]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm text-center">
        <div className="text-2xl font-bold text-primary mb-2">AutoCollect AI</div>
        <div className="rounded-xl border border-slate-200 bg-surface p-6 shadow-sm">
          {status === "loading" && (
            <p className="text-sm text-muted">Verifying your email…</p>
          )}
          {status === "done" && (
            <>
              <h2 className="text-lg font-semibold mb-2 text-green-700">Email verified</h2>
              <p className="text-sm text-muted mb-4">Your email has been verified. You can now use your account.</p>
              <Link to="/login" className="text-sm text-primary hover:underline">Sign in →</Link>
            </>
          )}
          {status === "error" && (
            <>
              <h2 className="text-lg font-semibold mb-2 text-red-700">Verification failed</h2>
              <p className="text-sm text-muted mb-4">{error}</p>
              <Link to="/login" className="text-sm text-primary hover:underline">← Back to sign in</Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
