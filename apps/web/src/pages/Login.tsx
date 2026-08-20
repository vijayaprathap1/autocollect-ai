import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { setDevUser } from "@/lib/api";
import { Button, Input } from "@/components/ui";

export function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setDevUser(email.trim());
    navigate("/dashboard", { replace: true });
    window.location.reload();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-2xl font-bold text-primary">AutoCollect AI</div>
          <p className="mt-1 text-sm text-muted">
            Stop chasing invoices. Start getting paid.
          </p>
        </div>
        <form onSubmit={submit} className="space-y-3 rounded-xl border border-slate-200 bg-surface p-6 shadow-sm">
          <label className="block text-sm font-medium">Work email</label>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@studio.com"
            autoFocus
          />
          <Button type="submit" className="w-full">
            Continue
          </Button>
          <p className="text-center text-xs text-muted">
            Dev mode — no password needed.
          </p>
        </form>
      </div>
    </div>
  );
}