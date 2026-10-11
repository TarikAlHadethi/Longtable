"use client";

import { useEffect, useState } from "react";
import { Face } from "@/components/face";
import { Arrow } from "@/components/icons";
import { Time } from "@/components/time";
import { browserClient } from "@/lib/supabase/browser";
import type { Job, Member, SandboxChange } from "./types";
import room from "./room.module.css";
import s from "./sandbox-review.module.css";

const STATUS: Record<SandboxChange["status"], string> = {
  working: "Being built", ready: "Ready", nothing: "Nothing changed", passed: "Passed to the team as a request", failed: "Did not work", stopped: "Stopped",
};
const VERDICT = { take: "Taking it", differently: "Doing it differently", no: "Not this" } as const;

// A client's sandbox, as the team sees it: what they changed in their own copy, newest first, each to be taken,
// done differently, or turned down. The owner also sets it up here: on or off, where each version can be opened,
// and how many changes it takes in a day.
export function SandboxReview({ table, me, client, changes, jobs, onStop, links, onLinks, onBox, onOpenTask }: {
  table: { id: string; name: string };
  me: Member;
  client: Member;
  changes: SandboxChange[];
  // The jobs in flight, to say what the AI is on and to stop it.
  jobs: Job[];
  onStop: (jobId: string) => void;
  links: { ours: string | null; cap: number; paths: string };
  onLinks: (l: { ours: string | null; cap: number; paths: string }) => void;
  onBox: (b: { member_id: string; mode?: "chat" | "sandbox"; url?: string | null }) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const supabase = browserClient();
  const owner = me.role === "owner";
  const on = client.client_mode === "sandbox";
  const first = client.display_name.split(" ")[0];
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [noting, setNoting] = useState<{ id: string; answer: "differently" | "no" } | null>(null);
  const [note, setNote] = useState("");
  const [setup, setSetup] = useState(false);
  const [ours, setOurs] = useState(links.ours ?? "");
  const [theirs, setTheirs] = useState(client.sandbox_url ?? "");
  const [cap, setCap] = useState(String(links.cap));
  const [paths, setPaths] = useState(links.paths);
  // Before a copy is given, the owner reads what giving one means and says so.
  const [giving, setGiving] = useState(false);
  const [agreed, setAgreed] = useState(false);
  useEffect(() => { setTheirs(client.sandbox_url ?? ""); }, [client.sandbox_url]);
  useEffect(() => { setOurs(links.ours ?? ""); setCap(String(links.cap)); setPaths(links.paths); }, [links.ours, links.cap, links.paths]);

  const mine = changes.filter((c) => c.member_id === client.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const waiting = mine.filter((c) => c.status === "ready" && !c.verdict).length;

  async function turn(enabled: boolean) {
    setBusy("turn");
    setError("");
    const { error } = await supabase.rpc("set_client_sandbox", { m: client.id, enabled });
    setBusy(null);
    if (error) return setError(error.message);
    onBox({ member_id: client.id, mode: enabled ? "sandbox" : "chat" });
    setGiving(false);
  }

  async function saveLinks(e: React.FormEvent) {
    e.preventDefault();
    setBusy("links");
    setError("");
    const n = Math.min(200, Math.max(1, Number(cap) || links.cap));
    const { error } = await supabase.rpc("set_sandbox_links", { t: table.id, ours: ours.trim(), cap: n, m: client.id, theirs: theirs.trim(), folders: paths });
    setBusy(null);
    if (error) return setError(error.message);
    onLinks({ ours: ours.trim() || null, cap: n, paths: paths.split(/[,\n]/).map((x) => x.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean).join(", ") });
    onBox({ member_id: client.id, url: theirs.trim() || null });
    setSetup(false);
  }

  async function judge(c: SandboxChange, answer: "take" | "differently" | "no", words?: string) {
    setBusy(c.id);
    setError("");
    const { data, error } = await supabase.rpc("judge_change", { change: c.id, answer, said: words ?? null });
    setBusy(null);
    if (error) return setError(error.message);
    setNoting(null);
    setNote("");
    if (answer === "take" && data) onOpenTask(data as string);
  }

  return (
    <div className={s.page} data-testid="sandbox-review">
      <div className={s.head}>
        <span className={s.face} style={{ background: client.color }}><Face who={client} /></span>
        <div className={s.headText}>
          <h1 className={s.title}>{first}&apos;s own copy</h1>
          <div className={s.sub}>
            {on ? (waiting ? `${waiting} ${waiting === 1 ? "change" : "changes"} to look at` : "Nothing new to look at")
              : `${first} can only talk to the team. With a copy of their own they can change it freely, and you decide what to take.`}
          </div>
        </div>
        <div className={s.headActions}>
          {on && client.sandbox_url && <a className="btn" href={client.sandbox_url} target="_blank" rel="noreferrer" data-testid="open-theirs">Open {first}&apos;s <Arrow size={16} /></a>}
          {on && links.ours && <a className="btn btn-quiet" href={links.ours} target="_blank" rel="noreferrer" data-testid="open-ours">Open ours</a>}
          {owner && on && <button className="btn btn-quiet" onClick={() => setSetup(!setup)} aria-expanded={setup}>Set up</button>}
          {owner && !on && !giving && <button className="btn" onClick={() => setGiving(true)} data-testid="sandbox-give">Give {first} a copy</button>}
        </div>
      </div>

      {error && <div className="error" role="alert">{error}</div>}

      {owner && !on && giving && (
        <div className={s.setup} data-testid="sandbox-terms">
          <div className={s.termsTitle}>Before {first} gets a copy</div>
          <ul className={s.terms}>
            <li>What {first} asks for is built by your team&apos;s AI, on a team member&apos;s computer and plan, up to the number of changes a day you set.</li>
            <li>The copy is put up wherever your hosting puts a branch. That place must hold <b>no real keys and no real data</b>: code {first} asked for runs there.</li>
            <li>Longtable refuses changes to how the product is built, run or kept safe, and to tests. That is a strong filter, not a wall, so treat the copy as something {first} could read.</li>
            <li>Nothing {first} changes reaches the real product. You look at each change and decide.</li>
          </ul>
          <label className={s.agree}><input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} data-testid="sandbox-agree" /> Our previews hold no real keys or data.</label>
          <div className={s.setupActions}>
            <button type="button" className="btn btn-quiet" onClick={() => { setGiving(false); setAgreed(false); }}>Not now</button>
            <button type="button" className="btn" disabled={!agreed || busy === "turn"} onClick={() => turn(true)} data-testid="sandbox-on">Give {first} a copy</button>
          </div>
        </div>
      )}

      {owner && on && setup && (
        <form className={s.setup} onSubmit={saveLinks} aria-label="Set up the copy">
          <div className={s.fields}>
            <div>
              <label className="label" htmlFor="sb-theirs">Where {first}&apos;s copy opens</label>
              <input id="sb-theirs" className="field" value={theirs} onChange={(e) => setTheirs(e.target.value)} placeholder="https://" inputMode="url" />
              <div className={s.hint}>Fills itself in when your hosting tells GitHub where it put the branch <code>{client.sandbox_branch}</code>.</div>
            </div>
            <div>
              <label className="label" htmlFor="sb-ours">Where ours opens</label>
              <input id="sb-ours" className="field" value={ours} onChange={(e) => setOurs(e.target.value)} placeholder="https://" inputMode="url" />
              <div className={s.hint}>To compare the two. The same for every client at this table.</div>
            </div>
            <div>
              <label className="label" htmlFor="sb-cap">Changes a day</label>
              <input id="sb-cap" className="field" value={cap} onChange={(e) => setCap(e.target.value.replace(/\D/g, "").slice(0, 3))} inputMode="numeric" />
              <div className={s.hint}>Each one runs on the team&apos;s AI.</div>
            </div>
            <div>
              <label className="label" htmlFor="sb-paths">Folders a copy may change</label>
              <input id="sb-paths" className="field" value={paths} onChange={(e) => setPaths(e.target.value)} placeholder="app, components" />
              <div className={s.hint}>Separated by commas. Empty means anywhere Longtable&apos;s own rules allow.</div>
            </div>
          </div>
          <div className={s.setupActions}>
            <button type="button" className={room.toolLink} disabled={busy === "turn"} onClick={() => turn(false)}>Take the copy away</button>
            <button className="btn" disabled={busy === "links"}>{busy === "links" ? "Saving…" : "Save"}</button>
          </div>
        </form>
      )}

      {on && mine.length === 0 && <div className={s.empty}>{first} has not changed anything yet.</div>}

      <div className={s.list}>
        {mine.map((c) => (
          <div key={c.id} className={`${s.change} ${c.status === "ready" && !c.verdict ? s.changeNew : ""}`} data-change={c.id}>
            <div className={s.changeHead}>
              <div className={s.words}>&ldquo;{c.words}&rdquo;</div>
              <div className={s.when}><Time iso={c.created_at} style="stamp" /></div>
            </div>
            <div className={s.state}>
              <span className={`${s.pill} ${c.status === "ready" ? s.pillReady : ""}`}>{c.status === "working" && <i className={s.pulse} />}{STATUS[c.status]}</span>
              {c.status === "working" && (() => {
                const j = jobs.find((x) => x.change_id === c.id && ["queued", "running"].includes(x.status));
                return j ? <><span className={s.when}>{j.status === "queued" ? "waiting for the team's AI" : j.progress || "working"}</span><button type="button" className={room.toolLink} onClick={() => onStop(j.id)}>Stop</button></> : null;
              })()}
              {c.stale && <span className={s.stale} title="Their copy and your latest work no longer fit together in some files, so it was left on the older version.">Not on your latest</span>}
            </div>
            {c.summary && <div className={s.said}><span>What {first} was told</span>{c.summary}</div>}
            {c.detail && <div className={s.said}><span>For the team</span>{c.detail}</div>}
            {c.files.length > 0 && <div className={s.files}>{c.files.slice(0, 12).map((f) => <span key={f} className={s.file}>{f}</span>)}{c.files.length > 12 && <span className={s.file}>and {c.files.length - 12} more</span>}</div>}

            {c.verdict ? (
              <div className={s.verdict} data-testid="judged">
                <b>{VERDICT[c.verdict]}</b>{c.note ? `: ${c.note}` : ""}
                {c.verdict === "take" && c.task_id && <button className={room.toolLink} onClick={() => onOpenTask(c.task_id!)}>See the work</button>}
              </div>
            ) : c.status === "ready" && noting?.id === c.id ? (
              <form className={s.noteForm} onSubmit={(e) => { e.preventDefault(); judge(c, noting.answer, note); }}>
                <input className="field" autoFocus maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)}
                  placeholder={noting.answer === "no" ? `Why not, in words ${first} will read` : `What you will do instead, in words ${first} will read`} aria-label="A note for the client" />
                <button className="btn" disabled={busy === c.id}>{noting.answer === "no" ? "Not this" : "Do it differently"}</button>
                <button type="button" className="btn btn-quiet" onClick={() => { setNoting(null); setNote(""); }}>Back</button>
              </form>
            ) : c.status === "ready" ? (
              <div className={s.actions}>
                <button className="btn" disabled={busy === c.id} onClick={() => judge(c, "take")} data-testid="take">Take it</button>
                <button className="btn btn-quiet" onClick={() => { setNoting({ id: c.id, answer: "differently" }); setNote(""); }}>Differently</button>
                <button className="btn btn-quiet" onClick={() => { setNoting({ id: c.id, answer: "no" }); setNote(""); }}>Not this</button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
