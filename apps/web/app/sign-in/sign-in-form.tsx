"use client";

import { Check } from "@/components/icons";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { browserClient } from "@/lib/supabase/browser";
import s from "@/components/auth.module.css";

// Email, then the code from the email. No passwords.
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
    setWait(45);
  }

  // A new code can be asked for once the last one has had time to arrive.
  const [wait, setWait] = useState(0);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  // Once at a time: a second press while the first was on its way sent two codes, and the first stopped working.
  async function resend() {
    if (busy) return;
    setError("");
    setCode("");
    setBusy(true);
    const { error } = await browserClient().auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: true } });
    setBusy(false);
    if (error) return setError(error.message);
    setWait(45);
  }

  async function checkCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { error } = await browserClient().auth.verifyOtp({ email: email.trim(), token: code.replace(/\D/g, ""), type: "email" });
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
          <input id="email" className="field" type="email" autoComplete="email" autoFocus required value={email}
            onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </div>
        {error && <div className="error">{error}</div>}
        <button className="btn" disabled={busy || !email.trim()}>{busy ? "Sending…" : "Send me a code"}</button>
      </form>
    );
  }

  const digits = code.replace(/\D/g, "").slice(0, 8);
  const slots = Math.max(6, digits.length);
  return (
    <form onSubmit={checkCode} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className={s.sent}>
        <span className={s.sentIcon}><Check size={18} stroke={2.6} /></span>
        <span>We sent a code to <strong>{email.trim()}</strong>.</span>
      </div>
      <div>
        <label className="label" htmlFor="code">The code</label>
        <div className={s.code}>
          <div className={s.slots} aria-hidden="true">
            {Array.from({ length: slots }, (_, n) => (
              <div key={n} className={`${s.slot} ${digits[n] ? s.slotFilled : ""} ${n === Math.min(digits.length, slots - 1) ? s.slotNow : ""}`}>
                {digits[n] && <span>{digits[n]}</span>}
              </div>
            ))}
          </div>
          <input id="code" className={s.codeInput} inputMode="numeric" autoComplete="one-time-code" autoFocus required maxLength={8}
            value={digits} onChange={(e) => setCode(e.target.value)} aria-label="The code from the email" />
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <button className="btn" disabled={busy || digits.length < 6}>{busy ? "Checking…" : "Sign in"}</button>
      <div className={s.row}>
        <button type="button" className={s.quiet} disabled={busy || wait > 0} onClick={resend}>{wait > 0 ? `Send a new code in ${wait}s` : "Send a new code"}</button>
        <button type="button" className={s.quiet} onClick={() => { setStep("email"); setCode(""); setError(""); }}>Use a different email</button>
      </div>
    </form>
  );
}
