"use client";

import { useEffect, useState } from "react";
import { AI_NAME, AiLogo } from "@/components/ai-logo";
import { Bug, Crown } from "@/components/icons";
import { Time } from "@/components/time";
import { downloadExport } from "@/lib/download";
import { browserClient } from "@/lib/supabase/browser";
import { prettyModel } from "./model-pick";
import { UsagePanel } from "./usage-panel";
import type { Connection, Member } from "./types";
import s from "./panels.module.css";

const ROLE = { owner: "Owner", developer: "Developer", client: "Client" } as const;
const initial = (name: string) => name.trim().charAt(0).toUpperCase() || "?";
const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "");

// One person, in the middle of the room: who they are, when they joined, their AI and its limits, and what the
// owner may do about them.
export function PersonPanel({ table, me, person, connections, here, onGone, onNotice }: {
  table: { id: string; name: string };
  me: Member;
  person: Member;
  connections: Connection[];
  here: boolean;
  onGone: () => void;
  onNotice: (text: string) => void;
}) {
  const supabase = browserClient();
  const [asking, setAsking] = useState<"owner" | "remove" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setAsking(null); setError(""); }, [person.id]);
  const mine = person.id === me.id;
  const conn = connections.find((c) => c.member_id === person.id && !c.revoked_at);
  const model = conn ? prettyModel(conn.model_choice) ?? (conn.kind === "claude" ? "Opus 5.5" : prettyModel(conn.limits?.model)) : null;
  const first = person.display_name.split(" ")[0];

  async function run(fn: "transfer_ownership" | "remove_member", done: string) {
    setBusy(true);
    setError("");
    const { error } = await supabase.rpc(fn, { m: person.id });
    setBusy(false);
    setAsking(null);
    if (error) return setError(error.message);
    onNotice(done);
    if (fn === "remove_member") onGone();
  }

  return (
    <div className={s.page} data-testid="person-panel" key={person.id}>
      <div className={s.hero}>
        <span className={s.face} style={{ background: person.color }}>
          {initial(person.display_name)}
          {person.role === "owner" && <span className={s.crown}><Crown /></span>}
          <i className={here ? s.here : s.away} />
        </span>
        <h1 className={s.name}>{person.display_name}</h1>
        <div className={s.sub}>{ROLE[person.role]} · {here ? "here now" : "away"}</div>
      </div>

      <div className={s.facts}>
        <div className={s.fact}><span>Joined</span><b>{day(person.created_at) || "Not known"}</b></div>
        <div className={s.fact}>
          <span>AI</span>
          <b className={s.ai}>
            {conn ? <><AiLogo kind={conn.kind} size={18} />{AI_NAME[conn.kind]}{model ? ` ${model}` : ""}</> : "None connected"}
          </b>
        </div>
        {conn?.last_seen && <div className={s.fact}><span>Last answered the table&apos;s call</span><b><Time iso={conn.last_seen} style="stamp" /></b></div>}
      </div>

      {person.role !== "client" && conn && (
        <section className={s.block}>
          <h2 className={s.h2}>Usage</h2>
          <UsagePanel members={[person]} connections={connections} bare />
        </section>
      )}

      {error && <div className="error" role="alert">{error}</div>}

      {mine && (
        <section className={s.block}>
          <h2 className={s.h2}>Yours</h2>
          <div className={s.row}>
            <button className="btn btn-quiet" onClick={async () => { const p = await downloadExport("export_mine", table.id, table.name); if (p) setError(p); }}>Download what&apos;s mine</button>
          </div>
        </section>
      )}

      {me.role === "owner" && !mine && (
        <section className={s.block}>
          <h2 className={s.h2}>Owner&apos;s actions</h2>
          {asking === "owner" ? (
            <div className={s.ask}>
              <p>{first} becomes the owner and you become a developer. Only {first} can hand it back.</p>
              <div className={s.row}>
                <button className="btn" disabled={busy} onClick={() => run("transfer_ownership", `${first} now owns ${table.name}.`)}>Make {first} the owner</button>
                <button className="btn btn-quiet" onClick={() => setAsking(null)}>Keep it</button>
              </div>
            </div>
          ) : asking === "remove" ? (
            <div className={s.ask}>
              <p>{first} loses access at once and their AI is disconnected. Their messages stay.</p>
              <div className={s.row}>
                <button className="btn" disabled={busy} onClick={() => run("remove_member", `${first} was taken off the table.`)}>Take {first} off</button>
                <button className="btn btn-quiet" onClick={() => setAsking(null)}>Keep</button>
              </div>
            </div>
          ) : (
            <div className={s.row}>
              {person.role === "developer" && <button className="btn btn-quiet" onClick={() => setAsking("owner")}><Crown size={15} />Make owner</button>}
              <button className="btn btn-quiet" onClick={() => setAsking("remove")}>Take off the table</button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

type Entry = { id: number; actor: string | null; action: string; details: Record<string, string | boolean>; created_at: string };

// Every action at the table, in plain words, from the append-only log.
export function LogsPanel({ table, members }: { table: { id: string; name: string }; members: Member[] }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [names, setNames] = useState<Map<string, string>>(() => new Map(members.map((m) => [m.id, m.display_name])));
  useEffect(() => {
    let cancelled = false;
    const supabase = browserClient();
    Promise.all([
      supabase.from("activity").select("id, actor, action, details, created_at").eq("table_id", table.id).order("id", { ascending: false }).limit(300),
      supabase.from("members").select("id, display_name").eq("table_id", table.id),
    ]).then(([rows, people]: [{ data: unknown }, { data: unknown }]) => {
      if (cancelled) return;
      setNames(new Map(((people.data ?? []) as { id: string; display_name: string }[]).map((p) => [p.id, p.display_name])));
      setEntries((rows.data ?? []) as Entry[]);
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
    <div className={s.page} data-testid="logs-panel">
      <h1 className={s.title}>Logs</h1>
      {entries === null && <div className={s.loading}><i /><i /><i /></div>}
      {entries?.length === 0 && <p className="note">Nothing yet.</p>}
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
