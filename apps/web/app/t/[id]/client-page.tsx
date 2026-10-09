"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { Mark } from "@/components/mark";
import { Time, useInBrowser } from "@/components/time";
import { browserClient } from "@/lib/supabase/browser";
import { formatWhen } from "@/lib/time";
import { EVENT_COLUMNS, REQUEST_COLUMNS, UPDATE_COLUMNS, type ClientUpdate, type Request, type RequestEvent, type RequestStatus as Status } from "./types";
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
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

function greeting(name: string) {
  const h = new Date().getHours();
  return `${h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"}, ${firstName(name)}`;
}

function sent(iso: string) {
  const w = formatWhen(iso);
  return /^(Just|Today|Yesterday)/.test(w) ? `Sent ${w.charAt(0).toLowerCase()}${w.slice(1)}` : `Sent on ${w}`;
}

// The client's page: what they asked for, where each request stands, and what the team decided, in plain words.
// It never shows the team side. Asking goes through one function that the database checks, and everything
// arrives live on two private channels: the table's, for what every client is told, and the client's own.
export function ClientPage({ table, me, initialRequests, initialEvents, initialUpdates }: {
  table: { id: string; name: string };
  me: { id: string; display_name: string };
  initialRequests: Request[];
  initialEvents: RequestEvent[];
  initialUpdates: ClientUpdate[];
}) {
  const supabase = useMemo(() => browserClient(), []);
  const here = useInBrowser();
  const [requests, setRequests] = useState(initialRequests);
  const [events, setEvents] = useState(initialEvents);
  const [updates, setUpdates] = useState(initialUpdates);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [gone, setGone] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);

  const putRequest = useCallback((r: Request) => setRequests((prev) => [...prev.filter((x) => x.id !== r.id), r]), []);
  const putEvents = useCallback((list: RequestEvent[]) => setEvents((prev) => {
    const seen = new Set(prev.map((e) => e.id));
    const fresh = list.filter((e) => !seen.has(e.id));
    return fresh.length ? [...prev, ...fresh] : prev;
  }), []);
  // Updates change too: a question gets its answer.
  const putUpdates = useCallback((list: ClientUpdate[]) => setUpdates((prev) => {
    const byId = new Map(prev.map((u) => [u.id, u]));
    for (const u of list) byId.set(u.id, { ...byId.get(u.id), ...u });
    return [...byId.values()];
  }), []);

  // Everything again from the database: covers the moment between the page loading and the channels opening,
  // and anything missed while a laptop slept.
  const reload = useCallback(async () => {
    const [{ data: r }, { data: ev }, { data: up }] = await Promise.all([
      supabase.from("requests").select(REQUEST_COLUMNS).eq("table_id", table.id).eq("member_id", me.id),
      supabase.from("request_events").select(EVENT_COLUMNS).eq("table_id", table.id),
      supabase.from("client_updates").select(UPDATE_COLUMNS).eq("table_id", table.id),
    ]);
    if (r) setRequests(r as Request[]);
    if (ev) putEvents(ev as RequestEvent[]);
    if (up) putUpdates(up as ClientUpdate[]);
  }, [supabase, table.id, me.id, putEvents, putUpdates]);

  useEffect(() => {
    const channels: RealtimeChannel[] = [];
    let cancelled = false;
    const onChange = ({ payload }: { payload: unknown }) => {
      const { table: name, record } = (payload ?? {}) as { table?: string; record?: Record<string, unknown> };
      if (!record) return;
      if (name === "client_updates") putUpdates([record as unknown as ClientUpdate]);
      else if (name === "request_events") putEvents([record as unknown as RequestEvent]);
      else if (name === "requests" && record.member_id === me.id) putRequest(record as unknown as Request);
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
  }, [supabase, table.id, me.id, reload, putRequest, putEvents, putUpdates]);

  // Back to the tab, and every so often while the team is still on something she asked: read the database too,
  // so a lost push only delays what she sees.
  const pending = requests.some((r) => ["asked", "being decided", "question", "answered"].includes(r.status));
  useEffect(() => {
    const onShow = () => { if (document.visibilityState === "visible") reload(); };
    document.addEventListener("visibilitychange", onShow);
    const t = setInterval(() => { if (document.visibilityState === "visible") reload(); }, pending ? 15000 : 60000);
    return () => {
      document.removeEventListener("visibilitychange", onShow);
      clearInterval(t);
    };
  }, [pending, reload]);

  type Line = { me: boolean; id: string; created_at: string; text: string; question?: ClientUpdate };
  const chat = useMemo(() => [
    ...requests.map((r): Line => ({ me: true, id: `r-${r.id}`, created_at: r.created_at, text: r.body })),
    ...updates.map((u): Line => ({ me: false, id: `u-${u.id}`, created_at: u.created_at, text: u.body, question: u.replies?.length && !u.answer ? u : undefined })),
    ...updates.filter((u) => u.answer && u.answered_at).map((u): Line => ({ me: true, id: `a-${u.id}`, created_at: u.answered_at!, text: u.answer! })),
  ].sort(byTime), [requests, updates]);

  // One tap answers the team's question. It shows at once; the database decides whether it counts.
  async function answer(u: ClientUpdate, choice: number) {
    setError("");
    putUpdates([{ ...u, answer: u.replies[choice - 1], answered_at: new Date().toISOString() }]);
    const { error } = await supabase.rpc("client_reply", { u: u.id, choice });
    if (error) {
      putUpdates([u]);
      setError(`${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}.`);
    }
    reload();
  }

  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length]);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError("");
    const { data, error } = await supabase.rpc("client_ask", { t: table.id, body });
    setBusy(false);
    if (error || !data) return setError(error?.message ? `${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}.` : "That did not send. Try again.");
    setDraft("");
    const id = data as string;
    const [{ data: r }, { data: ev }, { data: up }] = await Promise.all([
      supabase.from("requests").select(REQUEST_COLUMNS).eq("id", id).single(),
      supabase.from("request_events").select(EVENT_COLUMNS).eq("request_id", id),
      supabase.from("client_updates").select(UPDATE_COLUMNS).eq("request_id", id),
    ]);
    if (r) putRequest(r as Request);
    if (ev) putEvents(ev as RequestEvent[]);
    if (up) putUpdates(up as ClientUpdate[]);
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
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.brand}><Mark size={24} /> {table.name}</div>
      </header>
      <main className={styles.main}>
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

          <section className={styles.chatPanel} aria-label="Talk to the team">
            <div className={styles.chatHead}><span className={styles.chatMark} /> The team</div>
            <div ref={chatRef} className={styles.chat} data-testid="client-chat">
              {chat.length === 0 && (
                <div className={styles.bubbleTeam}>Ask for anything about {table.name}, in your own words. The team decides, and you hear back here.</div>
              )}
              {chat.map((c) => (
                <div key={c.id} className={c.me ? styles.lineMe : styles.lineTeam}>
                  <div className={c.me ? styles.bubbleMe : styles.bubbleTeam}>{c.text}</div>
                  {c.question && (
                    <div className={styles.replies} data-testid="replies">
                      {c.question.replies.map((label, k) => (
                        <button key={label} className={styles.reply} onClick={() => answer(c.question!, k + 1)}>{label}</button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <form className={styles.composer} onSubmit={ask}>
              <input className={styles.input} value={draft} onChange={(e) => setDraft(e.target.value)}
                placeholder="Ask for something, in your own words" aria-label="Ask the team" maxLength={4000} />
              <button className="btn" disabled={busy || !draft.trim()}>Send</button>
            </form>
            {error && <div className={`error ${styles.chatError}`} role="alert">{error}</div>}
          </section>
        </div>
      </main>
    </div>
  );
}
