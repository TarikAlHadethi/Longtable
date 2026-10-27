"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Arrow, Plus } from "@/components/icons";
import { Grow } from "@/components/grow";
import { Mark, WorkingMark } from "@/components/mark";
import { browserClient } from "@/lib/supabase/browser";
import s from "@/components/auth.module.css";
import { StartForm } from "./start-form";

export type Wait = { id: string; table_id: string; table_name: string; status: "waiting" | "in" | "no"; created_at: string };

// The two ways onto a table for someone signed in: start one, or join one with the code its owners keep. After asking
// to join, they wait here until an owner lets them in, and move into the table the moment that happens.
export function StartChoices({ waits: first, code: given, join, hasTables }: { waits: Wait[]; code: string; join: boolean; hasTables: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"pick" | "start" | "join">(given || join ? "join" : "pick");
  const [waits, setWaits] = useState(first);
  // The page is read again after asking (its title changes), and what it read is what is true.
  useEffect(() => { setWaits(first); }, [first]);
  const waiting = waits.some((w) => w.status === "waiting");

  // While someone waits, ask every few seconds whether an owner answered; in, and they go straight to the table.
  const moved = useRef(false);
  const asked = useRef(new Set<string>());
  for (const w of waits) if (w.status === "waiting") asked.current.add(w.id);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(async () => {
      const { data, error } = await browserClient().rpc("my_join_requests");
      if (error || !data) return;
      const rows = data as Wait[];
      setWaits(rows);
      const now = rows.find((r) => r.status === "in" && asked.current.has(r.id));
      if (now && !moved.current) {
        moved.current = true;
        setTimeout(() => router.push(`/t/${now.table_id}`), 1100);
      }
    }, 4000);
    return () => clearInterval(t);
  }, [waiting, router]);

  async function cancel(id: string) {
    setWaits((prev) => prev.filter((w) => w.id !== id));
    const { error } = await browserClient().rpc("cancel_join", { r: id });
    if (error) setWaits(first);
  }

  const shown = waits.filter((w) => w.status === "waiting" || Date.now() - new Date(w.created_at).getTime() < 3 * 86400000);
  return (
    <>
      {shown.length > 0 && (
        <div className={s.tables} data-testid="join-waits">
          {shown.map((w) => (
            <div key={w.id} className={`${s.table} ${s.wait}`} data-status={w.status}>
              <span className={s.tableIcon}>{w.status === "waiting" ? <WorkingMark size={22} /> : <Mark size={20} />}</span>
              <span className={s.waitText}>
                <span className={s.tableName}>{w.table_name}</span>
                <span className={s.waitWhy}>{w.status === "waiting" ? "Waiting for an owner" : w.status === "in" ? "You're in. Opening it…" : "The owners didn't let you in"}</span>
              </span>
              {w.status === "waiting" && <button className={s.quiet} onClick={() => cancel(w.id)}>Cancel</button>}
            </div>
          ))}
        </div>
      )}
      <Grow>
        {mode === "pick" && (
          <div className={s.choices}>
            {(hasTables || shown.length > 0) && <div className={s.or}>Or</div>}
            <div className={s.tiles}>
              <button className={s.tile} onClick={() => setMode("start")} data-testid="choose-start">
                <span className={s.tileIcon}><Plus size={18} /></span>
                <b>Start a table</b><span>For your team, their AIs and your client</span>
              </button>
              <button className={s.tile} onClick={() => setMode("join")} data-testid="choose-join">
                <span className={s.tileIcon}><Arrow size={18} /></span>
                <b>Join a table</b><span>With the code from one of its owners</span>
              </button>
            </div>
          </div>
        )}
        {mode === "start" && (
          <div className={s.choices}>
            <StartForm />
            <button className={s.quiet} onClick={() => setMode("pick")}>Back</button>
          </div>
        )}
        {mode === "join" && (
          <div className={s.choices}>
            <JoinWithCode given={given} onWaiting={(w) => { setWaits((prev) => [w, ...prev.filter((x) => x.id !== w.id)]); setMode("pick"); router.refresh(); }} />
            <button className={s.quiet} onClick={() => setMode("pick")}>Back</button>
          </div>
        )}
      </Grow>
    </>
  );
}

// The table's code (eight letters and digits, shown in two fours), their name, and Ask to join.
function JoinWithCode({ given, onWaiting }: { given: string; onWaiting: (w: Wait) => void }) {
  const router = useRouter();
  const [code, setCode] = useState(given);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { data, error } = await browserClient().rpc("ask_to_join", { code: clean, my_name: name.trim(), note: note.trim() });
    setBusy(false);
    if (error || !data) return setError(error?.message ?? "Something went wrong. Try again.");
    const r = data as { status: "member" | "waiting" | "wrong"; table_id: string; table_name: string; request?: string };
    if (r.status === "wrong") return setError("That code does not match a table. Check it with whoever gave it to you.");
    if (r.status === "member") return router.push(`/t/${r.table_id}`);
    onWaiting({ id: r.request!, table_id: r.table_id, table_name: r.table_name, status: "waiting", created_at: new Date().toISOString() });
  }

  return (
    <form onSubmit={ask} style={{ display: "flex", flexDirection: "column", gap: 14 }} data-testid="join-form">
      <div>
        <label className="label" htmlFor="join-code">The table&apos;s code</label>
        <div className={s.code}>
          <div className={s.slots} aria-hidden="true">
            {Array.from({ length: 8 }, (_, n) => (
              <div key={n} className={`${s.slot} ${s.slotSmall} ${clean[n] ? s.slotFilled : ""} ${n === Math.min(clean.length, 7) ? s.slotNow : ""} ${n === 4 ? s.slotGap : ""}`}>
                {clean[n] && <span>{clean[n]}</span>}
              </div>
            ))}
          </div>
          <input id="join-code" className={s.codeInput} autoComplete="off" autoCapitalize="characters" spellCheck={false} autoFocus={!given} required
            value={clean} onChange={(e) => setCode(e.target.value)} aria-label="The table's code" maxLength={9} />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="join-me">Your name</label>
        <input id="join-me" className="field" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Maya" autoFocus={!!given} />
      </div>
      <div>
        <label className="label" htmlFor="join-note">A line for the owners (optional)</label>
        <input id="join-note" className="field" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Sam's designer, starting Monday" />
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      <button className="btn" disabled={busy || clean.length < 8 || !name.trim()}>{busy ? "Asking…" : "Ask to join"}</button>
      <p style={{ margin: 0, fontSize: 13.5, color: "var(--muted)", lineHeight: 1.45 }}>An owner of the table lets you in. You&apos;ll wait here until they do.</p>
    </form>
  );
}
