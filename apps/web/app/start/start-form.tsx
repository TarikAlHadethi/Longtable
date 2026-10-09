"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { browserClient } from "@/lib/supabase/browser";

export function StartForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [me, setMe] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { data, error } = await browserClient().rpc("start_table", { table_name: name, my_name: me });
    if (error || !data) {
      setBusy(false);
      return setError(error?.message ?? "Something went wrong. Try again.");
    }
    router.push(`/t/${data}`);
  }

  return (
    <form onSubmit={start} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <label className="label" htmlFor="table">What are you working on?</label>
        <input id="table" className="field" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)}
          placeholder="Booking app" />
      </div>
      <div>
        <label className="label" htmlFor="me">Your name</label>
        <input id="me" className="field" required maxLength={60} value={me} onChange={(e) => setMe(e.target.value)}
          placeholder="Maya" />
      </div>
      {error && <div className="error">{error}</div>}
      <button className="btn" disabled={busy || !name.trim() || !me.trim()}>{busy ? "Starting…" : "Start the table"}</button>
    </form>
  );
}
