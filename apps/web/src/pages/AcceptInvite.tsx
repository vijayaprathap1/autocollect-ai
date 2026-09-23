import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { acceptInvitation } from "@/lib/api";

export function AcceptInvite() {
  const [params] = useSearchParams();
  const [status, setStatus] = useState<"loading" | "done" | "error" | "need-signup">("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const id = params.get("id");
    const token = params.get("token");
    if (!id || !token) {
      setStatus("error");
      setMessage("Invalid invitation link. Please ask your admin to send a new invitation.");
      return;
    }

    acceptInvitation(id, token)
      .then((res) => {
        setStatus("done");
        setMessage(res.message);
      })
      .catch((err: unknown) => {
        const apiErr = err as { code?: string; message?: string };
        if (apiErr.code === "ACCOUNT_REQUIRED") {
          setStatus("need-signup");
        } else {
          setStatus("error");
        }
        setMessage(apiErr.message ?? "Failed to accept invitation");
      });
  }, [params]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm text-center">
        <div className="text-2xl font-bold text-primary mb-2">AutoCollect AI</div>
        <div className="rounded-xl border border-slate-200 bg-surface p-6 shadow-sm">
          {status === "loading" && (
            <p className="text-sm text-muted">Accepting invitation...</p>
          )}
          {status === "done" && (
            <>
              <h2 className="text-lg font-semibold mb-2 text-green-700">Welcome!</h2>
              <p className="text-sm text-muted mb-4">{message}</p>
              <Link to="/dashboard" className="text-sm text-primary hover:underline">Go to dashboard</Link>
            </>
          )}
          {status === "need-signup" && (
            <>
              <h2 className="text-lg font-semibold mb-2">Account required</h2>
              <p className="text-sm text-muted mb-4">{message}</p>
              <Link to="/signup" className="text-sm text-primary hover:underline">Create your account</Link>
            </>
          )}
          {status === "error" && (
            <>
              <h2 className="text-lg font-semibold mb-2 text-red-700">Invitation invalid</h2>
              <p className="text-sm text-muted mb-4">{message}</p>
              <Link to="/login" className="text-sm text-primary hover:underline">Back to sign in</Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
