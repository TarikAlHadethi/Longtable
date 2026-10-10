"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { Mark } from "@/components/mark";
import { Time, useInBrowser } from "@/components/time";
import { downloadExport } from "@/lib/download";
import { browserClient } from "@/lib/supabase/browser";
import { formatWhen } from "@/lib/time";
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

function sent(iso: string) {
  const w = formatWhen(iso);
  return /^(Just|Today|Yesterday)/.test(w) ? `Sent ${w.charAt(0).toLowerCase()}${w.slice(1)}` : `Sent on ${w}`;
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
export function ClientPage({ table, me, initialRequests, initialEvents, initialUpdates, initialLines, initialConnections, initialJobs, viewer, start = "tree" }: {
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
  const [requests, setRequests] = useState(initialRequests);
  const [events, setEvents] = useState(initialEvents);
  const [updates, setUpdates] = useState(initialUpdates);
  const [lines, setLines] = useState(initialLines);
  const [connections, setConnections] = useState(initialConnections);
  const [jobs, setJobs] = useState(initialJobs);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [connectOpen, setConnectOpen] = useState(false);
  const [view, setView] = useState<"tree" | "talk">(start);
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
    if (up) putUpdates(up as ClientUpdate[]);
    if (ln) putLines(ln as ClientLine[]);
    if (cn) setConnections(cn as Connection[]);
    if (jb) setJobs(jb as Job[]);
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

  // Back to the tab, and every so often while their AI is writing or the team is on something they asked: read the
  // database too, so a lost push only delays what they see.
  const pending = requests.some((r) => ["asked", "being decided", "question", "answered"].includes(r.status));
  useEffect(() => {
    if (viewer) return;
    const onShow = () => { if (document.visibilityState === "visible") reload(); };
    document.addEventListener("visibilitychange", onShow);
    const t = setInterval(() => { if (document.visibilityState === "visible") reload(); }, thinking ? 4000 : pending ? 15000 : 60000);
    return () => {
      document.removeEventListener("visibilitychange", onShow);
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, thinking, reload, !!viewer]);

  type Line = { me: boolean; id: string; created_at: string; text: string; question?: ClientUpdate };
  const chat = useMemo(() => [
    ...requests.filter((r) => !r.from_line).map((r): Line => ({ me: true, id: `r-${r.id}`, created_at: r.created_at, text: r.body })),
    ...lines.map((l): Line => ({ me: l.who === "client", id: `l-${l.id}`, created_at: l.created_at, text: l.body })),
    ...updates.map((u): Line => ({ me: false, id: `u-${u.id}`, created_at: u.created_at, text: u.body, question: u.replies?.length && !u.answer ? u : undefined })),
    ...updates.filter((u) => u.answer && u.answered_at).map((u): Line => ({ me: true, id: `a-${u.id}`, created_at: u.answered_at!, text: u.answer! })),
  ].sort(byTime), [requests, lines, updates]);

  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length, thinking]);

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
    const { error } = await supabase.rpc("client_say", { t: table.id, body });
    setBusy(false);
    if (error) return setError(sentence(error.message));
    setDraft("");
    await reload();
  }

  const sorted = [...requests].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const count = (s: Status[]) => requests.filter((r) => s.includes(r.status)).length;
  const summary = [
    { n: count(["decided", "ready to try", "done"]), label: "Done or decided" },
    { n: count(["asked", "being decided", "question", "answered"]), label: "With the team" },
    { n: count(["planned"]), label: "Planned" },
  ];

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
        <button className={`${room.brand} ${view === "tree" ? room.brandOn : ""}`} onClick={() => setView("tree")} data-testid={viewer?.preview ? undefined : "client-home"}>
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
        <aside className={room.aside} aria-label="Menu">
          <div className={room.section}>
            <div className={room.sectionTitle}>Chats</div>
            <button className={`${room.chat} ${view === "talk" ? room.chatActive : ""}`} onClick={() => setView("talk")} data-testid={viewer?.preview ? undefined : "client-chat-link"}>
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
        <div className={styles.main}>
        <div className={styles.top}>
          <h1 className={styles.hello}>{here ? greeting(me.display_name) : " "}</h1>
          <div className={styles.summary}>
            {summary.map((s) => (
              <div key={s.label} className={styles.stat}>
                <div className={styles.statN}>{s.n}</div>
                <div className={styles.statL}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.columns}>
          <section className={styles.requests} aria-label="What you asked for">
            <div className={styles.label}>What you asked for</div>
            {sorted.length === 0 && <div className={styles.empty}>Nothing yet. Ask for something in your own words, and follow it here.</div>}
            {sorted.map((r) => {
              const shown = SHOWN[r.status] ?? SHOWN.asked;
              const log = events.filter((e) => e.request_id === r.id).sort((a, b) => a.id - b.id);
              const steps = [
                ...log.map((e) => ({ key: `e-${e.id}`, label: e.label, iso: e.created_at as string | null })),
                ...(shown.next ? [{ key: "next", label: shown.next, iso: null }] : []),
              ];
              const note = r.status === "asked" ? (here ? sent(r.created_at) : " ")
                : r.status === "being decided" ? "The team is deciding"
                : r.status === "question" ? "The team has a question for you" : log.at(-1)?.label ?? shown.words;
              const isOpen = !!open[r.id];
              return (
                <div key={r.id} className={`${styles.request} ${r.status === "question" ? styles.requestAsk : ""}`} data-request={r.id}>
                  <button className={styles.requestHead} onClick={() => setOpen((o) => ({ ...o, [r.id]: !isOpen }))} aria-expanded={isOpen}>
                    <div className={styles.requestText}>
                      <div className={styles.requestTitle}>{r.title}</div>
                      <div className={styles.requestNote}>{note}</div>
                    </div>
                    <div className={`${styles.pill} ${shown.pill}`} data-testid="status">{shown.words}</div>
                    <div className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ""}`} aria-hidden />
                  </button>
                  {isOpen && (
                    <ol className={styles.timeline}>
                      {steps.map((s, i) => (
                        <li key={s.key} className={styles.step}>
                          <div className={styles.rail}>
                            <span className={`${styles.stepDot} ${s.iso ? styles.stepDone : ""}`} />
                            {i < steps.length - 1 && <span className={styles.railLine} />}
                          </div>
                          <div className={styles.stepBody}>
                            <span className={`${styles.stepLabel} ${s.iso ? "" : styles.stepNext}`}>{s.label}</span>
                            {s.iso && <span className={styles.stepWhen}><Time iso={s.iso} style="when" /></span>}
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              );
            })}
          </section>

          <section className={styles.chatPanel} aria-label={assistant ? "Your assistant" : "Talk to the team"}>
            <div className={styles.chatHead}>
              <span className={styles.chatMark} /> <span data-testid="chat-head">{assistant ? "Your assistant" : "The team"}</span>
              {!viewer && <button className={styles.headLink} onClick={() => setConnectOpen(true)}>{assistant ? "Connected" : "Connect my assistant"}</button>}
            </div>
            <div ref={chatRef} className={styles.chat} data-testid="client-chat">
              {chat.length === 0 && (
                <div className={styles.bubbleTeam}>
                  {assistant
                    ? `Hi ${firstName(me.display_name)}. Ask me where anything stands, or for something new, and I will pass it to the team.`
                    : `Ask for anything about ${table.name}, in your own words. The team decides, and you hear back here.`}
                </div>
              )}
              {chat.map((c) => (
                <div key={c.id} className={c.me ? styles.lineMe : styles.lineTeam}>
                  <div className={c.me ? styles.bubbleMe : styles.bubbleTeam}>{c.text}</div>
                  {c.question && (
                    <div className={styles.replies} data-testid="replies">
                      {c.question.replies.map((label, k) => (
                        <button key={label} className={styles.reply} disabled={!!viewer} onClick={() => answer(c.question!, k + 1)}>{label}</button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {thinking && <div className={`${styles.bubbleTeam} ${styles.typing}`} data-testid="thinking">Your assistant is writing…</div>}
              {viewer && assistant && <div className={styles.privateNote}>{firstName(me.display_name)}&apos;s chat with their own assistant is private and is not shown.</div>}
            </div>
            <form className={styles.composer} onSubmit={viewer ? (e) => e.preventDefault() : say}>
              <input className={styles.input} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={!!viewer}
                placeholder={viewer ? "Only they can write here" : "Ask for something, in your own words"} aria-label="Ask the team" maxLength={4000} />
              <button className="btn" disabled={!!viewer || busy || !draft.trim()}>Send</button>
            </form>
            {error && <div className={`error ${styles.chatError}`} role="alert">{error}</div>}
          </section>
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
