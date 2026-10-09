"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { browserClient } from "@/lib/supabase/browser";

// Email, then the six-digit code from the email. No passwords.
export function SignInForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { error } = await browserClient().auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: true } });
    setBusy(false);
    if (error) return setError(error.message);
    setStep("code");
  }

  async function checkCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { error } = await browserClient().auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" });
    if (error) {
      setBusy(false);
      return setError("That code didn't work. Check it, or send a new one.");
    }
    router.replace(next);
    router.refresh();
  }

  if (step === "email") {
    return (
      <form onSubmit={sendCode} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <label className="label" htmlFor="email">Your email</label>
          <input id="email" className="field" type="email" autoComplete="email" required value={email}
            onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </div>
        {error && <div className="error">{error}</div>}
        <button className="btn" disabled={busy || !email.trim()}>{busy ? "Sending…" : "Send me a code"}</button>
      </form>
    );
  }

  return (
    <form onSubmit={checkCode} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <p className="note" style={{ margin: 0 }}>We sent a code to {email.trim()}.</p>
      <div>
        <label className="label" htmlFor="code">The code</label>
        <input id="code" className="field" inputMode="numeric" autoComplete="one-time-code" required value={code}
          onChange={(e) => setCode(e.target.value)} placeholder="123456"
          style={{ fontSize: 22, letterSpacing: "0.3em", fontFamily: "var(--font-mono)" }} />
      </div>
      {error && <div className="error">{error}</div>}
      <button className="btn" disabled={busy || code.trim().length < 6}>{busy ? "Checking…" : "Sign in"}</button>
      <button type="button" className="btn btn-quiet" onClick={() => { setStep("email"); setCode(""); setError(""); }}>
        Use a different email
      </button>
    </form>
  );
}
