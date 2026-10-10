"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { Mark } from "@/components/mark";
import { downloadExport } from "@/lib/download";
import { browserClient } from "@/lib/supabase/browser";
import { Inline } from "@/lib/inline";
import { Time } from "@/components/time";
import { Answer } from "./answer";
import { ConnectModal } from "./connect-modal";
import { DecisionCard } from "./decision-card";
import { Invite } from "./invite";
import { NewDecision } from "./new-decision";
import { ProfileMenu } from "./profile-menu";
import { TableView } from "./table-view";
import {
  CONNECTION_COLUMNS, DECISION_COLUMNS, JOB_COLUMNS, MESSAGE_COLUMNS, NOTE_COLUMNS, REQUEST_COLUMNS,
  type Chat, type Connection, type Decision, type Job, type Member, type Message, type Note, type Request, type RequestStatus,
} from "./types";
import styles from "./room.module.css";

const ROLE_WORD = { owner: "Owner", developer: "Developer", client: "Client" } as const;
const initial = (name: string) => name.trim().charAt(0).toUpperCase() || "?";
const byTime = <T extends { created_at: string }>(a: T, b: T) => a.created_at.localeCompare(b.created_at);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
// A client's request as the team sees it.
function requestWords(status: RequestStatus, who: string): { words: string; pill: string } {
  switch (status) {
    case "asked": return { words: "New request", pill: "" };
    case "being decided": return { words: "Being decided", pill: "" };
    case "question": return { words: `Waiting on ${who}`, pill: styles.requestPillAsk };
    case "answered": return { words: `${who} answered`, pill: "" };
    case "decided": return { words: "Decided", pill: styles.requestPillDone };
    case "planned": return { words: "Planned", pill: styles.requestPillPlan };
    default: return { words: capital(status), pill: styles.requestPillDone };
  }
}

type Change = { table?: string; record?: Record<string, unknown> };

export function Room({ table, me, initialMembers, initialChats, initialMessages, initialDecisions, initialJobs, initialConnections, initialNotes, initialRequests, initialChatId, initialView }: {
  table: { id: string; name: string };
  me: Member;
  initialMembers: Member[];
  initialChats: Chat[];
  initialMessages: Message[];
  initialDecisions: Decision[];
  initialJobs: Job[];
  initialConnections: Connection[];
  initialNotes: Note[];
  initialRequests: Request[];
  initialChatId: string;
  initialView: "table" | "chat";
}) {
  const supabase = useMemo(() => browserClient(), []);
  const [members, setMembers] = useState(initialMembers);
  const [chats, setChats] = useState(initialChats);
  const [messages, setMessages] = useState(initialMessages);
  const [decisions, setDecisions] = useState(initialDecisions);
  const [jobs, setJobs] = useState(initialJobs);
  const [connections, setConnections] = useState(initialConnections);
  const [connectOpen, setConnectOpen] = useState(false);
  const [notes, setNotes] = useState(initialNotes);
  const [requests, setRequests] = useState(initialRequests);
  const [askingFor, setAskingFor] = useState<Request | null>(null);
  const [openNote, setOpenNote] = useState<Note | null>(null);
  const [notice, setNotice] = useState("");
  const [chatId, setChatId] = useState(initialChatId);
  // The room opens on the table itself; a chat opens from there or from the list.
  const [view, setView] = useState<"table" | "chat">(initialView);
  const [inviting, setInviting] = useState(false);
  const [online, setOnline] = useState<Set<string>>(() => new Set([me.id]));
  const [live, setLive] = useState(false);
  const [gone, setGone] = useState(false);
  const [draft, setDraft] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [inboxOpen, setInboxOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [naming, setNaming] = useState(false);
  const [newChat, setNewChat] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const atBottom = useRef(true);
  const known = useRef(new Set(initialMembers.map((m) => m.id)));

  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const chatById = useMemo(() => new Map(chats.map((c) => [c.id, c])), [chats]);
  const requestById = useMemo(() => new Map(requests.map((r) => [r.id, r])), [requests]);
  // The newest client card about each request is the one that offers the next decision.
  const lastCard = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of messages) {
      const r = m.kind === "client" ? m.meta?.request : null;
      if (r && (!map.has(r) || map.get(r)!.created_at <= m.created_at)) map.set(r, m);
    }
    return map;
  }, [messages]);
  const clients = members.filter((m) => m.role === "client");
  const client = clients[0];
  // Who hears a decision meant for the client: one client by name; with several, every one of them.
  const clientName = clients.length > 1 ? "every client" : client?.display_name ?? "the client";
  const chat = chatById.get(chatId) ?? chats[0];
  const liveClaude = new Set(connections.filter((c) => !c.revoked_at && c.kind === "claude").map((c) => c.member_id));
  const liveAI = new Set(connections.filter((c) => !c.revoked_at).map((c) => c.member_id));
  const myConnection = connections.find((c) => !c.revoked_at && c.kind === "claude" && c.member_id === me.id);
  const working = jobs.filter((j) => j.chat_id === chat?.id && ["queued", "running", "waiting", "failed"].includes(j.status))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  const refreshMembers = useCallback(async () => {
    const { data } = await supabase.from("members").select("id, display_name, role, color").eq("table_id", table.id).is("removed_at", null).order("created_at");
    if (data) {
      known.current = new Set((data as Member[]).map((m) => m.id));
      setMembers(data as Member[]);
    }
  }, [supabase, table.id]);

  // Live pushes can be lost (a reconnect, the server moving its database feed), so the room also reads the
  // database: when the channel opens or reopens, when the tab comes back, and every few seconds while an AI is
  // working or a decision is on its way out.
  const catchUp = useCallback(async () => {
    const [{ data: recent }, { data: inFlight }, { data: ds }, { data: rq }, { data: ns }, { data: cs }] = await Promise.all([
      supabase.from("messages").select(MESSAGE_COLUMNS).eq("table_id", table.id).order("created_at", { ascending: false }).limit(100),
      supabase.from("jobs").select(JOB_COLUMNS).eq("table_id", table.id).in("status", ["queued", "running", "waiting", "failed"]).order("created_at", { ascending: false }).limit(50),
      supabase.from("decisions").select(DECISION_COLUMNS).eq("table_id", table.id).order("created_at", { ascending: false }).limit(100),
      supabase.from("requests").select(REQUEST_COLUMNS).eq("table_id", table.id).order("created_at", { ascending: false }).limit(200),
      supabase.from("notes").select(NOTE_COLUMNS).eq("table_id", table.id),
      supabase.from("connections").select(CONNECTION_COLUMNS).eq("table_id", table.id).is("revoked_at", null),
    ]);
    if (recent) setMessages((prev) => {
      const have = new Set(prev.map((m) => m.id));
      const fresh = (recent as Message[]).filter((m) => !have.has(m.id));
      return fresh.length ? [...prev, ...fresh] : prev;
    });
    if (inFlight) setJobs(inFlight as Job[]);
    if (ds) setDecisions(ds as unknown as Decision[]);
    if (rq) setRequests(rq as Request[]);
    if (ns) setNotes(ns as Note[]);
    if (cs) setConnections(cs as Connection[]);
  }, [supabase, table.id]);

  const loadDecision = useCallback(async (id: string) => {
    const { data } = await supabase.from("decisions").select(DECISION_COLUMNS).eq("id", id).maybeSingle();
    if (data) setDecisions((prev) => [...prev.filter((d) => d.id !== id), data as unknown as Decision]);
  }, [supabase]);

  // Live: messages, chats and decisions, plus who is here, all on the table's private team channel.
  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    const onChange = (kind: "INSERT" | "UPDATE") => ({ payload }: { payload: unknown }) => {
      const { table: name, record } = (payload ?? {}) as Change;
      if (!record) return;
      if (name === "messages") {
        const m = record as unknown as Message;
        setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
        if (!known.current.has(m.member_id)) refreshMembers();
      } else if (name === "members") {
        const { id, display_name, role, color } = record as unknown as Member;
        // Taken off the table: gone from the list, and if it is this person, their page closes.
        if ((record as { removed_at?: string | null }).removed_at) {
          if (id === me.id) setGone(true);
          setMembers((prev) => prev.filter((m) => m.id !== id));
          return;
        }
        known.current.add(id);
        setMembers((prev) => (prev.some((m) => m.id === id)
          ? prev.map((m) => (m.id === id ? { id, display_name, role, color } : m))
          : [...prev, { id, display_name, role, color }]));
      } else if (name === "jobs") {
        const j = record as unknown as Job;
        setJobs((prev) => [...prev.filter((x) => x.id !== j.id), j]);
      } else if (name === "notes") {
        const n = record as unknown as Note;
        setNotes((prev) => [...prev.filter((x) => x.id !== n.id), n]);
      } else if (name === "connections") {
        const c = record as unknown as Connection;
        setConnections((prev) => [...prev.filter((x) => x.id !== c.id), c]);
      } else if (name === "requests") {
        const r = record as unknown as Request;
        setRequests((prev) => [...prev.filter((x) => x.id !== r.id), r]);
      } else if (name === "chats") {
        const c = record as unknown as Chat;
        setChats((prev) => [...prev.filter((x) => x.id !== c.id), c].sort(byTime));
      } else if (name === "decisions") {
        const d = record as unknown as Omit<Decision, "options">;
        if (kind === "INSERT") loadDecision(d.id);
        else setDecisions((prev) => {
          if (!prev.some((x) => x.id === d.id)) { loadDecision(d.id); return prev; }
          return prev.map((x) => (x.id === d.id ? { ...x, ...d, options: x.options } : x));
        });
      }
    };
    (async () => {
      await supabase.realtime.setAuth();
      if (cancelled) return;
      const ch = supabase.channel(`team:${table.id}`, { config: { private: true, presence: { key: me.id } } });
      channel = ch;
      ch.on("broadcast", { event: "INSERT" }, onChange("INSERT"))
        .on("broadcast", { event: "UPDATE" }, onChange("UPDATE"))
        .on("presence", { event: "sync" }, () => {
          const ids = new Set(Object.keys(ch.presenceState()));
          ids.add(me.id);
          setOnline(ids);
          if ([...ids].some((id) => !known.current.has(id))) refreshMembers();
        })
        .subscribe(async (status: string) => {
          setLive(status === "SUBSCRIBED");
          if (status === "SUBSCRIBED") {
            await ch.track({ at: Date.now() });
            catchUp();
            refreshMembers();
          }
          // Refused: if this person is no longer at the table (it was closed, or they were removed), stop trying.
          if (status === "CHANNEL_ERROR") {
            const { data, error } = await supabase.from("members").select("id").eq("id", me.id).maybeSingle();
            if (!error && !data) {
              setGone(true);
              supabase.removeChannel(ch);
            }
          }
        });
    })();
    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [supabase, table.id, me.id, refreshMembers, loadDecision, catchUp]);

  // Back to the tab: read what happened while it was away.
  useEffect(() => {
    const onShow = () => { if (document.visibilityState === "visible") catchUp(); };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [catchUp]);

  // While an AI is working or a decision is on its way out, check every few seconds; otherwise now and then. A lost
  // push only delays what anyone sees.
  const waitingOnSomething = jobs.some((j) => ["queued", "running", "waiting"].includes(j.status))
    || decisions.some((d) => d.status === "decided" && !d.delivered_at);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") catchUp(); }, waitingOnSomething ? 4000 : 30000);
    return () => clearInterval(t);
  }, [waitingOnSomething, catchUp]);

  // A clock for the undo countdown, running only while a window is open.
  const counting = decisions.some((d) => d.status === "decided" && !d.delivered_at && d.deliver_after && new Date(d.deliver_after).getTime() > now - 3000);
  useEffect(() => {
    if (!counting) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [counting]);

  const items = useMemo(() => {
    const ms = messages.filter((m) => m.chat_id === chat?.id && m.kind !== "view").map((m) => ({ kind: "message" as const, created_at: m.created_at, m }));
    const ds = decisions.filter((d) => d.chat_id === chat?.id).map((d) => ({ kind: "decision" as const, created_at: d.created_at, d }));
    return [...ms, ...ds].sort(byTime);
  }, [messages, decisions, chat?.id]);

  const viewsByRound = useMemo(() => {
    const map = new Map<string, Message[]>();
    for (const m of messages) {
      if (m.kind !== "view" || !m.meta?.round) continue;
      map.set(m.meta.round, [...(map.get(m.meta.round) ?? []), m].sort(byTime));
    }
    return map;
  }, [messages]);

  // Stay at the bottom while new things arrive, unless someone scrolled up to read.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  function goHome() {
    setView("table");
    window.history.replaceState(null, "", window.location.pathname);
    setInboxOpen(false);
    setDrawerOpen(false);
  }

  function openChat(id: string) {
    setView("chat");
    setChatId(id);
    atBottom.current = true;
    window.history.replaceState(null, "", `?c=${id}`);
    setInboxOpen(false);
    setDrawerOpen(false);
  }

  function onScroll() {
    const el = scrollRef.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  function grow() {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  async function send() {
    const body = draft.trim();
    if (!body || !chat) return;
    setDraft("");
    requestAnimationFrame(grow);
    atBottom.current = true;
    const tempId = `sending-${crypto.randomUUID()}`;
    setMessages((prev) => [...prev, { id: tempId, chat_id: chat.id, member_id: me.id, body, created_at: new Date().toISOString(), state: "sending" }]);
    const { data, error } = await supabase
      .from("messages")
      .insert({ table_id: table.id, chat_id: chat.id, member_id: me.id, body })
      .select(MESSAGE_COLUMNS)
      .single();
    setMessages((prev) => {
      if (error || !data) return prev.map((m) => (m.id === tempId ? { ...m, state: "failed" } : m));
      const rest = prev.filter((m) => m.id !== tempId);
      return rest.some((m) => m.id === (data as Message).id) ? rest : [...rest, data as Message];
    });
  }

  async function askTable() {
    const body = draft.trim();
    if (!body || !chat) return;
    setDraft("");
    setNotice("");
    requestAnimationFrame(grow);
    atBottom.current = true;
    const { data, error } = await supabase.rpc("ask_table", { c: chat.id, body });
    if (error) {
      setDraft(body);
      return setNotice(error.message);
    }
    const res = data as { message_id: string; job_id: string | null; answered_by: string | null };
    const { data: row } = await supabase.from("messages").select(MESSAGE_COLUMNS).eq("id", res.message_id).single();
    if (row) setMessages((prev) => (prev.some((m) => m.id === (row as Message).id) ? prev : [...prev, row as Message]));
    if (!res.answered_by) setNotice("No Claude is connected at this table yet, so nobody will answer. Connect yours in the sidebar.");
    // Learn about the job straight away, so the room keeps checking until the answer lands even if a push is lost.
    else catchUp();
  }

  async function disconnect(id: string) {
    const { error } = await supabase.rpc("disconnect", { conn: id });
    if (!error) setConnections((prev) => prev.map((c) => (c.id === id ? { ...c, revoked_at: new Date().toISOString() } : c)));
  }

  async function makeChat(e: React.FormEvent) {
    e.preventDefault();
    const name = newChat.trim();
    if (!name) return;
    const { data, error } = await supabase.rpc("create_chat", { t: table.id, chat_name: name, chat_about: "" });
    if (error || !data) return;
    const { data: row } = await supabase.from("chats").select("id, name, about, is_general, created_at").eq("id", data).single();
    if (row) setChats((prev) => [...prev.filter((c) => c.id !== (row as Chat).id), row as Chat].sort(byTime));
    setNewChat("");
    setNaming(false);
    openChat(data as string);
  }

  function patchDecision(id: string, patch: Partial<Decision>) {
    setDecisions((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }

  const here = members.filter((m) => online.has(m.id));
  const open = decisions.filter((d) => d.status === "open").sort(byTime);
  const decided = decisions
    .filter((d) => d.status === "decided")
    .sort((a, b) => (b.decided_at ?? "").localeCompare(a.decided_at ?? ""))
    .slice(0, 8);
  const waiting = open.length === 0 ? "Nothing waiting" : `${open.length} waiting for a yes`;

  // A decision about a request is told to the person who asked; any other, to every client at the table.
  const toldFor = (d: Decision) => (d.request_id && byId.get(requestById.get(d.request_id)?.member_id ?? "")?.display_name) || clientName;
  const card = (d: Decision, inInbox: boolean) => (
    <DecisionCard
      key={`${inInbox ? "i" : "c"}-${d.id}`}
      decision={d}
      chatName={chatById.get(d.chat_id)?.name ?? "Chat"}
      members={byId}
      clientName={capital(toldFor(d))}
      now={now}
      onOpenChat={inInbox ? () => openChat(d.chat_id) : undefined}
      onChange={(patch) => patchDecision(d.id, patch)}
    />
  );

  if (gone) {
    return (
      <main className="page-center">
        <div className="panel" style={{ alignItems: "center", textAlign: "center" }}>
          <Mark size={48} />
          <h1>You are no longer at this table</h1>
          <p className="note" style={{ margin: 0 }}>It may have been closed, or you were taken off it. <Link href="/">Back to the start</Link></p>
        </div>
      </main>
    );
  }

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <button className={styles.menuToggle} aria-label="Menu" aria-expanded={drawerOpen} onClick={() => { setDrawerOpen(!drawerOpen); setInboxOpen(false); }}>
          <span /><span /><span />
        </button>
        <button className={styles.brand} onClick={goHome} title="The table" data-testid="home"><Mark size={26} /> Longtable</button>
        <div className={styles.divider} />
        <div className={styles.project}>{table.name}</div>
        <div className={styles.spacer} />
        <div className={styles.faces} title={`${here.length} here now`}>
          {here.filter((m) => m.id !== me.id).map((m) => (
            <div key={m.id} className={styles.face} style={{ background: m.color }}>{initial(m.display_name)}</div>
          ))}
        </div>
        <button className={`btn btn-quiet ${styles.inboxToggle}`} onClick={() => { setInboxOpen(!inboxOpen); setDrawerOpen(false); }}>
          Inbox{open.length > 0 ? ` (${open.length})` : ""}
        </button>
        <ProfileMenu me={me} tableId={table.id} onInvite={me.role === "owner" ? () => setInviting(true) : undefined} />
      </header>

      <div className={styles.grid}>
        {drawerOpen && <button className={styles.drawerBack} aria-label="Close the menu" onClick={() => setDrawerOpen(false)} />}
        <aside className={`${styles.aside} ${drawerOpen ? styles.asideOpen : ""}`} aria-label="Menu">
          <div className={styles.drawerProject}>{table.name}</div>
          <div className={styles.section}>
            <button className={`${styles.chat} ${view === "table" ? styles.chatActive : ""}`} onClick={goHome}>
              <span className={styles.chatName}>The table</span>
            </button>
          </div>
          <div className={styles.section}>
            <div className={styles.sectionHead}>
              <div className={styles.sectionTitle}>Chats</div>
              <button className={styles.plus} title="New chat" aria-label="New chat" onClick={() => setNaming(!naming)}>+</button>
            </div>
            {[...chats].sort((a, b) => Number(b.is_general) - Number(a.is_general) || byTime(a, b)).map((c) => (
              <button key={c.id} className={`${styles.chat} ${view === "chat" && c.id === chat?.id ? styles.chatActive : ""}`} onClick={() => openChat(c.id)}>
                <span className={styles.chatName}>{c.name}</span>
                {decisions.some((d) => d.chat_id === c.id && d.status === "open") && <span className={styles.chatDot} />}
              </button>
            ))}
            {naming && (
              <form onSubmit={makeChat} className={styles.newChat}>
                <input className="field" autoFocus maxLength={60} value={newChat} onChange={(e) => setNewChat(e.target.value)}
                  placeholder="Name the chat" aria-label="Name the new chat" />
              </form>
            )}
          </div>
          {notes.length > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>Pinned</div>
              {[...notes].sort((a, b) => (a.kind === "summary" ? -1 : b.kind === "summary" ? 1 : a.title.localeCompare(b.title))).map((n) => (
                <button key={n.id} className={styles.chat} onClick={() => setOpenNote(n)} data-testid="pinned">
                  <span className={styles.chatName}>{n.kind === "summary" ? "The project" : n.title}</span>
                </button>
              ))}
            </div>
          )}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>Your AI</div>
            {myConnection ? (
              <div className={styles.claudeStatus} data-testid="my-claude">
                <span className={`${styles.dot} ${styles.dotOn}`} />
                <span className={styles.claudeText}>Claude connected</span>
                <button className={styles.toolLink} onClick={() => disconnect(myConnection.id)}>Disconnect</button>
              </div>
            ) : (
              <button className={`btn btn-quiet ${styles.connectButton}`} onClick={() => setConnectOpen(true)}>Connect my AI</button>
            )}
          </div>
          <div className={styles.section}>
            <div className={styles.sectionTitle}>People</div>
            {members.map((m) => (
              <div key={m.id} className={styles.person}>
                <div className={styles.avatar} style={{ background: m.color, opacity: online.has(m.id) ? 1 : 0.6 }}>{initial(m.display_name)}</div>
                <div className={styles.personText}>
                  <div className={styles.personName}>{m.display_name}{m.id === me.id ? " (you)" : ""}</div>
                  <div className={styles.personMeta}>
                    <span className={`${styles.dot} ${online.has(m.id) ? styles.dotOn : styles.dotOff}`} />
                    {online.has(m.id) ? "Here" : "Away"} · {ROLE_WORD[m.role]}
                    {m.role === "client" ? (liveAI.has(m.id) ? " · Assistant on" : "") : liveClaude.has(m.id) ? " · Claude on" : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className={styles.section}>
            <Link className={styles.chat} href={`/t/${table.id}/usage`}>Usage</Link>
            <button className={styles.chat} onClick={() => downloadExport("export_mine", table.id, table.name)}>Download what&apos;s mine</button>
            <Link className={styles.chat} href="/privacy">Privacy</Link>
            <Link className={styles.chat} href={`/t/${table.id}/activity`}>Activity</Link>
            {me.role === "owner" && <Link className={styles.chat} href={`/t/${table.id}/settings`}>Settings</Link>}
          </div>
        </aside>

        {view === "table" && (
          <main className={styles.main}>
            <TableView table={table} me={me} members={members} connections={connections} jobs={jobs} online={online} messages={messages}
              chats={chats} onOpenChat={openChat} onConnect={() => setConnectOpen(true)} onInvite={me.role === "owner" ? () => setInviting(true) : undefined} />
          </main>
        )}
        <main className={styles.main} hidden={view === "table"}>
          <div className={styles.threadHead}>
            <div className={styles.threadTitle}>{chat?.name ?? "General"}</div>
            <div className={styles.threadSub}>{!live ? "Connecting…" : chat?.about || "Team only"}</div>
          </div>

          <div ref={scrollRef} className={styles.scroll} onScroll={onScroll} data-testid="messages">
            <div className={styles.list}>
              {items.length === 0 && (
                <div className={styles.empty}>
                  <div className={styles.emptyTitle}>{chat?.is_general ? "The table is set" : `Nothing in ${chat?.name ?? "this chat"} yet`}</div>
                  <div className="note">Connect your AI from the table (press Longtable, top left), then ask the table anything about your project. Invite people from your picture, top right.</div>
                </div>
              )}
              {items.map((it) => {
                if (it.kind === "decision") return card(it.d, false);
                const m = it.m;
                const who = byId.get(m.member_id);
                const name = who?.display_name ?? "Someone";
                if (m.kind === "github") {
                  return (
                    <div key={m.id} className={styles.githubLine} data-mid={m.id} data-github="true">
                      <span className={styles.githubTag}>GitHub</span>
                      <span className={styles.githubText}>{m.body}</span>
                      <span className={styles.githubWhen}><Time iso={m.created_at} /></span>
                    </div>
                  );
                }
                if (m.kind === "client") {
                  const req = m.meta?.request ? requestById.get(m.meta.request) : undefined;
                  const shown = req ? requestWords(req.status, name) : null;
                  const offer = !!req && (req.status === "asked" || req.status === "answered") && lastCard.get(req.id)?.id === m.id;
                  return (
                    <div key={m.id} className={styles.message} data-mid={m.id} data-request={m.meta?.request ?? ""}>
                      <div className={styles.messageAvatar} style={{ background: who?.color ?? "var(--faint)" }}>
                        {initial(name)}
                      </div>
                      <div className={styles.messageBody}>
                        <div className={styles.messageMeta}>
                          <span className={styles.messageName}>{name}</span>
                          <span>client · <Time iso={m.created_at} /></span>
                        </div>
                        {m.meta?.answers && m.meta.question && <div className={styles.questionQuote}>Answering: {m.meta.question}</div>}
                        <div className={`${styles.messageText} ${styles.clientBubble}`}>{m.body}</div>
                        {req && shown && (
                          <div className={styles.clientTools}>
                            <span className={`${styles.requestPill} ${shown.pill}`} data-testid="request-status">{shown.words}</span>
                            {offer && (
                              <button className={styles.toolLink} onClick={() => { setAskingFor(req); setAsking(true); }}>Ask for a decision</button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                }
                if (m.by_ai) {
                  return <Answer key={m.id} m={m} members={byId} views={m.meta?.round ? viewsByRound.get(m.meta.round) ?? [] : []} />;
                }
                return (
                  <div key={m.id} className={`${styles.message} ${m.state === "sending" ? styles.pending : ""}`} data-mid={m.id}>
                    <div className={styles.messageAvatar} style={{ background: who?.color ?? "var(--faint)" }}>
                      {initial(name)}
                    </div>
                    <div className={styles.messageBody}>
                      <div className={styles.messageMeta}>
                        <span className={styles.messageName}>{name}</span>
                        <span><Time iso={m.created_at} /></span>
                        {m.state === "failed" && <span className={styles.failed}>Not sent</span>}
                      </div>
                      <div className={styles.messageText}><Inline text={m.body} /></div>
                    </div>
                  </div>
                );
              })}
              {working.filter((j) => j.status !== "failed" || now - new Date(j.created_at).getTime() < 15 * 60 * 1000).map((j) => {
                const name = byId.get(j.member_id)?.display_name ?? "Someone";
                const text = j.status === "failed" ? `${name}'s Claude couldn't finish: ${j.error ?? "it gave up"}`
                  : j.kind === "combine" ? (j.status === "waiting" ? `${name}'s Claude writes the answer once the views are in` : `${name}'s Claude is writing the answer…`)
                  : j.kind === "view" ? (j.status === "running" ? `${name}'s Claude is giving its view…` : `Waiting for ${name}'s Claude's view`)
                  : j.kind === "intro" ? `${name}'s Claude is reading the project…`
                  : j.status === "running" ? `${name}'s Claude is reading the code…` : `Waiting for ${name}'s Claude`;
                return (
                  <div key={j.id} className={`${styles.working} ${j.status === "failed" ? styles.workingFailed : ""}`} data-testid="working">
                    {j.status !== "failed" && <span className={styles.workingDot} />}{text}
                  </div>
                );
              })}
            </div>
          </div>

          <div className={styles.composerWrap}>
            <form className={styles.composer} onSubmit={(e) => { e.preventDefault(); send(); }}>
              <textarea
                ref={inputRef}
                className={styles.input}
                rows={1}
                value={draft}
                placeholder={`Message ${chat?.name ?? "the table"}`}
                aria-label="Message the table"
                onChange={(e) => { setDraft(e.target.value); grow(); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (e.ctrlKey || e.metaKey) askTable();
                    else send();
                  }
                }}
              />
              <button type="button" className="btn btn-quiet" disabled={!draft.trim()} onClick={askTable} title="Ctrl+Enter">Ask the table</button>
              <button className="btn" disabled={!draft.trim()}>Send</button>
            </form>
            <div className={styles.composerTools}>
              <button className={styles.toolLink} onClick={() => { setAskingFor(null); setAsking(true); }}>Ask for a decision</button>
              {notice && <span className={styles.notice} role="status">{notice}</span>}
            </div>
          </div>
        </main>

        <aside className={`${styles.inbox} ${inboxOpen ? styles.inboxOpen : ""}`} aria-label="Inbox">
          <div className={styles.inboxHead}>
            <div className={styles.inboxTitle}>Inbox</div>
            <div className={styles.inboxCount}>{waiting}</div>
          </div>
          <div className={styles.inboxList}>
            {open.length === 0 && <div className={styles.inboxEmpty}>Nothing waiting for a yes</div>}
            {open.map((d) => card(d, true))}
            {decided.length > 0 && (
              <div className={styles.inboxDivider}><span>Decided</span><span className={styles.rule} /></div>
            )}
            {decided.map((d) => card(d, true))}
          </div>
        </aside>
      </div>

      {openNote && (
        <div className={styles.modalBack} onClick={() => setOpenNote(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={openNote.title}>
            <div className={styles.modalTitle}>{openNote.kind === "summary" ? "The project" : openNote.title}</div>
            <div className={`${styles.messageText} ${styles.aiText}`}><Inline text={openNote.body} /></div>
            <div className={styles.modalActions}><button className="btn btn-quiet" onClick={() => setOpenNote(null)}>Close</button></div>
          </div>
        </div>
      )}
      {inviting && <Invite tableId={table.id} onClose={() => setInviting(false)} />}
      {connectOpen && (
        <ConnectModal tableId={table.id} tableName={table.name} connected={!!myConnection} onClose={() => setConnectOpen(false)} />
      )}
      {asking && chat && (
        <NewDecision
          chatId={chat.id}
          myName={me.display_name}
          clientName={clientName}
          hasClient={!!client}
          request={askingFor ? { id: askingFor.id, title: askingFor.title, body: askingFor.body, who: byId.get(askingFor.member_id)?.display_name ?? clientName } : null}
          onClose={() => { setAsking(false); setAskingFor(null); }}
        />
      )}
    </div>
  );
}
