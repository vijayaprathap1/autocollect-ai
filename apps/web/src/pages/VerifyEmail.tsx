import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { verifyEmail } from "@/lib/api";
import { Spinner } from "@/components/ui";
import { AuthLayout } from "@/components/auth";

export function VerifyEmail() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"loading" | "done" | "error">("loading");
  const [error, setError] = useState("");
  // Tokens are single-use: guard against React StrictMode's double effect run.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = params.get("token");
    if (!token) {
      setStatus("error");
      setError("This verification link is missing its token.");
      return;
    }
    verifyEmail(token)
      .then(async (res) => {
        if (res.signedIn) {
          await queryClient.invalidateQueries({ queryKey: ["me"] });
          navigate("/dashboard?welcome=1", { replace: true });
          return;
        }
        setStatus("done");
      })
      .catch((err: Error) => {
        setStatus("error");
        setError(err.message);
      });
  }, [params, navigate, queryClient]);

  return (
    <AuthLayout title={status === "error" ? "Verification failed" : status === "done" ? "Email verified" : "Verifying your email"}>
      {status === "loading" && <Spinner label="One moment…" />}
      {status === "done" && (
        <div className="space-y-3 text-sm text-muted">
          <p>Your email is confirmed.</p>
          <Link to="/login" className="font-medium text-primary hover:underline">
            Sign in →
          </Link>
        </div>
      )}
      {status === "error" && (
        <div className="space-y-3 text-sm text-muted">
          <p>{error}</p>
          <p>
            Links expire after 24 hours. Sign in and we'll offer to send a fresh one.{" "}
            <Link to="/login" className="font-medium text-primary hover:underline">
              Go to sign in
            </Link>
          </p>
        </div>
      )}
    </AuthLayout>
  );
}
