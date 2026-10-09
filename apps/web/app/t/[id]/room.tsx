"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { Mark } from "@/components/mark";
import { browserClient } from "@/lib/supabase/browser";
import { Inline } from "@/lib/inline";
import { formatTime } from "@/lib/time";
import { Answer } from "./answer";
import { ConnectModal } from "./connect-modal";
import { DecisionCard } from "./decision-card";
import { Invite } from "./invite";
import { NewDecision } from "./new-decision";
import { DECISION_COLUMNS, MESSAGE_COLUMNS, type Chat, type Connection, type Decision, type Job, type Member, type Message, type Note } from "./types";
import styles from "./room.module.css";

const ROLE_WORD = { owner: "Owner", developer: "Developer", client: "Client" } as const;
const initial = (name: string) => name.trim().charAt(0).toUpperCase() || "?";
const byTime = <T extends { created_at: string }>(a: T, b: T) => a.created_at.localeCompare(b.created_at);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type Change = { table?: string; record?: Record<string, unknown> };

export function Room({ table, me, initialMembers, initialChats, initialMessages, initialDecisions, initialJobs, initialConnections, initialNotes, initialChatId }: {
  table: { id: string; name: string };
  me: Member;
  initialMembers: Member[];
  initialChats: Chat[];
  initialMessages: Message[];
  initialDecisions: Decision[];
  initialJobs: Job[];
  initialConnections: Connection[];
  initialNotes: Note[];
  initialChatId: string;
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
  const [openNote, setOpenNote] = useState<Note | null>(null);
  const [notice, setNotice] = useState("");
  const [chatId, setChatId] = useState(initialChatId);
  const [online, setOnline] = useState<Set<string>>(() => new Set([me.id]));
  const [live, setLive] = useState(false);
  const [draft, setDraft] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [inboxOpen, setInboxOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [naming, setNaming] = useState(false);
  const [newChat, setNewChat] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const atBottom = useRef(true);
  const known = useRef(new Set(initialMembers.map((m) => m.id)));

  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const chatById = useMemo(() => new Map(chats.map((c) => [c.id, c])), [chats]);
  const client = members.find((m) => m.role === "client");
  const clientName = client?.display_name ?? "the client";
  const chat = chatById.get(chatId) ?? chats[0];
  const liveClaude = new Set(connections.filter((c) => !c.revoked_at && c.kind === "claude").map((c) => c.member_id));
  const myConnection = connections.find((c) => !c.revoked_at && c.kind === "claude" && c.member_id === me.id);
  const working = jobs.filter((j) => j.chat_id === chat?.id && ["queued", "running", "waiting", "failed"].includes(j.status))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  const refreshMembers = useCallback(async () => {
    const { data } = await supabase.from("members").select("id, display_name, role, color").eq("table_id", table.id).order("created_at");
    if (data) {
      known.current = new Set((data as Member[]).map((m) => m.id));
      setMembers(data as Member[]);
    }
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
          if (status === "SUBSCRIBED") await ch.track({ at: Date.now() });
        });
    })();
    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [supabase, table.id, me.id, refreshMembers, loadDecision]);

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

  function openChat(id: string) {
    setChatId(id);
    atBottom.current = true;
    window.history.replaceState(null, "", `?c=${id}`);
    setInboxOpen(false);
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

  const card = (d: Decision, inInbox: boolean) => (
    <DecisionCard
      key={`${inInbox ? "i" : "c"}-${d.id}`}
      decision={d}
      chatName={chatById.get(d.chat_id)?.name ?? "Chat"}
      members={byId}
      clientName={capital(clientName)}
      now={now}
      onOpenChat={inInbox ? () => openChat(d.chat_id) : undefined}
      onChange={(patch) => patchDecision(d.id, patch)}
    />
  );

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.brand}><Mark size={26} /> Longtable</div>
        <div className={styles.divider} />
        <div className={styles.project}>{table.name}</div>
        <div className={styles.spacer} />
        <div className={styles.faces} title={`${here.length} here now`}>
          {here.map((m) => (
            <div key={m.id} className={styles.face} style={{ background: m.color }}>{initial(m.display_name)}</div>
          ))}
        </div>
        <button className={`btn btn-quiet ${styles.inboxToggle}`} onClick={() => setInboxOpen(!inboxOpen)}>
          Inbox{open.length > 0 ? ` (${open.length})` : ""}
        </button>
        {me.role === "owner" && <Invite tableId={table.id} />}
      </header>

      <div className={styles.grid}>
        <aside className={styles.aside}>
          <div className={styles.section}>
            <div className={styles.sectionHead}>
              <div className={styles.sectionTitle}>Chats</div>
              <button className={styles.plus} title="New chat" aria-label="New chat" onClick={() => setNaming(!naming)}>+</button>
            </div>
            {[...chats].sort((a, b) => Number(b.is_general) - Number(a.is_general) || byTime(a, b)).map((c) => (
              <button key={c.id} className={`${styles.chat} ${c.id === chat?.id ? styles.chatActive : ""}`} onClick={() => openChat(c.id)}>
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
            <div className={styles.sectionTitle}>Your Claude</div>
            {myConnection ? (
              <div className={styles.claudeStatus} data-testid="my-claude">
                <span className={`${styles.dot} ${styles.dotOn}`} />
                <span className={styles.claudeText}>Connected</span>
                <button className={styles.toolLink} onClick={() => disconnect(myConnection.id)}>Disconnect</button>
              </div>
            ) : (
              <button className={`btn btn-quiet ${styles.connectButton}`} onClick={() => setConnectOpen(true)}>Connect my Claude</button>
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
                    {online.has(m.id) ? "Here" : "Away"} · {ROLE_WORD[m.role]}{liveClaude.has(m.id) ? " · Claude on" : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className={styles.section}>
            <Link className={styles.chat} href={`/t/${table.id}/activity`}>Activity</Link>
          </div>
        </aside>

        <main className={styles.main}>
          <div className={styles.threadHead}>
            <div className={styles.threadTitle}>{chat?.name ?? "General"}</div>
            <div className={styles.threadSub}>{!live ? "Connecting…" : chat?.about || "Team only"}</div>
          </div>

          <div ref={scrollRef} className={styles.scroll} onScroll={onScroll} data-testid="messages">
            <div className={styles.list}>
              {items.length === 0 && (
                <div className={styles.empty}>
                  <div className={styles.emptyTitle}>{chat?.is_general ? "The table is set" : `Nothing in ${chat?.name ?? "this chat"} yet`}</div>
                  <div className="note">Say hello, ask for a decision, or invite your team. Their Claudes can join once Connect is ready.</div>
                </div>
              )}
              {items.map((it) => {
                if (it.kind === "decision") return card(it.d, false);
                const m = it.m;
                const who = byId.get(m.member_id);
                const name = who?.display_name ?? "Someone";
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
                        <span suppressHydrationWarning>{formatTime(m.created_at)}</span>
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
              <button className={styles.toolLink} onClick={() => setAsking(true)}>Ask for a decision</button>
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
      {connectOpen && (
        <ConnectModal tableId={table.id} tableName={table.name} connected={!!myConnection} onClose={() => setConnectOpen(false)} />
      )}
      {asking && chat && (
        <NewDecision
          chatId={chat.id}
          myName={me.display_name}
          clientName={clientName}
          hasClient={!!client}
          onClose={() => setAsking(false)}
        />
      )}
    </div>
  );
}
