"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { browserClient } from "@/lib/supabase/browser";

export function JoinForm({ token }: { token: string }) {
  const router = useRouter();
  const [me, setMe] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function join(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { data, error } = await browserClient().rpc("accept_invite", { token, my_name: me });
    if (error || !data) {
      setBusy(false);
      return setError(error?.message ?? "Something went wrong. Try again.");
    }
    router.push(`/t/${data}`);
  }

  return (
    <form onSubmit={join} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <label className="label" htmlFor="me">Your name</label>
        <input id="me" className="field" required maxLength={60} value={me} onChange={(e) => setMe(e.target.value)} />
      </div>
      {error && <div className="error">{error}</div>}
      <button className="btn" disabled={busy || !me.trim()}>{busy ? "Joining…" : "Join"}</button>
    </form>
  );
}
