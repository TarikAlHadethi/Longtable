"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { Mark } from "@/components/mark";
import { Time, useInBrowser } from "@/components/time";
import { downloadExport } from "@/lib/download";
import { browserClient } from "@/lib/supabase/browser";
import { ConnectModal } from "./connect-modal";
import {
  CONNECTION_COLUMNS, EVENT_COLUMNS, JOB_COLUMNS, LINE_COLUMNS, REQUEST_COLUMNS, UPDATE_COLUMNS,
  type ClientLine, type ClientUpdate, type Connection, type Job, type Request, type RequestEvent, type RequestStatus as Status,
} from "./types";
import { ProfileMenu } from "./profile-menu";
import { AI_NAME, AiLogo } from "@/components/ai-logo";
import { Arrow, Plus } from "@/components/icons";
import room from "./room.module.css";
import tv from "./table-view.module.css";
import styles from "./client.module.css";

// How each status reads to the client, its pill, and the step still to come, in the design's words.
const SHOWN: Record<Status, { words: string; pill: string; next?: string }> = {
  asked: { words: "With the team", pill: styles.pillWait, next: "With the team" },
  "being decided": { words: "Being decided", pill: styles.pillWait, next: "Waiting on the team's decision" },
  question: { words: "Question for you", pill: styles.pillAsk, next: "Waiting for your answer" },
  answered: { words: "With the team", pill: styles.pillWait, next: "The team is finalizing" },
  decided: { words: "Decided", pill: styles.pillDone },
  planned: { words: "Planned", pill: styles.pillPlan },
  "ready to try": { words: "Ready to try", pill: styles.pillDone },
  done: { words: "Done", pill: styles.pillDone },
};
// A change in the client's own sandbox, as their page is given it: their words, where it stands, what the AI said
// in plain words, and what the team made of it. Nothing of the team's part.
type Change = { id: string; words: string; status: "working" | "ready" | "nothing" | "passed" | "failed" | "stopped"; summary: string | null;
  verdict: "take" | "differently" | "no" | null; note: string | null; request_id: string | null; created_at: string; finished_at: string | null };
type Sandbox = { on: boolean; url: string | null; left: number; changes: Change[] };
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
// "Elena Ruiz" is greeted as Elena; "Dr. Ruiz" stays Dr. Ruiz, never just "Dr.".
const firstName = (name: string) => {
  const words = name.trim().split(/\s+/);
  return /^(dr|mr|mrs|ms|miss|prof|sir|dame)\.?$/i.test(words[0] ?? "") && words[1] ? `${words[0]} ${words[1]}` : words[0] || name;
};
const sentence = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? "" : "."}`;

function greeting(name: string) {
  const h = new Date().getHours();
  return `${h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"}, ${firstName(name)}`;
}

// Upsert by id, keeping what an older copy had.
function put<T extends { id: string | number }>(prev: T[], list: T[]) {
  const byId = new Map(prev.map((x) => [x.id, x]));
  for (const x of list) byId.set(x.id, { ...byId.get(x.id), ...x });
  return [...byId.values()];
}

// The client's page: what they asked for, where each request stands, and what the team decided, in plain words.
// It never shows the team side. With their own AI connected, the chat is with it: it answers what it can from their
// own requests and passes the rest on. Everything arrives live on two private channels: the table's, for what
// every client is told, and the client's own.
export function ClientPage({ table, me, initialRequests, initialEvents, initialUpdates, initialLines, initialConnections, initialJobs, viewer, start = "talk" }: {
  table: { id: string; name: string };
  me: { id: string; display_name: string; color?: string };
  initialRequests: Request[];
  initialEvents: RequestEvent[];
  initialUpdates: ClientUpdate[];
  initialLines: ClientLine[];
  initialConnections: Connection[];
  initialJobs: Job[];
  // Set when someone on the team is looking at this client's page. They see what the client sees and can use none of
  // it: nothing is sent, answered or connected from here. The client's chat with their own AI is not theirs to read,
  // so it is not here.
  // Where it opens: on the tree, like the team's side, or straight on the chat.
  start?: "tree" | "talk";
  viewer?: { onBack: () => void; others?: { id: string; display_name: string }[]; onPick?: (id: string) => void; preview?: boolean };
}) {
  const supabase = useMemo(() => browserClient(), []);
  const here = useInBrowser();
  // On a phone the menu is a drawer, opened from the top bar as on the team's side.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [requests, setRequests] = useState(initialRequests);
  const [events, setEvents] = useState(initialEvents);
  const [updates, setUpdates] = useState(initialUpdates);
  const [lines, setLines] = useState(initialLines);
  const [connections, setConnections] = useState(initialConnections);
  const [jobs, setJobs] = useState(initialJobs);
  const [sandbox, setSandbox] = useState<Sandbox | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [connectOpen, setConnectOpen] = useState(false);
  const [view, setView] = useState<"tree" | "talk">(start);
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [gone, setGone] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);

  const putRequest = useCallback((r: Request) => setRequests((prev) => put(prev, [r])), []);
  const putEvents = useCallback((list: RequestEvent[]) => setEvents((prev) => put(prev, list)), []);
  const putUpdates = useCallback((list: ClientUpdate[]) => setUpdates((prev) => put(prev, list)), []);
  const putLines = useCallback((list: ClientLine[]) => setLines((prev) => put(prev, list)), []);

  // Everything again from the database: covers the moment between the page loading and the channels opening,
  // and anything missed while a laptop slept.
  const reload = useCallback(async () => {
    const [{ data: r }, { data: ev }, { data: up }, { data: ln }, { data: cn }, { data: jb }] = await Promise.all([
      supabase.from("requests").select(REQUEST_COLUMNS).eq("table_id", table.id).eq("member_id", me.id),
      supabase.from("request_events").select(EVENT_COLUMNS).eq("table_id", table.id),
      supabase.from("client_updates").select(UPDATE_COLUMNS).eq("table_id", table.id),
      supabase.from("client_lines").select(LINE_COLUMNS).eq("table_id", table.id).eq("member_id", me.id).order("created_at").limit(200),
      supabase.from("connections").select(CONNECTION_COLUMNS).eq("table_id", table.id).eq("member_id", me.id).is("revoked_at", null),
      supabase.from("jobs").select(JOB_COLUMNS).eq("table_id", table.id).eq("member_id", me.id).in("status", ["queued", "running"]),
    ]);
    if (r) setRequests(r as Request[]);
    if (ev) putEvents(ev as RequestEvent[]);
    if (up) {
      const theirs = new Set(((r ?? []) as Request[]).map((x) => x.id));
      putUpdates((up as ClientUpdate[]).filter((u) => !viewer || !u.request_id || theirs.has(u.request_id)));
    }
    if (ln) putLines(ln as ClientLine[]);
    if (cn) setConnections(cn as Connection[]);
    if (jb) setJobs(jb as Job[]);
    if (viewer) {
      const [{ data: ch }, { data: mem }] = await Promise.all([
        supabase.from("sandbox_changes").select("id, words, status, summary, verdict, note, request_id, created_at, finished_at").eq("member_id", me.id).order("created_at", { ascending: false }).limit(60),
        supabase.from("sandboxes").select("mode, url").eq("member_id", me.id).maybeSingle(),
      ]);
      const m = mem as { mode?: string; url?: string | null } | null;
      if (ch) setSandbox({ on: m?.mode === "sandbox", url: m?.url ?? null, left: 0, changes: ch as Change[] });
    } else {
      const { data: sb } = await supabase.rpc("client_sandbox", { t: table.id });
      if (sb) setSandbox(sb as Sandbox);
    }
  }, [supabase, table.id, me.id, putEvents, putUpdates, putLines]);

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
      else if (name === "request_events") putEvents([record as unknown as RequestEvent]);
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
  }, [supabase, table.id, me.id, reload, putRequest, putEvents, putUpdates, putLines, !!viewer]);

  const mine = connections.find((c) => !c.revoked_at);
  const assistant = !!mine;
  const thinking = jobs.some((j) => j.kind === "client" && (j.status === "queued" || j.status === "running"));
  const building = !!sandbox?.changes.some((c) => c.status === "working");

  // Back to the tab, and every so often while their AI is writing or the team is on something they asked: read the
  // database too, so a lost push only delays what they see.
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

  // One feed, in the order things happened: each thing they asked for is a card that carries what the team said about
  // it; each change in their sandbox is a card with a way to try it; anything else said is a line.
  type Item =
    | { kind: "request"; id: string; created_at: string; r: Request }
    | { kind: "change"; id: string; created_at: string; c: Change }
    | { kind: "line"; id: string; created_at: string; me: boolean; text: string; question?: ClientUpdate };
  const feed = useMemo(() => {
    const passed = new Set((sandbox?.changes ?? []).map((c) => c.request_id).filter(Boolean));
    const items: Item[] = [
      // A request that came out of a sandbox change is told on that change's card, not twice.
      ...requests.filter((r) => !passed.has(r.id)).map((r): Item => ({ kind: "request", id: `r-${r.id}`, created_at: r.created_at, r })),
      ...(sandbox?.changes ?? []).map((c): Item => ({ kind: "change", id: `c-${c.id}`, created_at: c.created_at, c })),
      // Their own words to their assistant show as a line unless they became a request, whose card carries them.
      ...lines.filter((l) => !(l.who === "client" && l.request_id)).map((l): Item => ({ kind: "line", id: `l-${l.id}`, created_at: l.created_at, me: l.who === "client", text: l.body })),
      // What every client was told, with no request of theirs behind it.
      ...updates.filter((u) => !u.request_id).map((u): Item => ({ kind: "line", id: `u-${u.id}`, created_at: u.created_at, me: false, text: u.body, question: u.replies?.length && !u.answer ? u : undefined })),
    ];
    return items.sort(byTime);
  }, [requests, lines, updates, sandbox]);
  const told = (requestId: string) => updates.filter((u) => u.request_id === requestId).sort(byTime);

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

  // What they type goes to their own AI when it is on, and straight to the team when it is not.
  async function say(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError("");
    const { data, error } = await supabase.rpc("client_say", { t: table.id, body });
    setBusy(false);
    if (error) return setError(sentence(error.message));
    setDraft("");
    // When their copy could not take it, the words went to the team instead, and they are told why.
    const why = (data as { why?: string } | null)?.why;
    setNotice(why === "asleep" ? "Your copy cannot be changed right now, so this went to the team instead." : why === "full" ? "That is all the changes your copy takes in a day, so this went to the team instead." : "");
    await reload();
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

  return (
    <div className={`${room.shell} ${styles.clientShell} ${viewer && !viewer.preview ? styles.viewing : ""}`} data-testid={viewer && !viewer.preview ? "client-view" : undefined}>
      <header className={room.header}>
        <button className={room.menuToggle} aria-label="Menu" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(!drawerOpen)}>
          <span /><span /><span />
        </button>
        <button className={`${room.brand} ${view === "tree" ? room.brandOn : ""}`} onClick={() => { setView("tree"); setDrawerOpen(false); }} data-testid={viewer?.preview ? undefined : "client-home"}>
          <Mark size={26} /> Longtable
        </button>
        <div className={room.divider} />
        <div className={room.project}>{table.name}</div>
        <div className={room.spacer} />
        {viewer ? (
          <div className={styles.viewBar}>
            <span className={styles.viewTag}>Viewing {firstName(me.display_name)}&apos;s side. Nothing here can be changed.</span>
            <button className="btn" onClick={viewer.onBack} data-testid={viewer.preview ? undefined : "table-portal"}>Back to the table</button>
          </div>
        ) : (
          <ProfileMenu me={{ id: me.id, display_name: me.display_name, role: "client", color: me.color ?? "var(--sage)" }} tableId={table.id} />
        )}
      </header>
      <div className={`${room.grid} ${room.gridWide}`}>
        {drawerOpen && <button className={room.drawerBack} aria-label="Close the menu" onClick={() => setDrawerOpen(false)} />}
        <aside className={`${room.aside} ${drawerOpen ? room.asideOpen : ""}`} aria-label="Menu">
          <div className={room.section}>
            <div className={room.sectionTitle}>Chats</div>
            <button className={`${room.chat} ${view === "talk" ? room.chatActive : ""}`} onClick={() => { setView("talk"); setDrawerOpen(false); }} data-testid={viewer?.preview ? undefined : "client-chat-link"}>
              <span className={room.chatName}>{assistant ? "Your assistant" : "The team"}</span>
              {pending && <span className={room.chatDot} />}
            </button>
          </div>
          <div className={room.section}>
            <div className={room.sectionTitle}>People</div>
            {(viewer?.others?.length ? viewer.others : [me]).map((o) => (
              <button key={o.id} className={`${room.person} ${room.personButton} ${o.id === me.id ? room.personOn : ""}`} onClick={() => viewer?.onPick?.(o.id)}>
                <div className={room.avatar} style={{ background: (o as { color?: string }).color ?? me.color ?? "var(--sage)" }}>{o.display_name.trim().charAt(0).toUpperCase()}</div>
                <div className={room.personText}><div className={room.personName}>{o.display_name}</div><div className={room.personMeta}>Client</div></div>
              </button>
            ))}
          </div>
          {!viewer && (
            <div className={room.section} style={{ marginTop: "auto" }}>
              <button className={room.chat} onClick={() => downloadExport("export_mine", table.id, table.name)}>Download what&apos;s mine</button>
              <Link className={room.chat} href="/privacy">Privacy</Link>
            </div>
          )}
        </aside>
        {view === "tree" && (
          <main className={room.main}>
            <div className={tv.wrap} data-testid={viewer?.preview ? undefined : "client-tree"}>
              <div className={tv.top}>
                <Mark size={60} live={!viewer?.preview} />
                <div className={tv.word}>Longtable</div>
                <div className={tv.project}>{table.name}</div>
              </div>
              <div className={tv.scroller}>
                <div className={tv.tree} style={{ "--cols": 1 } as React.CSSProperties}>
                  <div className={tv.row}>
                    <div className={tv.col} style={{ "--i": 0 } as React.CSSProperties}>
                      <div className={tv.person}>
                        <span className={tv.avatar} style={{ background: me.color ?? "var(--sage)" }}>{me.display_name.trim().charAt(0).toUpperCase()}</span>
                        <div className={tv.name}>{me.display_name}</div>
                      </div>
                      <div className={`${tv.stem} ${assistant ? tv.stemOn : ""}`} />
                      {mine ? (
                        <div className={`${tv.ai} ${tv[mine.kind]}`}>
                          <div className={tv.aiHead}><AiLogo kind={mine.kind} size={26} /><span className={tv.dot} /></div>
                          <div className={tv.aiName}>{AI_NAME[mine.kind]}</div>
                          <div className={tv.model}>{thinking ? "Writing…" : "Your assistant"}</div>
                        </div>
                      ) : viewer ? (
                        <div className={tv.none}><span className={tv.plusTitle}>No assistant yet</span></div>
                      ) : (
                        <button className={tv.plus} onClick={() => setConnectOpen(true)}>
                          <span className={tv.plusSign}><Plus size={18} stroke={2.4} /></span>
                          <span className={tv.plusTitle}>Connect your assistant</span>
                        </button>
                      )}
                    </div>
                  </div>
                  <svg className={tv.funnel} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                    <g className={mine ? tv[`wire_${mine.kind}`] : undefined}>
                      <path d="M 50 -14 L 50 100" vectorEffect="non-scaling-stroke" className={mine ? tv.wire : tv.wireOff} />
                      {mine && <path d="M 50 -14 L 50 100" vectorEffect="non-scaling-stroke" className={tv.pulse} />}
                    </g>
                  </svg>
                  <div className={tv.table}>
                    <div className={tv.tableTitle}>The team</div>
                    <Mark size={64} />
                    <div className={tv.tableModel}>{table.name}</div>
                  </div>
                </div>
              </div>
              <div className={tv.actions}>
                <button className="btn" onClick={() => setView("talk")}>Open {assistant ? "your assistant" : "the chat"} <Arrow size={16} /></button>
              </div>
            </div>
          </main>
        )}
        <main className={`${room.main} ${styles.talk}`} hidden={view !== "talk"}>
          <div className={styles.simple}>
            <div className={styles.simpleHead}>
              <h1 className={styles.hello}>{here ? greeting(me.display_name) : " "}</h1>
              <div className={styles.headRow} hidden={!!sandbox?.on}>
                <span className={styles.label} data-testid="chat-head">{assistant ? "Your assistant" : "The team"}</span>
                {!viewer && !sandbox?.on && <button className={styles.headLink} onClick={() => setConnectOpen(true)}>{assistant ? "Connected" : "Connect my assistant"}</button>}
              </div>
              {sandbox?.on && (
                <div className={`${styles.copyBar} ${sandbox.changes.length ? styles.copyBarSmall : ""}`} data-testid="copy-bar">
                  <div className={styles.copyText}>
                    <b>Your own copy</b>
                    {/* The explanation is for the first visit; after that the bar is one line. */}
                    {sandbox.changes.length === 0 && <span>Say what you want changed. It is built there for you to try, and the team decides what goes into the real thing.</span>}
                  </div>
                  {sandbox.url
                    ? <a className="btn" href={sandbox.url} target="_blank" rel="noreferrer" data-testid="open-copy">Open my copy <Arrow size={16} /></a>
                    : <span className={styles.copySoon}>Its address appears here after your first change.</span>}
                </div>
              )}
            </div>

            <div ref={chatRef} className={styles.feed} data-testid="client-chat" aria-label="What you asked for">
              {feed.length === 0 && (
                <div className={styles.empty}>
                  {sandbox?.on ? `Hi ${firstName(me.display_name)}. Say what you would like changed in ${table.name}, in your own words, and you can try it in your copy.`
                    : assistant ? `Hi ${firstName(me.display_name)}. Ask me where anything stands, or for something new, and I will pass it to the team.`
                    : `Ask for anything about ${table.name}, in your own words. The team decides, and you hear back here.`}
                </div>
              )}
              {feed.map((item) => {
                if (item.kind === "line") {
                  return (
                    <div key={item.id} className={item.me ? styles.lineMe : styles.lineTeam}>
                      <div className={item.me ? styles.bubbleMe : styles.bubbleTeam}>{item.text}</div>
                      {item.question && (
                        <div className={styles.replies} data-testid="replies">
                          {item.question.replies.map((label, k) => (
                            <button key={label} className={styles.reply} disabled={!!viewer} onClick={() => answer(item.question!, k + 1)}>{label}</button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                }
                if (item.kind === "change") {
                  const c = item.c;
                  const asked = c.request_id ? requests.find((r) => r.id === c.request_id) : undefined;
                  const shown = asked ? SHOWN[asked.status] ?? CHANGE[c.status] : CHANGE[c.status];
                  return (
                    <div key={item.id} className={`${styles.request} ${c.status === "ready" && !c.verdict ? styles.requestReady : ""} ${asked?.status === "question" ? styles.requestAsk : ""}`} data-change={c.id}>
                      <div className={styles.cardHead}>
                        <div className={styles.requestTitle}>{c.words}</div>
                        <div className={`${styles.pill} ${shown.pill}`} data-testid="change-status">{c.status === "working" && <i className={styles.pulse} />}{shown.words}</div>
                      </div>
                      {c.summary && <div className={styles.cardSaid}>{c.summary}</div>}
                      {c.status === "ready" && sandbox?.url && (
                        <a className={`btn ${styles.tryIt}`} href={sandbox.url} target="_blank" rel="noreferrer" data-testid="try-it">Try it <Arrow size={16} /></a>
                      )}
                      {c.request_id && told(c.request_id).map((u) => (
                        <div key={u.id} className={styles.cardSaid}>
                          {u.body}
                          {u.replies?.length > 0 && !u.answer && (
                            <div className={styles.replies} data-testid="replies">
                              {u.replies.map((label, k) => (
                                <button key={label} className={styles.reply} disabled={!!viewer} onClick={() => answer(u, k + 1)}>{label}</button>
                              ))}
                            </div>
                          )}
                          {u.answer && <div className={styles.cardAnswer}>You answered: {u.answer}</div>}
                        </div>
                      ))}
                      {c.verdict && <div className={`${styles.cardVerdict} ${c.verdict === "no" ? styles.verdictNo : ""}`} data-testid="verdict">{VERDICT[c.verdict]}{c.note ? ` ${c.note}` : ""}</div>}
                    </div>
                  );
                }
                const r = item.r;
                const shown = SHOWN[r.status] ?? SHOWN.asked;
                const log = events.filter((e) => e.request_id === r.id).sort((a, b) => a.id - b.id);
                const steps = [
                  ...log.map((e) => ({ key: `e-${e.id}`, label: e.label, iso: e.created_at as string | null })),
                  ...(shown.next ? [{ key: "next", label: shown.next, iso: null }] : []),
                ];
                const said = told(r.id);
                const isOpen = !!open[r.id];
                return (
                  <div key={item.id} className={`${styles.request} ${r.status === "question" ? styles.requestAsk : ""}`} data-request={r.id}>
                    <button className={styles.requestHead} onClick={() => setOpen((o) => ({ ...o, [r.id]: !isOpen }))} aria-expanded={isOpen}>
                      <div className={styles.requestTitle}>{r.body}</div>
                      <div className={`${styles.pill} ${shown.pill}`} data-testid="status">{shown.words}</div>
                      <div className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ""}`} aria-hidden />
                    </button>
                    {said.map((u) => (
                      <div key={u.id} className={styles.cardSaid}>
                        {u.body}
                        {u.replies?.length > 0 && !u.answer && (
                          <div className={styles.replies} data-testid="replies">
                            {u.replies.map((label, k) => (
                              <button key={label} className={styles.reply} disabled={!!viewer} onClick={() => answer(u, k + 1)}>{label}</button>
                            ))}
                          </div>
                        )}
                        {u.answer && <div className={styles.cardAnswer}>You answered: {u.answer}</div>}
                      </div>
                    ))}
                    {isOpen && (
                      <ol className={styles.timeline}>
                        {steps.map((st, k) => (
                          <li key={st.key} className={styles.step}>
                            <div className={styles.rail}>
                              <span className={`${styles.stepDot} ${st.iso ? styles.stepDone : ""}`} />
                              {k < steps.length - 1 && <span className={styles.railLine} />}
                            </div>
                            <div className={styles.stepBody}>
                              <span className={`${styles.stepLabel} ${st.iso ? "" : styles.stepNext}`}>{st.label}</span>
                              {st.iso && <span className={styles.stepWhen}><Time iso={st.iso} style="when" /></span>}
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                );
              })}
              {thinking && <div className={`${styles.bubbleTeam} ${styles.typing}`} data-testid="thinking">Your assistant is writing…</div>}
              {viewer && assistant && <div className={styles.privateNote}>{firstName(me.display_name)}&apos;s chat with their own assistant is private and is not shown.</div>}
            </div>

            <div className={styles.simpleFoot}>
              <form className={styles.composer} onSubmit={viewer ? (e) => e.preventDefault() : say}>
                <input className={styles.input} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={!!viewer}
                  placeholder={viewer ? "Only they can write here" : sandbox?.on ? "Say what you want changed" : "Ask for something, in your own words"} aria-label="Ask the team" maxLength={4000} />
                <button className="btn" disabled={!!viewer || busy || !draft.trim()}>Send</button>
              </form>
              {sandbox?.on && !viewer && <div className={styles.footNote} data-testid="changes-left">{sandbox.left} {sandbox.left === 1 ? "change" : "changes"} left today</div>}
              {notice && <div className={styles.footNote} role="status">{notice}</div>}
              {error && <div className={`error ${styles.chatError}`} role="alert">{error}</div>}
            </div>
          </div>
        </main>
      </div>
      {connectOpen && (
        <ConnectModal audience="client" tableId={table.id} tableName={table.name} connected={connections.find((c) => !c.revoked_at)?.kind ?? null} onClose={() => setConnectOpen(false)} />
      )}
    </div>
  );
}
