"use client";

import { useEffect, useState } from "react";
import { Bug } from "@/components/icons";
import { Time } from "@/components/time";
import { browserClient } from "@/lib/supabase/browser";
import type { Member } from "./types";
import s from "./panels.module.css";

type Entry = { id: number; actor: string | null; action: string; details: Record<string, string | boolean>; created_at: string };

// What was read last time, by table, shown at once while the log is read again.
const logCache = new Map<string, Entry[]>();

// Every action at the table, in plain words, from the append-only log.
export function LogsPanel({ table, members }: { table: { id: string; name: string }; members: Member[] }) {
  const [entries, setEntries] = useState<Entry[] | null>(() => logCache.get(table.id) ?? null);
  const [names, setNames] = useState<Map<string, string>>(() => new Map(members.map((m) => [m.id, m.display_name])));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const supabase = browserClient();
    Promise.all([
      supabase.from("activity").select("id, actor, action, details, created_at").eq("table_id", table.id).order("id", { ascending: false }).limit(300),
      supabase.from("members").select("id, display_name").eq("table_id", table.id),
    ]).then(([rows, people]: [{ data: unknown; error: unknown }, { data: unknown }]) => {
      if (cancelled) return;
      // A read that failed is not an empty log: it says so, keeps whatever was shown before, and is not remembered.
      if (rows.error || !rows.data) { setFailed(true); setEntries((prev) => prev ?? []); return; }
      setFailed(false);
      setNames(new Map(((people.data ?? []) as { id: string; display_name: string }[]).map((p) => [p.id, p.display_name])));
      logCache.set(table.id, rows.data as Entry[]);
      setEntries(rows.data as Entry[]);
    });
    return () => { cancelled = true; };
  }, [table.id]);
  const clientName = members.find((m) => m.role === "client")?.display_name ?? "The client";
  const who = (e: Entry) => (e.actor ? names.get(e.actor) ?? "Someone" : "Longtable");

  function say(e: Entry) {
    const d = e.details ?? {};
    switch (e.action) {
      case "table.repo_set": return `${who(e)} ${d.set ? "said where the project's code is" : "removed the project's code address"}`;
      case "table.started": return `${who(e)} started the table "${d.name}"`;
      case "table.handed_over": return `${who(e)} made ${d.name} the owner`;
      case "invite.created": return `${who(e)} made an invite link for ${d.role === "client" ? "the client" : "a developer"}`;
      case "member.joined": return `${d.name ?? who(e)} joined as ${d.role === "client" ? "the client" : "a developer"}`;
      case "chat.renamed": return `${who(e)} renamed the chat "${d.from}" to "${d.name}"`;
      case "chat.deleted": return `${who(e)} deleted the chat "${d.name}"`;
      case "chat.created": return `${who(e)} made the chat "${d.name}"`;
      case "decision.created": return `${who(e)} asked for a decision: ${d.title}`;
      case "decision.decided": return `${who(e)} decided "${d.title}": ${d.option}`;
      case "decision.undone": return `${who(e)} undid the decision "${d.title}"`;
      case "decision.delivered": return d.told_client ? `${clientName} was told the decision "${d.title}"` : `The decision "${d.title}" took effect`;
      case "connection.paired": return `${d.name ?? who(e)} connected ${d.kind === "codex" ? "ChatGPT" : "Claude"}`;
      case "connection.removed": return `${who(e)}'s ${d.kind === "codex" ? "ChatGPT" : "Claude"} was disconnected`;
      default: return `${who(e)}: ${e.action.replace(/[._]/g, " ")}`;
    }
  }

  return (
    <div className={s.logs} data-testid="logs-panel">
      {entries === null && <div className={s.loading}><i /><i /><i /></div>}
      {failed && <p className="error" role="alert">The log could not be read just now. Open it again in a moment.</p>}
      {!failed && entries?.length === 0 && <p className="note">Nothing yet.</p>}
      <ol className={s.log}>
        {(entries ?? []).map((e, i) => (
          <li key={e.id} style={{ animationDelay: `${Math.min(i, 14) * 18}ms` }}>
            <span className={s.when}><Time iso={e.created_at} style="stamp" /></span>
            <span>{say(e)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// The little bug, bottom left: say what went wrong, and it goes to whoever runs this Longtable.
export function BugButton({ tableId, place }: { tableId: string; place: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState("");

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    setError("");
    const { error } = await browserClient().rpc("report_bug", { t: tableId, body: text, place, browser: navigator.userAgent.slice(0, 300) });
    if (error) { setState("idle"); return setError(error.message); }
    setState("sent");
    setText("");
    setTimeout(() => { setOpen(false); setState("idle"); }, 1400);
  }

  return (
    <div className={s.bug}>
      <button className={`${s.bugButton} ${open ? s.bugOn : ""}`} aria-label="Report a bug" title="Report a bug" aria-expanded={open}
        data-testid="bug" onClick={() => { setOpen(!open); setError(""); }}>
        <Bug size={17} />
      </button>
      {open && (
        <form className={s.bugCard} onSubmit={send} aria-label="Report a bug">
          {state === "sent" ? <div className={s.bugSent}>Sent. Thank you.</div> : (
            <>
              <label className={s.bugTitle} htmlFor="bug-text">What went wrong?</label>
              <textarea id="bug-text" className="field" rows={4} maxLength={4000} autoFocus value={text} onChange={(e) => setText(e.target.value)} />
              <div className="note">Goes to whoever runs this Longtable, word for word. Leave out anything private.</div>
              {error && <div className="error">{error}</div>}
              <div className={s.row}>
                <button className="btn" disabled={state === "sending" || !text.trim()}>{state === "sending" ? "Sending…" : "Send"}</button>
                <button type="button" className="btn btn-quiet" onClick={() => setOpen(false)}>Close</button>
              </div>
            </>
          )}
        </form>
      )}
    </div>
  );
}
