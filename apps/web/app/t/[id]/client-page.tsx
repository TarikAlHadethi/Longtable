"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { AI_NAME, AiLogo } from "@/components/ai-logo";
import { Arrow } from "@/components/icons";
import { Mark } from "@/components/mark";
import { downloadExport } from "@/lib/download";
import { browserClient } from "@/lib/supabase/browser";
import { ConnectModal } from "./connect-modal";
import {
  CONNECTION_COLUMNS, JOB_COLUMNS, LINE_COLUMNS, REQUEST_COLUMNS, UPDATE_COLUMNS,
  type ClientLine, type ClientUpdate, type Connection, type Job, type Request, type RequestEvent, type RequestStatus as Status,
} from "./types";
import { ProfileMenu } from "./profile-menu";
import room from "./room.module.css";
import styles from "./client.module.css";

// How each status reads to the client. Three things matter to them: it is with the team, it needs them, or it is
// settled. The team's own steps in between are the team's.
const SHOWN: Record<Status, { words: string; pill: string }> = {
  asked: { words: "With the team", pill: styles.pillWait },
  "being decided": { words: "With the team", pill: styles.pillWait },
  answered: { words: "With the team", pill: styles.pillWait },
  question: { words: "Needs your answer", pill: styles.pillAsk },
  decided: { words: "Decided", pill: styles.pillDone },
  planned: { words: "Planned", pill: styles.pillPlan },
  "ready to try": { words: "Ready to try", pill: styles.pillDone },
  done: { words: "Done", pill: styles.pillDone },
};

// A change in the client's own copy, as their page is given it: their words, where it stands, what they were told in
// plain words, and what the team made of it. Nothing of the team's part.
type Change = { id: string; words: string; status: "working" | "ready" | "nothing" | "passed" | "failed" | "stopped"; summary: string | null;
  verdict: "take" | "differently" | "no" | null; note: string | null; request_id: string | null; created_at: string; finished_at: string | null };
type Sandbox = { on: boolean; url: string | null; left: number | null; changes: Change[] };
const CHANGE: Record<Change["status"], { words: string; pill: string }> = {
  working: { words: "Being built", pill: styles.pillWait },
  ready: { words: "Ready to try", pill: styles.pillDone },
  nothing: { words: "Nothing changed", pill: styles.pillPlan },
  passed: { words: "With the team", pill: styles.pillWait },
  failed: { words: "Did not work", pill: styles.pillPlan },
  stopped: { words: "Stopped", pill: styles.pillPlan },
};
const VERDICT = { take: "The team is building this into the real thing.", differently: "The team will do this, in a different way.", no: "The team decided against this one." } as const;

const byTime = <T extends { created_at: string }>(a: T, b: T) => a.created_at.localeCompare(b.created_at);
// "Elena Ruiz" is Elena; "Dr. Ruiz" stays Dr. Ruiz, never just "Dr.".
const firstName = (name: string) => {
  const words = name.trim().split(/\s+/);
  return /^(dr|mr|mrs|ms|miss|prof|sir|dame)\.?$/i.test(words[0] ?? "") && words[1] ? `${words[0]} ${words[1]}` : words[0] || name;
};
const sentence = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? "" : "."}`;
// The line every passed-on request starts with. The state beside it already says so, so it is not said twice.
const isAck = (u: ClientUpdate) => /^(thanks, )?passed on to the team\b/i.test(u.body) && !u.replies?.length;

// Upsert by id, keeping what an older copy had.
function put<T extends { id: string | number }>(prev: T[], list: T[]) {
  const byId = new Map(prev.map((x) => [x.id, x]));
  for (const x of list) byId.set(x.id, { ...byId.get(x.id), ...x });
  return [...byId.values()];
}

// The client's page. One conversation and one box: what they said on the right, and under each thing what came of
// it, with one state and at most one thing to press. It never shows the team's side. With a copy of their own, what
// they say is built there to try; with their own assistant connected, it answers what it can and passes the rest on.
export function ClientPage({ table, me, initialRequests, initialUpdates, initialLines, initialConnections, initialJobs, viewer }: {
  table: { id: string; name: string };
  me: { id: string; display_name: string; color?: string; bubble?: string | null };
  initialRequests: Request[];
  // Kept so callers need not change; the steps the team took are no longer drawn here.
  initialEvents?: RequestEvent[];
  initialUpdates: ClientUpdate[];
  initialLines: ClientLine[];
  initialConnections: Connection[];
  initialJobs: Job[];
  // Set when someone on the team is looking at this client's page. They see what the client sees and can use none of
  // it. The client's chat with their own assistant is not the team's to read, so it is not here.
  viewer?: { onBack: () => void; others?: { id: string; display_name: string }[]; onPick?: (id: string) => void; preview?: boolean };
}) {
  const supabase = useMemo(() => browserClient(), []);
  const [requests, setRequests] = useState(initialRequests);
  const [updates, setUpdates] = useState(initialUpdates);
  const [lines, setLines] = useState(initialLines);
  const [connections, setConnections] = useState(initialConnections);
  const [jobs, setJobs] = useState(initialJobs);
  const [sandbox, setSandbox] = useState<Sandbox | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [gone, setGone] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const putRequest = useCallback((r: Request) => setRequests((prev) => put(prev, [r])), []);
  const putUpdates = useCallback((list: ClientUpdate[]) => setUpdates((prev) => put(prev, list)), []);
  const putLines = useCallback((list: ClientLine[]) => setLines((prev) => put(prev, list)), []);

  // Everything again from the database: covers the moment between the page loading and the channels opening,
  // and anything missed while a laptop slept.
  const reload = useCallback(async () => {
    const [{ data: r }, { data: up }, { data: ln }, { data: cn }, { data: jb }] = await Promise.all([
      supabase.from("requests").select(REQUEST_COLUMNS).eq("table_id", table.id).eq("member_id", me.id),
      supabase.from("client_updates").select(UPDATE_COLUMNS).eq("table_id", table.id),
      supabase.from("client_lines").select(LINE_COLUMNS).eq("table_id", table.id).eq("member_id", me.id).order("created_at").limit(200),
      supabase.from("connections").select(CONNECTION_COLUMNS).eq("table_id", table.id).eq("member_id", me.id).is("revoked_at", null),
      supabase.from("jobs").select(JOB_COLUMNS).eq("table_id", table.id).eq("member_id", me.id).in("status", ["queued", "running"]),
    ]);
    if (r) setRequests(r as Request[]);
    if (up) {
      const theirs = new Set(((r ?? []) as Request[]).map((x) => x.id));
      putUpdates((up as ClientUpdate[]).filter((u) => !viewer || !u.request_id || theirs.has(u.request_id)));
    }
    if (ln) putLines(ln as ClientLine[]);
    if (cn) setConnections(cn as Connection[]);
    if (jb) setJobs(jb as Job[]);
    if (viewer) {
      const [{ data: ch }, { data: box }] = await Promise.all([
        supabase.from("sandbox_changes").select("id, words, status, summary, verdict, note, request_id, created_at, finished_at").eq("member_id", me.id).order("created_at", { ascending: false }).limit(60),
        supabase.from("sandboxes").select("mode, url").eq("member_id", me.id).maybeSingle(),
      ]);
      const b = box as { mode?: string; url?: string | null } | null;
      if (ch) setSandbox({ on: b?.mode === "sandbox", url: b?.url ?? null, left: null, changes: ch as Change[] });
    } else {
      const { data: sb } = await supabase.rpc("client_sandbox", { t: table.id });
      if (sb) setSandbox(sb as Sandbox);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, table.id, me.id, putUpdates, putLines, !!viewer]);

  // A viewer has no place on the client's own channels: the page just reads again every few seconds.
  useEffect(() => {
    if (!viewer) return;
    reload();
    const t = setInterval(() => { if (document.visibilityState === "visible") reload(); }, viewer.preview ? 30000 : 8000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!viewer, me.id]);

  useEffect(() => {
    if (viewer) return;
    const channels: RealtimeChannel[] = [];
    let cancelled = false;
    const onChange = ({ payload }: { payload: unknown }) => {
      const { table: name, record } = (payload ?? {}) as { table?: string; record?: Record<string, unknown> };
      if (!record) return;
      if (name === "client_updates") putUpdates([record as unknown as ClientUpdate]);
      else if (name === "requests" && record.member_id === me.id) putRequest(record as unknown as Request);
      else if (name === "client_lines" && record.member_id === me.id) putLines([record as unknown as ClientLine]);
      else if (name === "jobs" && record.member_id === me.id) setJobs((prev) => put(prev, [record as unknown as Job]));
      else if (name === "sandbox_changes") reload();
      else if (name === "members" && record.id === me.id && record.removed_at) setGone(true);
      else if (name === "connections" && record.member_id === me.id) setConnections((prev) => put(prev, [record as unknown as Connection]));
    };
    (async () => {
      await supabase.realtime.setAuth();
      if (cancelled) return;
      for (const topic of [`client:${table.id}`, `client:${table.id}:${me.id}`]) {
        const ch = supabase.channel(topic, { config: { private: true } });
        ch.on("broadcast", { event: "INSERT" }, onChange)
          .on("broadcast", { event: "UPDATE" }, onChange)
          .subscribe(async (status: string) => {
            if (status === "SUBSCRIBED" && topic.endsWith(me.id)) reload();
            if (status === "CHANNEL_ERROR") {
              const { data, error } = await supabase.from("members").select("id").eq("id", me.id).maybeSingle();
              if (!error && !data) {
                setGone(true);
                for (const c of channels) supabase.removeChannel(c);
              }
            }
          });
        channels.push(ch);
      }
    })();
    return () => {
      cancelled = true;
      for (const ch of channels) supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, table.id, me.id, reload, putRequest, putUpdates, putLines, !!viewer]);

  const mine = connections.find((c) => !c.revoked_at);
  const thinking = jobs.some((j) => j.kind === "client" && (j.status === "queued" || j.status === "running"));
  const building = !!sandbox?.changes.some((c) => c.status === "working");

  // Back to the tab, and every so often while something of theirs is in the works: read the database too, so a lost
  // push only delays what they see.
  const pending = requests.some((r) => ["asked", "being decided", "question", "answered"].includes(r.status));
  useEffect(() => {
    if (viewer) return;
    const onShow = () => { if (document.visibilityState === "visible") reload(); };
    document.addEventListener("visibilitychange", onShow);
    const t = setInterval(() => { if (document.visibilityState === "visible") reload(); }, thinking || building ? 4000 : pending ? 15000 : 60000);
    return () => {
      document.removeEventListener("visibilitychange", onShow);
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, thinking, building, reload, !!viewer]);

  // One conversation, in the order things happened.
  type Item =
    | { kind: "request"; id: string; created_at: string; r: Request }
    | { kind: "change"; id: string; created_at: string; c: Change }
    | { kind: "line"; id: string; created_at: string; me: boolean; own: boolean; text: string; question?: ClientUpdate };
  const feed = useMemo(() => {
    const passed = new Set((sandbox?.changes ?? []).map((c) => c.request_id).filter(Boolean));
    const items: Item[] = [
      // A request that came out of a change in their copy is told under that change, not twice.
      ...requests.filter((r) => !passed.has(r.id)).map((r): Item => ({ kind: "request", id: `r-${r.id}`, created_at: r.created_at, r })),
      ...(sandbox?.changes ?? []).map((c): Item => ({ kind: "change", id: `c-${c.id}`, created_at: c.created_at, c })),
      // Their own words to their assistant show as a line unless they became a request, which carries them.
      ...lines.filter((l) => !(l.who === "client" && l.request_id)).map((l): Item => ({ kind: "line", id: `l-${l.id}`, created_at: l.created_at, me: l.who === "client", own: true, text: l.body })),
      // What every client was told, with no request of theirs behind it.
      ...updates.filter((u) => !u.request_id).map((u): Item => ({ kind: "line", id: `u-${u.id}`, created_at: u.created_at, me: false, own: false, text: u.body, question: u.replies?.length && !u.answer ? u : undefined })),
    ];
    return items.sort(byTime);
  }, [requests, lines, updates, sandbox]);
  const told = (requestId: string) => updates.filter((u) => u.request_id === requestId && !isAck(u)).sort(byTime);

  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [feed.length, thinking, building]);

  // One tap answers the team's question. It shows at once; the database decides whether it counts.
  async function answer(u: ClientUpdate, choice: number) {
    setError("");
    putUpdates([{ ...u, answer: u.replies[choice - 1], answered_at: new Date().toISOString() }]);
    const { error } = await supabase.rpc("client_reply", { u: u.id, choice });
    if (error) {
      putUpdates([u]);
      setError(sentence(error.message));
    }
    reload();
  }

  function grow() {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  // What they type goes to their copy when they have one, to their own assistant when it is on, and otherwise
  // straight to the team.
  async function say() {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError("");
    const { data, error } = await supabase.rpc("client_say", { t: table.id, body });
    setBusy(false);
    if (error) return setError(sentence(error.message));
    setDraft("");
    requestAnimationFrame(grow);
    // When their copy could not take it, the words went to the team instead, and they are told why.
    const why = (data as { why?: string } | null)?.why;
    setNotice(why === "asleep" ? "Your copy cannot be changed right now, so this went to the team instead." : why === "full" ? "That is all the changes your copy takes in a day, so this went to the team instead." : "");
    await reload();
  }

  async function disconnect() {
    if (mine) await supabase.rpc("disconnect", { conn: mine.id });
    reload();
  }

  if (gone) {
    return (
      <main className="page-center">
        <div className="panel" style={{ alignItems: "center", textAlign: "center" }}>
          <Mark size={48} />
          <h1>This page is closed</h1>
          <p className="note" style={{ margin: 0 }}>The team may have closed it, or taken you off it. <Link href="/">Back to the start</Link></p>
        </div>
      </main>
    );
  }

  const first = firstName(me.display_name);
  // Who is answering on the left: their copy, their own assistant, or the team. Beside the name, the one state.
  const speaker = (who: "copy" | "assistant" | "team", pill?: { words: string; pill: string; testid: string; busy?: boolean }) => (
    <div className={styles.from}>
      {who === "assistant" && mine ? <AiLogo kind={mine.kind} size={18} /> : <Mark size={18} />}
      <span className={styles.fromName}>{who === "copy" ? "Your copy" : who === "assistant" ? "Your assistant" : "The team"}</span>
      {pill && <span className={`${styles.pill} ${pill.pill}`} data-testid={pill.testid}>{pill.busy && <i className={styles.pulse} />}{pill.words}</span>}
    </div>
  );
  const answers = (u: ClientUpdate) => (
    <div key={u.id} className={styles.said}>
      {u.body}
      {u.replies?.length > 0 && !u.answer && (
        <div className={styles.replies} data-testid="replies">
          {u.replies.map((label, k) => (
            <button key={label} className={styles.reply} disabled={!!viewer} onClick={() => answer(u, k + 1)}>{label}</button>
          ))}
        </div>
      )}
      {u.answer && <div className={styles.answered}>You answered: {u.answer}</div>}
    </div>
  );
  const myWords = (text: string) => (
    <div className={styles.mine}><div className={room.bubble} data-bubble={me.bubble ?? "stone"}>{text}</div></div>
  );

  return (
    <div className={`${room.shell} ${room.shellWide} ${styles.client}`} data-testid={viewer && !viewer.preview ? "client-view" : undefined}>
      <header className={room.header}>
        <div className={`${room.brand} ${styles.brand}`}><Mark size={26} /> Longtable</div>
        <div className={room.divider} />
        <div className={room.project}>{table.name}</div>
        <div className={room.spacer} />
        {sandbox?.on && sandbox.url && (
          <a className={`btn btn-quiet ${styles.openCopy}`} href={sandbox.url} target="_blank" rel="noreferrer" data-testid="open-copy">{viewer ? `Open ${first}'s copy` : "Open my copy"} <Arrow size={15} /></a>
        )}
        {viewer ? (
          <button className="btn" onClick={viewer.onBack} data-testid={viewer.preview ? undefined : "table-portal"}>Back to the table</button>
        ) : (
          <ProfileMenu me={{ id: me.id, display_name: me.display_name, role: "client", color: me.color ?? "var(--sage)" }} tableId={table.id}
            ai={mine?.kind ?? null} aiWord="assistant"
            onConnect={sandbox?.on ? undefined : () => setConnectOpen(true)} onDisconnect={sandbox?.on ? undefined : disconnect}
            onDownload={() => downloadExport("export_mine", table.id, table.name)} privacy />
        )}
      </header>

      {viewer && !viewer.preview && (
        <div className={styles.viewing} data-testid="viewing">
          <span>You are looking at {first}&apos;s side. Nothing here can be changed.</span>
          {(viewer.others?.length ?? 0) > 1 && viewer.others!.map((o) => (
            <button key={o.id} className={`${styles.other} ${o.id === me.id ? styles.otherOn : ""}`} onClick={() => viewer.onPick?.(o.id)}>{firstName(o.display_name)}</button>
          ))}
        </div>
      )}

      <main className={styles.thread}>
        <div ref={chatRef} className={styles.scroll} data-testid="client-chat" data-with={sandbox?.on ? "copy" : mine ? "assistant" : "team"}>
          <div className={styles.col}>
            {feed.length === 0 && (
              <div className={styles.empty} data-testid="chat-head">
                {sandbox?.on ? `Say what you would like changed in ${table.name}. It is built in your own copy for you to try, and the team decides what goes into the real thing.`
                  : mine ? `Ask where anything stands, or for something new. Your ${AI_NAME[mine.kind]} answers what it can and passes the rest to the team.`
                  : `Ask the team for anything about ${table.name}, in your own words. You hear back here.`}
              </div>
            )}
            {feed.map((item) => {
              if (item.kind === "line") {
                if (item.me) return <div key={item.id} className={styles.turn}>{myWords(item.text)}</div>;
                return (
                  <div key={item.id} className={styles.turn}>
                    <div className={styles.back}>
                      {speaker(item.own ? "assistant" : "team")}
                      <div className={styles.said}>
                        {item.text}
                        {item.question && (
                          <div className={styles.replies} data-testid="replies">
                            {item.question.replies.map((label, k) => (
                              <button key={label} className={styles.reply} disabled={!!viewer} onClick={() => answer(item.question!, k + 1)}>{label}</button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              }
              if (item.kind === "change") {
                const c = item.c;
                const asked = c.request_id ? requests.find((r) => r.id === c.request_id) : undefined;
                const shown = asked ? SHOWN[asked.status] ?? CHANGE[c.status] : CHANGE[c.status];
                return (
                  <div key={item.id} className={styles.turn} data-change={c.id}>
                    {myWords(c.words)}
                    <div className={styles.back}>
                      {speaker(asked ? "team" : "copy", { ...shown, testid: "change-status", busy: c.status === "working" })}
                      {c.summary && <div className={styles.said}>{c.summary}</div>}
                      {c.request_id && told(c.request_id).map(answers)}
                      {c.status === "ready" && sandbox?.url && !c.verdict && (
                        <a className={`btn ${styles.tryIt}`} href={sandbox.url} target="_blank" rel="noreferrer" data-testid="try-it">Try it <Arrow size={16} /></a>
                      )}
                      {c.verdict && <div className={`${styles.verdict} ${c.verdict === "no" ? styles.verdictNo : ""}`} data-testid="verdict">{VERDICT[c.verdict]}{c.note ? ` ${c.note}` : ""}</div>}
                    </div>
                  </div>
                );
              }
              const r = item.r;
              const shown = SHOWN[r.status] ?? SHOWN.asked;
              return (
                <div key={item.id} className={styles.turn} data-request={r.id}>
                  {myWords(r.body)}
                  <div className={styles.back}>
                    {speaker("team", { ...shown, testid: "status" })}
                    {told(r.id).map(answers)}
                  </div>
                </div>
              );
            })}
            {thinking && <div className={styles.writing} data-testid="thinking"><i className={styles.pulse} />Your assistant is writing…</div>}
            {viewer && mine && <div className={styles.private}>{first}&apos;s chat with their own assistant is private and is not shown.</div>}
          </div>
        </div>

        <div className={styles.foot}>
          <div className={styles.col}>
            <form className={room.composer} onSubmit={(e) => { e.preventDefault(); if (!viewer) say(); }}>
              <textarea ref={inputRef} className={room.input} rows={1} value={draft} disabled={!!viewer} maxLength={4000}
                placeholder={viewer ? "Only they can write here" : sandbox?.on ? "Say what you want changed" : "Ask for something, in your own words"} aria-label="Ask the team"
                onChange={(e) => { setDraft(e.target.value); grow(); }}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!viewer) say(); } }} />
              <button className="btn" disabled={!!viewer || busy || !draft.trim()}>Send</button>
            </form>
            {/* How many changes are left only matters when it is nearly none. */}
            {sandbox?.on && !viewer && sandbox.left !== null && sandbox.left <= 3 && (
              <div className={styles.footNote} data-testid="changes-left">{sandbox.left === 0 ? "No changes left today. What you say goes to the team." : `${sandbox.left} ${sandbox.left === 1 ? "change" : "changes"} left today`}</div>
            )}
            {notice && <div className={styles.footNote} role="status">{notice}</div>}
            {error && <div className="error" role="alert">{error}</div>}
          </div>
        </div>
      </main>

      {connectOpen && (
        <ConnectModal audience="client" tableId={table.id} tableName={table.name} connected={mine?.kind ?? null} onClose={() => setConnectOpen(false)} />
      )}
    </div>
  );
}
