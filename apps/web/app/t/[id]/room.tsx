"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { Mark } from "@/components/mark";
import { browserClient } from "@/lib/supabase/browser";
import { formatTime } from "@/lib/time";
import styles from "./room.module.css";

export type Member = { id: string; display_name: string; role: "owner" | "developer" | "client"; color: string };
export type Message = { id: string; member_id: string; body: string; created_at: string; state?: "sending" | "failed" };

const ROLE_WORD = { owner: "Owner", developer: "Developer", client: "Client" } as const;
const initial = (name: string) => name.trim().charAt(0).toUpperCase() || "?";
const byTime = (a: Message, b: Message) => a.created_at.localeCompare(b.created_at);

export function Room({ table, me, initialMembers, initialMessages }: {
  table: { id: string; name: string };
  me: Member;
  initialMembers: Member[];
  initialMessages: Message[];
}) {
  const supabase = useMemo(() => browserClient(), []);
  const [members, setMembers] = useState(initialMembers);
  const [messages, setMessages] = useState(initialMessages);
  const [online, setOnline] = useState<Set<string>>(() => new Set([me.id]));
  const [live, setLive] = useState(false);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const atBottom = useRef(true);
  const known = useRef(new Set(initialMembers.map((m) => m.id)));
  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const refreshMembers = useCallback(async () => {
    const { data } = await supabase.from("members").select("id, display_name, role, color").eq("table_id", table.id).order("created_at");
    if (data) {
      known.current = new Set(data.map((m: Member) => m.id));
      setMembers(data as Member[]);
    }
  }, [supabase, table.id]);

  // Live: new messages and who is here, on the table's private team channel.
  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      await supabase.realtime.setAuth();
      if (cancelled) return;
      const ch = supabase.channel(`team:${table.id}`, { config: { private: true, presence: { key: me.id } } });
      channel = ch;
      ch.on("broadcast", { event: "INSERT" }, ({ payload }: { payload: unknown }) => {
        const rec = (payload as { record?: Message }).record;
        if (!rec) return;
        setMessages((prev) => (prev.some((m) => m.id === rec.id) ? prev : [...prev, rec]));
        if (!known.current.has(rec.member_id)) refreshMembers();
      })
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
  }, [supabase, table.id, me.id, refreshMembers]);

  // Stay at the bottom while new messages arrive, unless someone scrolled up to read.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

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
    if (!body) return;
    setDraft("");
    requestAnimationFrame(grow);
    atBottom.current = true;
    const tempId = `sending-${crypto.randomUUID()}`;
    setMessages((prev) => [...prev, { id: tempId, member_id: me.id, body, created_at: new Date().toISOString(), state: "sending" }]);
    const { data, error } = await supabase
      .from("messages")
      .insert({ table_id: table.id, member_id: me.id, body })
      .select("id, member_id, body, created_at")
      .single();
    setMessages((prev) => {
      if (error || !data) return prev.map((m) => (m.id === tempId ? { ...m, state: "failed" } : m));
      const rest = prev.filter((m) => m.id !== tempId);
      return rest.some((m) => m.id === data.id) ? rest : [...rest, data as Message];
    });
  }

  const sorted = useMemo(() => [...messages].sort(byTime), [messages]);
  const here = members.filter((m) => online.has(m.id));

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
        {me.role === "owner" && <Invite tableId={table.id} />}
      </header>

      <div className={styles.grid}>
        <aside className={styles.aside}>
          <div className={styles.section}>
            <div className={styles.sectionTitle}>Chats</div>
            <div className={styles.chat}>General</div>
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
                  </div>
                </div>
              </div>
            ))}
          </div>
        </aside>

        <main className={styles.main}>
          <div className={styles.threadHead}>
            <div className={styles.threadTitle}>General</div>
            <div className={styles.threadSub}>{live ? "The team's chat" : "Connecting…"}</div>
          </div>

          <div ref={scrollRef} className={styles.scroll} onScroll={onScroll} data-testid="messages">
            <div className={styles.list}>
              {sorted.length === 0 && (
                <div className={styles.empty}>
                  <div className={styles.emptyTitle}>The table is set</div>
                  <div className="note">Say hello, or invite your team. Their Claudes can join once Connect is ready.</div>
                </div>
              )}
              {sorted.map((m) => {
                const who = byId.get(m.member_id);
                return (
                  <div key={m.id} className={`${styles.message} ${m.state === "sending" ? styles.pending : ""}`} data-mid={m.id}>
                    <div className={styles.messageAvatar} style={{ background: who?.color ?? "var(--faint)" }}>
                      {initial(who?.display_name ?? "?")}
                    </div>
                    <div className={styles.messageBody}>
                      <div className={styles.messageMeta}>
                        <span className={styles.messageName}>{who?.display_name ?? "Someone"}</span>
                        <span suppressHydrationWarning>{formatTime(m.created_at)}</span>
                        {m.state === "failed" && <span className={styles.failed}>Not sent</span>}
                      </div>
                      <div className={styles.messageText}>{m.body}</div>
                    </div>
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
                placeholder="Message the table"
                aria-label="Message the table"
                onChange={(e) => { setDraft(e.target.value); grow(); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <button className="btn" disabled={!draft.trim()}>Send</button>
            </form>
          </div>
        </main>
      </div>
    </div>
  );
}

// Invite links: the owner picks developer or client and copies a one-time link.
function Invite({ tableId }: { tableId: string }) {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  async function make(role: "developer" | "client") {
    setBusy(true);
    setError("");
    setCopied(false);
    const { data, error } = await browserClient().rpc("create_invite", { t: tableId, invite_role: role });
    setBusy(false);
    if (error || !data) return setError(error?.message ?? "Something went wrong. Try again.");
    setLink(`${window.location.origin}/join/${data}`);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={styles.invite}>
      <button className="btn" onClick={() => { setOpen(!open); setLink(""); setError(""); }}>Invite</button>
      {open && (
        <div className={styles.popover}>
          <div className={styles.popoverTitle}>Invite someone to this table</div>
          <div className={styles.roles}>
            <button className="btn btn-quiet" disabled={busy} onClick={() => make("developer")}>A developer</button>
            <button className="btn btn-quiet" disabled={busy} onClick={() => make("client")}>The client</button>
          </div>
          {link && (
            <>
              <div className={styles.linkBox} data-testid="invite-link">{link}</div>
              <button className="btn" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
              <div className="note">Works once, for 7 days. Send it any way you like.</div>
            </>
          )}
          {error && <div className="error">{error}</div>}
        </div>
      )}
    </div>
  );
}
