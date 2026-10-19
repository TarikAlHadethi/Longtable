"use client";

import { Face } from "@/components/face";
import { Crown } from "@/components/icons";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { AI_NAME } from "@/components/ai-logo";
import { Mark } from "@/components/mark";
import { browserClient } from "@/lib/supabase/browser";
import { Inline } from "@/lib/inline";
import { AttachButtons, AttachTray, Files, dropHandlers, useAttach } from "./attach";
import { AiWindow, TableWindow } from "./seat-windows";
import { PageIcon, PagesList, PageWindow } from "./page-window";
import { Time } from "@/components/time";
import { Answer } from "./answer";
import { ChatList } from "./chat-list";
import { ConnectModal } from "./connect-modal";
import { DecisionCard } from "./decision-card";
import { Invite } from "./invite";
import { NewDecision } from "./new-decision";
import { ClientPage } from "./client-page";
import { BugButton, LogsPanel } from "./panels";
import { PersonWindow } from "./person-window";
import { loadSettings, SettingsForm, type SettingsData } from "./settings/settings-form";
import { ProfileMenu } from "./profile-menu";
import { TableView } from "./table-view";
import { UsagePanel } from "./usage-panel";
import { elapsed, WorkPanel } from "./work-panel";
import { SandboxReview } from "./sandbox-review";
import {
  CONNECTION_COLUMNS, DECISION_COLUMNS, JOB_COLUMNS, MEMBER_COLUMNS, MESSAGE_COLUMNS, NOTE_COLUMNS, REQUEST_COLUMNS,
  type Chat, type Command, type Connection, type Decision, type Job, type Member, type Message, type Note, type Request,
  CHANGE_COLUMNS, type SandboxChange, SANDBOX_COLUMNS, type SandboxRow, TASK_COLUMNS, type Task,
  PAGE_COLUMNS, PAGE_COMMENT_COLUMNS, PAGE_VERSION_COLUMNS, type Page, type PageComment, type PageValue, type PageVersion,
  APPROVAL_COLUMNS, type Approval,
} from "./types";
import { ApprovalCards } from "./approvals";
import styles from "./room.module.css";
import { firstName } from "@/lib/names";
import { CODEX_NAMES, EFFORT_LEVELS, SLASH, slashEntry } from "@/lib/slash.mjs";
// Names both Claude Code and Codex have: shown for a Claude too.
const CLAUDE_ALSO: Record<string, true> = { model: true, status: true, effort: true, usage: true, rename: true, color: true, compact: true, mcp: true };

const byTime = <T extends { created_at: string }>(a: T, b: T) => a.created_at.localeCompare(b.created_at);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type Change = { table?: string; record?: Record<string, unknown> };
type View = "table" | "chat" | "client" | "logs" | "settings" | "sandbox";

// Times from the server and from this computer are written differently; they are compared as moments, not as text.
const after = (a: string, b: string) => new Date(a).getTime() > new Date(b).getTime();

export function Room({ table, me, initialMembers, initialChats, initialMessages, initialDecisions, initialJobs, initialConnections, initialNotes, initialRequests, initialChatId, initialView, initialTableModel, initialTasks, initialChanges, initialSandboxes, initialSandboxSettings, initialSandbox }: {
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
  initialView: View;
  initialTableModel: string | null;
  initialTasks: Task[];
  initialChanges: SandboxChange[];
  initialSandboxes: SandboxRow[];
  initialSandboxSettings: { ours: string | null; cap: number | null; paths: string };
  initialSandbox: string | null;
}) {
  const supabase = useMemo(() => browserClient(), []);
  // Which clients have a copy of their own is kept apart from the people (clients can read those), and laid over
  // them here for the team.
  const boxes = useRef(new Map(initialSandboxes.map((b) => [b.member_id, b])));
  const boxed = useCallback((list: Member[]) => list.map((m) => {
    const b = boxes.current.get(m.id);
    return { ...m, client_mode: b?.mode ?? "chat", sandbox_branch: b?.branch ?? null, sandbox_url: b?.url ?? null } as Member;
  }), []);
  const [members, setMembersRaw] = useState(() => boxed(initialMembers));
  const setMembers = useCallback((next: Member[] | ((prev: Member[]) => Member[])) => setMembersRaw((prev) => boxed(typeof next === "function" ? next(prev) : next)), [boxed]);
  const [chats, setChats] = useState(initialChats);
  const [messages, setMessages] = useState(initialMessages);
  const [decisions, setDecisions] = useState(initialDecisions);
  const [jobs, setJobs] = useState(initialJobs);
  const [tasks, setTasks] = useState(initialTasks);
  // Clients' own copies: what each changed there, whose copy is open in the middle, and where the versions open.
  const [changes, setChanges] = useState(initialChanges);
  const [sandboxOf, setSandboxOf] = useState<string | null>(initialSandbox);
  const [links, setLinks] = useState(initialSandboxSettings);
  // When this person last cleared the list of work: what finished before then is not shown to them.
  const [clearedAt, setClearedAt] = useState<string | null>(initialMembers.find((m) => m.id === me.id)?.tasks_cleared_at ?? null);
  const [connections, setConnections] = useState(initialConnections);
  const [connectOpen, setConnectOpen] = useState(false);
  const [notes, setNotes] = useState(initialNotes);
  const [requests, setRequests] = useState(initialRequests);
  const [askingFor, setAskingFor] = useState<Request | null>(null);
  const [notice, setNotice] = useState("");
  // Something pressed did not go through: the screen goes back to how it was, and this says so for a few seconds.
  // Before, each of these failures was silent and the new value stayed showing as if it had been kept.
  const [failed, setFailed] = useState("");
  const failTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didNotTake = useCallback((message?: string) => {
    setFailed(message || "That did not go through. Try again.");
    if (failTimer.current) clearTimeout(failTimer.current);
    failTimer.current = setTimeout(() => setFailed(""), 6000);
  }, []);
  const [chatId, setChatId] = useState(initialChatId);
  // The room opens on the table itself; a chat opens from there or from the list.
  const [view, setView] = useState<View>(initialView);
  // A person opens in a window over the room, wherever you are in it.
  const [personId, setPersonId] = useState<string | null>(null);
  const [editingMe, setEditingMe] = useState(false);
  // Whose side is being looked at, when there is more than one client.
  const [clientId, setClientId] = useState<string | null>(null);
  // Leaning toward the client's side: the pointer is on the glass in the corner.
  const [tableName, setTableName] = useState(table.name);
  const [inviting, setInviting] = useState(false);
  // The model the table's own answer is written on; null leaves it to the AI that writes it.
  const [tableModel, setTableModel] = useState(initialTableModel);
  const [online, setOnline] = useState<Set<string>>(() => new Set([me.id]));
  const [live, setLive] = useState(false);
  const [gone, setGone] = useState(false);
  // What is waiting to go with the next message, and the windows of an AI and of the table.
  const attach = useAttach(supabase, table.id, me.id);
  const [aiOf, setAiOf] = useState<string | null>(null);
  // Their own AI's commands and skills: read for this person alone, never with the team's view of connections.
  const [myCommands, setMyCommands] = useState<Command[]>([]);
  const readCommands = useCallback(async () => {
    const { data, error } = await supabase.rpc("my_commands", { t: table.id });
    if (error) console.warn("[commands] could not be read:", error.code);
    else setMyCommands((data as Command[] | null) ?? []);
  }, [supabase, table.id]);
  useEffect(() => { readCommands(); }, [readCommands]);
  // What this person's own full Claude Code is waiting for them to allow. Only they can read it (row level security).
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const readApprovals = useCallback(async () => {
    const { data, error } = await supabase.from("approvals").select(APPROVAL_COLUMNS).eq("table_id", table.id).eq("status", "waiting").order("created_at");
    if (error) console.warn("[approvals] could not be read:", error.code);
    else setApprovals((data as Approval[] | null) ?? []);
  }, [supabase, table.id]);
  useEffect(() => { readApprovals(); }, [readApprovals]);
  // While something waits, look again now and then: a request expires after ten minutes, and a live push can be lost.
  useEffect(() => {
    if (!approvals.length) return;
    const t = setInterval(readApprovals, 8000);
    return () => clearInterval(t);
  }, [approvals.length, readApprovals]);
  // The tab says so too, so a request is seen from another tab.
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, "");
    document.title = approvals.length ? `(${approvals.length}) ${base}` : base;
  }, [approvals.length]);
  // The pages the table's AIs made, what each version was, what people said on them, what tools on them keep, and
  // which ones this person pinned. The team's alone: a client never reads any of it.
  const [pages, setPages] = useState<Page[]>([]);
  const [pageVersions, setPageVersions] = useState<PageVersion[]>([]);
  const [pageComments, setPageComments] = useState<PageComment[]>([]);
  const [pageValues, setPageValues] = useState<PageValue[]>([]);
  const [pins, setPins] = useState<Set<string>>(new Set());
  const [openPage, setOpenPage] = useState<string | null>(null);
  const [pagesOpen, setPagesOpen] = useState(false);
  const [viewing, setViewing] = useState<Map<string, string[]>>(new Map());
  const readPages = useCallback(async () => {
    const [pg, vs, cm, st, pn] = await Promise.all([
      supabase.from("pages").select(PAGE_COLUMNS).eq("table_id", table.id).order("touched_at", { ascending: false }).limit(200),
      supabase.from("page_versions").select(PAGE_VERSION_COLUMNS).eq("table_id", table.id).order("n").limit(2000),
      supabase.from("page_comments").select(PAGE_COMMENT_COLUMNS).eq("table_id", table.id).order("created_at").limit(2000),
      supabase.from("page_state").select("page_id, key, value, updated_by, updated_at").eq("table_id", table.id).limit(5000),
      supabase.from("page_pins").select("page_id").eq("member_id", me.id),
    ]);
    const bad = [pg, vs, cm, st, pn].find((r) => r.error);
    if (bad) { console.warn("[pages] could not be read:", bad.error?.code); return; }
    setPages(pg.data as Page[]);
    setPageVersions(vs.data as PageVersion[]);
    setPageComments(cm.data as PageComment[]);
    setPageValues(st.data as PageValue[]);
    setPins(new Set((pn.data as { page_id: string }[]).map((x) => x.page_id)));
  }, [supabase, table.id, me.id]);
  useEffect(() => { readPages(); }, [readPages]);
  const channelRef = useRef<RealtimeChannel | null>(null);
  // Who else has a page open: told through the team's own presence, never stored.
  useEffect(() => { channelRef.current?.track({ at: Date.now(), page: openPage }).catch(() => {}); }, [openPage]);
  const [tableOpen, setTableOpen] = useState(false);
  const [slashAt, setSlashAt] = useState(0);
  const [draft, setDraft] = useState("");
  const [now, setNow] = useState(() => Date.now());
  // How far this computer's clock is from the server's, measured once: deadlines the server set are counted with it.
  const skew = useRef(0);
  useEffect(() => {
    const sent = Date.now();
    supabase.rpc("server_now").then(({ data, error }: { data: unknown; error: unknown }) => {
      if (error || typeof data !== "string") return;
      const back = Date.now();
      skew.current = new Date(data).getTime() - (sent + back) / 2;
    });
  }, [supabase]);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  // The live channel is set up once; it reaches the newest dropChat through this.
  const dropRef = useRef<(id: string) => void>(() => {});
  const chatIdRef = useRef(initialChatId);
  const viewRef = useRef<View>(initialView);
  const generalRef = useRef<string | null>(initialChats.find((c) => c.is_general)?.id ?? null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const atBottom = useRef(true);
  const known = useRef(new Set(initialMembers.map((m) => m.id)));

  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  // This person as the table has them now: their role can change while the page is open (the table handed over).
  const self = byId.get(me.id) ?? me;
  // The table's settings are read once here, so Settings is whole the moment it is opened.
  const [settings, setSettings] = useState<SettingsData | null>(null);
  useEffect(() => {
    if (self.role !== "owner") return;
    let cancelled = false;
    // A failed read leaves it to Settings itself, which reads again when opened and says so if it still cannot.
    loadSettings(supabase, table.id).then((d) => { if (!cancelled) setSettings(d); }).catch(() => {});
    return () => { cancelled = true; };
  }, [supabase, table.id, self.role]);
  const chatById = useMemo(() => new Map(chats.map((c) => [c.id, c])), [chats]);
  const requestById = useMemo(() => new Map(requests.map((r) => [r.id, r])), [requests]);
  const clients = members.filter((m) => m.role === "client");
  const client = clients[0];
  // Who hears a decision meant for the client: one client by name; with several, every one of them.
  const clientName = clients.length > 1 ? "every client" : client?.display_name ?? "the client";
  const chat = chatById.get(chatId) ?? chats[0];
  const liveAI = new Set(connections.filter((c) => !c.revoked_at).map((c) => c.member_id));
  const myConnection = connections.find((c) => !c.revoked_at && c.member_id === me.id);
  // What to call a person's AI: Claude or ChatGPT once it is connected, their AI before that.
  // Under each person in the sidebar: their AI, connected (a green dot) or not (a grey one). Nothing for someone who
  // never connected one.
  const aiState = (id: string) => {
    const mine = connections.filter((x) => !x.revoked_at && x.member_id === id).sort((a, b) => Number(b.kind === "claude") - Number(a.kind === "claude"));
    const on = mine.find((x) => !!x.last_seen && Date.now() - new Date(x.last_seen).getTime() < 90000);
    const c = on ?? mine[0];
    return c ? { word: c.kind === "codex" ? "Codex" : "Claude", on: !!on } : null;
  };
  const aiWord = (id: string) => { const c = connections.find((x) => !x.revoked_at && x.member_id === id); return c ? AI_NAME[c.kind] : "AI"; };
  const working = jobs.filter((j) => j.chat_id === chat?.id && ["queued", "running", "waiting", "failed"].includes(j.status))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  const refreshMembers = useCallback(async () => {
    const { data } = await supabase.from("members").select(MEMBER_COLUMNS).eq("table_id", table.id).is("removed_at", null).order("created_at");
    if (data) {
      known.current = new Set((data as Member[]).map((m) => m.id));
      setMembers(data as Member[]);
    }
  }, [supabase, table.id]);

  // Live pushes can be lost (a reconnect, the server moving its database feed), so the room also reads the
  // database: when the channel opens or reopens, when the tab comes back, and every few seconds while an AI is
  // working or a decision is on its way out.
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event: string) => { if (event === "SIGNED_OUT") window.location.href = "/sign-in"; });
    return () => data.subscription.unsubscribe();
  }, [supabase]);
  // Reads can overlap. One is thrown away only when a newer one has already been put on the page: on a slow link
  // each still lands, and an older one never undoes a newer one.
  const reads = useRef(0);
  const shown = useRef(0);
  // When the last live change arrived. A read that began before it may hold the state from before it, so it is not
  // put on the page; another read follows instead (at most a few times, so a busy table still settles).
  const pushedAt = useRef(0);
  const retries = useRef(0);
  const catchUp = useCallback(async () => {
    const mine = ++reads.current;
    const began = performance.now();
    const [{ data: recent }, { data: inFlight }, { data: ds }, { data: rq }, { data: ns }, { data: cs }, { data: tk }, { data: sc }, { data: bx }, { data: ch }] = await Promise.all([
      supabase.from("messages").select(MESSAGE_COLUMNS).eq("table_id", table.id).order("created_at", { ascending: false }).limit(100),
      supabase.from("jobs").select(JOB_COLUMNS).eq("table_id", table.id).in("status", ["queued", "running", "waiting", "failed"]).order("created_at", { ascending: false }).limit(50),
      supabase.from("decisions").select(DECISION_COLUMNS).eq("table_id", table.id).order("created_at", { ascending: false }).limit(100),
      supabase.from("requests").select(REQUEST_COLUMNS).eq("table_id", table.id).order("created_at", { ascending: false }).limit(200),
      supabase.from("notes").select(NOTE_COLUMNS).eq("table_id", table.id),
      supabase.from("connections").select(CONNECTION_COLUMNS).eq("table_id", table.id).order("created_at", { ascending: false }).limit(60),
      supabase.from("tasks").select(TASK_COLUMNS).eq("table_id", table.id).order("created_at", { ascending: false }).limit(40),
      supabase.from("sandbox_changes").select(CHANGE_COLUMNS).eq("table_id", table.id).order("created_at", { ascending: false }).limit(120),
      supabase.from("sandboxes").select(SANDBOX_COLUMNS).eq("table_id", table.id),
      supabase.from("chats").select("id, name, about, is_general, created_at, created_by").eq("table_id", table.id),
    ]);
    if (mine < shown.current) return;
    if (pushedAt.current > began && retries.current < 3) {
      retries.current++;
      setTimeout(() => catchUpRef.current?.(), 700);
      return;
    }
    retries.current = 0;
    // The table was closed, or this person was taken off it, with no word reaching this page.
    const { data: still, error: gone } = await supabase.from("members").select("id").eq("id", me.id).is("removed_at", null).maybeSingle();
    if (!gone && !still) return setGone(true);
    if (mine < shown.current) return;
    shown.current = mine;
    if (tk) setTasks(tk as Task[]);
    // The chat list too: one made, renamed or deleted while this page missed the word is put right here.
    if (ch && (ch as Chat[]).length) setChats((ch as Chat[]).slice().sort(byTime));
    if (sc) setChanges(sc as SandboxChange[]);
    if (bx) { boxes.current = new Map((bx as SandboxRow[]).map((b) => [b.member_id, b])); setMembers((prev) => [...prev]); }
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
    readCommands();
    readPages();
  }, [supabase, table.id, me.id, readCommands, readPages]);

  const catchUpRef = useRef<(() => void) | null>(null);
  catchUpRef.current = catchUp;

  const loadDecision = useCallback(async (id: string) => {
    const { data } = await supabase.from("decisions").select(DECISION_COLUMNS).eq("id", id).maybeSingle();
    if (data) setDecisions((prev) => [...prev.filter((d) => d.id !== id), data as unknown as Decision]);
  }, [supabase]);

  // Live: messages, chats and decisions, plus who is here, all on the table's private team channel.
  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    const onChange = (kind: "INSERT" | "UPDATE") => ({ payload }: { payload: unknown }) => {
      pushedAt.current = performance.now();
      const { table: name, record } = (payload ?? {}) as Change;
      if (!record) return;
      if (name === "messages") {
        const m = record as unknown as Message;
        setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev.map((x) => (x.id === m.id ? { ...x, ...m } : x)) : [...prev, m]));
        if (!known.current.has(m.member_id)) refreshMembers();
      } else if (name === "members") {
        const { id, display_name, role, color, created_at, avatar, name_color, status, bubble, test } = record as unknown as Member;
        const fresh: Member = { id, display_name, role, color, created_at, avatar, name_color, status, bubble, test };
        // This person cleared their list of work somewhere else: it is cleared here too.
        if (id === me.id && "tasks_cleared_at" in (record as object)) setClearedAt((record as { tasks_cleared_at?: string | null }).tasks_cleared_at ?? null);
        // Taken off the table: gone from the list, and if it is this person, their page closes.
        if ((record as { removed_at?: string | null }).removed_at) {
          if (id === me.id) setGone(true);
          setMembers((prev) => prev.filter((m) => m.id !== id));
          return;
        }
        known.current.add(id);
        setMembers((prev) => (prev.some((m) => m.id === id)
          ? prev.map((m) => (m.id === id ? fresh : m))
          : [...prev, fresh]));
      } else if (name === "jobs") {
        const j = record as unknown as Job;
        setJobs((prev) => [...prev.filter((x) => x.id !== j.id), j]);
      } else if (name === "sandboxes") {
        const b = record as unknown as SandboxRow;
        boxes.current.set(b.member_id, b);
        setMembers((prev) => [...prev]);
      } else if (name === "sandbox_changes") {
        const c = record as unknown as SandboxChange;
        setChanges((prev) => [c, ...prev.filter((x) => x.id !== c.id)]);
      } else if (name === "tasks") {
        const t = record as unknown as Task;
        setTasks((prev) => [t, ...prev.filter((x) => x.id !== t.id)]);
      } else if (name === "notes") {
        const n = record as unknown as Note;
        if ((record as { deleted?: boolean }).deleted) return setNotes((prev) => prev.filter((x) => x.id !== n.id));
        setNotes((prev) => [...prev.filter((x) => x.id !== n.id), n]);
      } else if (name === "connections") {
        const c = record as unknown as Connection;
        setConnections((prev) => [...prev.filter((x) => x.id !== c.id), { ...prev.find((x) => x.id === c.id), ...c }]);
        if (c.member_id === me.id) readCommands();
      } else if (name === "approvals") {
        // Only an id and whose it is come over the team's channel; the request itself is read by its person alone.
        if ((record as { member_id?: string }).member_id === me.id) readApprovals();
      } else if (name === "table_ai") {
        setTableModel(((record as { model?: string | null }).model) ?? null);
      } else if (name === "requests") {
        const r = record as unknown as Request;
        setRequests((prev) => [...prev.filter((x) => x.id !== r.id), r]);
      } else if (name === "chats") {
        const c = record as unknown as Chat;
        if ((record as { deleted?: boolean }).deleted) return dropRef.current(c.id);
        // The chat this person just named arrives here too, often before their own call returns: it takes the place of the
        // row already showing, keeping its key, so the list never shows it twice or redraws it.
        setChats((prev) => {
          const kept = prev.find((x) => x.id === c.id) ?? prev.find((x) => x.pending && x.name === c.name && x.created_by === c.created_by);
          const rest = prev.filter((x) => x !== kept && x.id !== c.id);
          // Still "being made" until this person's own call opens it, so the highlight never jumps back meanwhile.
          return [...rest, { ...c, local_key: kept?.local_key, pending: kept?.pending ?? false }].sort(byTime);
        });
      } else if (name === "pages") {
        const p = record as unknown as Page & { deleted?: boolean };
        if (p.deleted) { setPages((prev) => prev.filter((x) => x.id !== p.id)); setOpenPage((cur) => (cur === p.id ? null : cur)); return; }
        setPages((prev) => [p, ...prev.filter((x) => x.id !== p.id)]);
      } else if (name === "page_versions") {
        const v = record as unknown as PageVersion;
        setPageVersions((prev) => [...prev.filter((x) => x.id !== v.id), v]);
      } else if (name === "page_comments") {
        const c = record as unknown as PageComment;
        setPageComments((prev) => [...prev.filter((x) => x.id !== c.id), c]);
      } else if (name === "page_state") {
        const v = record as unknown as PageValue;
        setPageValues((prev) => [...prev.filter((x) => !(x.page_id === v.page_id && x.key === v.key)), v]);
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
          const state = ch.presenceState() as Record<string, { page?: string | null }[]>;
          const ids = new Set(Object.keys(state));
          ids.add(me.id);
          setOnline(ids);
          const looking = new Map<string, string[]>();
          for (const [who, metas] of Object.entries(state)) for (const p of new Set(metas.map((x) => x.page).filter(Boolean) as string[])) looking.set(p, [...(looking.get(p) ?? []), who]);
          setViewing(looking);
          if ([...ids].some((id) => !known.current.has(id))) refreshMembers();
        })
        .subscribe(async (status: string) => {
          setLive(status === "SUBSCRIBED");
          if (status === "SUBSCRIBED") {
            channelRef.current = ch;
            await ch.track({ at: Date.now(), page: null });
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
    const t = setInterval(() => setNow(Date.now() + skew.current), 500);
    return () => clearInterval(t);
  }, [counting]);

  const items = useMemo(() => {
    const ms = messages.filter((m) => m.chat_id === chat?.id && m.kind !== "view").map((m) => ({ kind: "message" as const, created_at: m.created_at, m }));
    const ds = decisions.filter((d) => d.chat_id === chat?.id).map((d) => ({ kind: "decision" as const, created_at: d.created_at, d }));
    return [...ms, ...ds].sort(byTime);
  }, [messages, decisions, chat?.id]);
  // Like texting: one person's messages one after another, within a few minutes, sit under each other with their
  // name and picture said once. `follows` drops them from a message; `held` keeps the time for the last of the run.
  const runs = useMemo(() => {
    const key = (it: (typeof items)[number]) => it.kind !== "message" || it.m.kind === "intro" || it.m.kind === "github" || it.m.state === "failed" ? null
      : `${it.m.kind === "client" ? "client" : it.m.by_ai ? `ai:${it.m.meta?.round ? "table" : "own"}` : "say"}:${it.m.member_id}`;
    const close = (a: (typeof items)[number], b: (typeof items)[number]) => Math.abs(new Date(b.created_at).getTime() - new Date(a.created_at).getTime()) < 5 * 60 * 1000;
    return items.map((it, i) => {
      const k = key(it);
      return {
        follows: !!k && i > 0 && key(items[i - 1]) === k && close(items[i - 1], it),
        held: !!k && i < items.length - 1 && key(items[i + 1]) === k && close(it, items[i + 1]),
      };
    });
  }, [items]);

  const viewsByRound = useMemo(() => {
    const map = new Map<string, Message[]>();
    for (const m of messages) {
      if (m.kind !== "view" || !m.meta?.round) continue;
      map.set(m.meta.round, [...(map.get(m.meta.round) ?? []), m].sort(byTime));
    }
    return map;
  }, [messages]);

  // Stay at the bottom while new things arrive, unless someone scrolled up to read. And when the chat comes into
  // view: while another page of the room is showing, the chat is not laid out, so there was no bottom to go to.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [items, view]);

  // The room's pages are views of this one page. Going to one changes the address and what is in the middle, and
  // nothing else: no request, so it is there at once.
  const base = `/t/${table.id}`;
  function go(next: View, path: string) {
    setView(next);
    window.history.pushState(null, "", path);
    setInboxOpen(false);
    setDrawerOpen(false);
  }
  function openPerson(id: string, edit = false) { setEditingMe(edit); setPersonId(id); setDrawerOpen(false); }

  function goHome() {
    setView("table");
    window.history.pushState(null, "", base);
    setInboxOpen(false);
    setDrawerOpen(false);
  }

  function openChat(id: string) {
    setView("chat");
    setChatId(id);
    atBottom.current = true;
    window.history.pushState(null, "", `${base}?c=${id}`);
    setInboxOpen(false);
    setDrawerOpen(false);
  }

  // Back and forward in the browser move between the room's views.
  useEffect(() => {
    const onPop = () => {
      const url = new URL(window.location.href);
      const c = url.searchParams.get("c");
      if (url.pathname.endsWith("/settings")) setView(self.role === "owner" ? "settings" : "logs");
      else if (url.pathname.endsWith("/activity")) setView("logs");
      else if (url.searchParams.get("sandbox")) { setSandboxOf(url.searchParams.get("sandbox")); setView("sandbox"); }
      else if (url.searchParams.get("side") === "client") setView("client");
      else if (c) { setChatId(c === "general" ? generalRef.current ?? chatIdRef.current : c); setView("chat"); }
      else setView("table");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [self.role]);

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

  // A message with things attached: they are uploaded first, then the message carries them. One at a time: a second
  // Enter while the first was still on its way sent it all twice. The box is emptied at once, as for any message, so
  // what is typed during a long upload is kept; if it does not go, the words come back ahead of anything new.
  const sendingFiles = useRef(false);
  async function sendFiles(ask = false) {
    if (!chat || attach.busy || sendingFiles.current) return;
    sendingFiles.current = true;
    const body = draft.trim();
    const putBack = () => { setDraft((d) => (d.trim() ? `${body}\n${d}` : body)); requestAnimationFrame(grow); };
    setDraft("");
    requestAnimationFrame(grow);
    try {
      const files = await attach.upload();
      if (!files) return putBack();
      const { data, error } = ask
        ? await supabase.rpc("ask_table", { c: chat.id, body, files })
        : await supabase.rpc("send_with_files", { c: chat.id, body, files });
      if (error) {
        await supabase.storage.from("attachments").remove(files.map((f) => f.path)).catch(() => {});
        putBack();
        return setNotice(error.message);
      }
      attach.clear();
      setNotice("");
      finishFiles(ask, data);
    } finally {
      sendingFiles.current = false;
    }
  }
  async function finishFiles(ask: boolean, data: unknown) {
    atBottom.current = true;
    const id = ask ? (data as { message_id: string }).message_id : (data as string);
    const { data: row } = await supabase.from("messages").select(MESSAGE_COLUMNS).eq("id", id).single();
    if (row) setMessages((prev) => (prev.some((m) => m.id === (row as Message).id) ? prev.map((m) => (m.id === (row as Message).id ? (row as Message) : m)) : [...prev, row as Message]));
    if (ask) catchUp();
  }

  async function send() {
    if (attach.pending.length) return sendFiles();
    const body = draft.trim();
    if (!body || !chat) return;
    if (body.startsWith("/") && doSlash(body)) { setDraft(""); requestAnimationFrame(grow); return; }
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
    if (error || !data) {
      // It did not go: the words come back to the box (unless something new was typed meanwhile), and it says so.
      setDraft((d) => (d.trim() ? `${body}\n${d}` : body));
      requestAnimationFrame(grow);
      setNotice("That message was not sent. It is back in the box.");
    } else setNotice("");
    setMessages((prev) => {
      const rest = prev.filter((m) => m.id !== tempId);
      if (error || !data) return rest;
      return rest.some((m) => m.id === (data as Message).id) ? rest : [...rest, data as Message];
    });
  }

  async function askTable() {
    if (attach.pending.length) return sendFiles(true);
    const body = draft.trim();
    if (!body || !chat) return;
    if (body.startsWith("/") && doSlash(body)) { setDraft(""); requestAnimationFrame(grow); return; }
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
    if (!res.answered_by) setNotice("No AI is connected at this table yet, so nobody will answer. Connect yours from the table (press Longtable, top left).");
    // Learn about the job straight away, so the room keeps checking until the answer lands even if a push is lost.
    else catchUp();
  }

  // Their own AI's commands and skills, offered while the box holds only "/" and the start of a name.
  const slashWord = draft.match(/^\/([A-Za-z0-9:_-]*)$/)?.[1];
  const slashAll = useMemo(() => {
    if (!myConnection) return [] as Command[];
    const own = myCommands.filter((c) => c.kind !== "builtin" || c.about);
    const have = new Set(own.map((c) => c.name.toLowerCase()));
    const told = myCommands.filter((c) => c.kind === "builtin" && !c.about).map((c) => c.name);
    // Claude Code's own names, from this person's connection, and the ones the table knows even before it says.
    const rest = [...new Set([...(myConnection.kind === "claude" ? Object.keys(SLASH).filter((n) => !CODEX_NAMES.includes(n) || n in CLAUDE_ALSO) : CODEX_NAMES), ...told])].filter((n) => !have.has(n.toLowerCase()))
      .map((name) => ({ name, about: slashEntry(name, false).about, kind: "builtin" as const }));
    return [...own, ...rest];
  }, [myConnection, myCommands]);
  const runnable = (name: string) => myCommands.some((c) => c.name.toLowerCase() === name.toLowerCase() && (c.kind !== "builtin" || !!c.about));
  const slash = slashWord === undefined ? [] : slashAll.filter((c) => c.name.toLowerCase().includes(slashWord.toLowerCase()))
    .sort((x, y) => slashRank(x) - slashRank(y)
      || Number(y.name.toLowerCase().startsWith(slashWord.toLowerCase())) - Number(x.name.toLowerCase().startsWith(slashWord.toLowerCase())) || x.name.localeCompare(y.name));
  // Their own first; then the ones their Claude runs here in the table's own words; then the rest of Claude Code's,
  // which Longtable's screens carry out or explain. Each group under a line saying so.
  function slashRank(c: Command) { return c.kind !== "builtin" ? 0 : c.about && runnable(c.name) ? 1 : 2; }
  const slashBuiltAt = slash.findIndex((c) => slashRank(c) === 1);
  const slashOwnAt = slash.findIndex((c) => slashRank(c) === 2);
  const slashIndex = Math.min(slashAt, Math.max(0, slash.length - 1));
  function pickSlash(name: string) {
    setSlashAt(0);
    const e = slashEntry(name, runnable(name));
    // Ones that need nothing more are done at once; the rest wait for what comes after the name.
    if (e.act === "say" || (e.act === "open" && ["ai", "usage", "profile"].includes(e.where))) { setDraft(""); doSlash(`/${name}`); return; }
    setDraft(`/${name} `);
    requestAnimationFrame(() => { grow(); inputRef.current?.focus(); });
  }

  // A "/" command that steers this person's own AI or the table's screens is done here and never sent to the chat.
  // True when it was one; a command that runs (theirs, or one the table does in its own words) goes on as a message.
  function doSlash(body: string): boolean {
    const m = body.match(/^\/([A-Za-z0-9:_-]+)\s*([\s\S]*)$/);
    if (!m || !myConnection) return false;
    const [, name, rest] = m;
    const args = rest.trim();
    const e = slashEntry(name, runnable(name));
    if (e.act === "run") return false;
    if (e.act === "say") { setNotice(e.words); return true; }
    if (e.act === "open") {
      if (e.where === "ai") setAiOf(me.id);
      else if (e.where === "usage") window.location.assign(`/t/${table.id}/usage`);
      else if (e.where === "profile") openPerson(me.id, true);
      else if (e.where === "new-chat") makeChat(args.slice(0, 60) || "New chat").then((problem) => setNotice(problem ?? ""));
      else if (e.where === "rename-chat") {
        if (!chat || chat.is_general) setNotice("General keeps its name. Open another chat to rename it.");
        else if (!args) setNotice("Type the new name after /rename.");
        else renameChat(chat.id, args.slice(0, 60)).then((problem) => setNotice(problem ?? `This chat is now called ${args.slice(0, 60)}.`));
      }
      return true;
    }
    if (e.act === "effort") {
      const level = args.toLowerCase();
      if (!level) { setAiOf(me.id); return true; }
      if (!(EFFORT_LEVELS as readonly string[]).includes(level) && level !== "default") { setNotice("Effort is low, medium, high, xhigh or max (or default)."); return true; }
      setSpeed(myConnection.id, { effort: level === "default" ? "" : level }).then((ok) => ok && setNotice(level === "default" ? "Your Claude thinks as hard as its model usually does." : `Your Claude now works at ${level} effort here.`));
      return true;
    }
    if (e.act === "fast") {
      if (myConnection.kind !== "claude") { setNotice("Fast mode is Claude's; ChatGPT has no such mode. /effort works for both."); return true; }
      const word = args.toLowerCase();
      const on = word === "on" ? true : word === "off" ? false : !myConnection.fast;
      setSpeed(myConnection.id, { fast: on }).then((ok) => ok && setNotice(on ? "Fast mode is on for your Claude here, if your account allows it (its window says)." : "Fast mode is off for your Claude here."));
      return true;
    }
    return false;
  }

  async function setSpeed(id: string, patch: { effort?: string; fast?: boolean }) {
    const before = connections.find((c) => c.id === id);
    setConnections((prev) => prev.map((c) => (c.id === id ? { ...c, ...(patch.effort !== undefined ? { effort: patch.effort || null } : {}), ...(patch.fast !== undefined ? { fast: patch.fast } : {}) } : c)));
    const { error } = await supabase.rpc("set_ai_speed", { conn: id, effort: patch.effort ?? null, fast: patch.fast ?? null });
    if (error && before) { setConnections((prev) => prev.map((c) => (c.id === id ? before : c))); didNotTake("That setting was not kept. Try again."); return false; }
    return true;
  }

  async function disconnect(id: string) {
    const { error } = await supabase.rpc("disconnect", { conn: id });
    if (error) return didNotTake("Your AI was not disconnected. Try again.");
    setConnections((prev) => prev.map((c) => (c.id === id ? { ...c, revoked_at: new Date().toISOString() } : c)));
  }

  // A new chat shows in the list the moment it is named, and becomes the real one, in the same place, when the table
  // has made it.
  async function makeChat(name: string) {
    const local = `new-${Math.random().toString(36).slice(2)}`;
    const at = new Date().toISOString();
    setChats((prev) => [...prev, { id: local, local_key: local, name, about: "", is_general: false, created_at: at, created_by: self.id, pending: true }]);
    const { data, error } = await supabase.rpc("create_chat", { t: table.id, chat_name: name, chat_about: "" });
    if (error || !data) {
      setChats((prev) => prev.filter((c) => c.local_key !== local));
      return error?.message ?? "The chat was not made. Try again.";
    }
    const id = data as string;
    setChats((prev) => prev.filter((c) => c.id !== id || c.local_key === local).map((c) => (c.local_key === local ? { ...c, id, pending: false } : c)).sort(byTime));
    openChat(id);
    return null;
  }

  async function renameChat(id: string, name: string) {
    const old = chats.find((c) => c.id === id)?.name;
    setChats((prev) => prev.map((c) => (c.id === id ? { ...c, name } : c)));
    const { error } = await supabase.rpc("rename_chat", { c: id, chat_name: name });
    if (error) { if (old !== undefined) setChats((prev) => prev.map((c) => (c.id === id && c.name === name ? { ...c, name: old } : c))); return error.message; }
    return null;
  }

  // Deleting a chat takes its messages and decisions with it, here and for everyone else at the table.
  function dropChat(id: string) {
    setChats((prev) => prev.filter((c) => c.id !== id));
    setMessages((prev) => prev.filter((m) => m.chat_id !== id));
    setDecisions((prev) => prev.filter((d) => d.chat_id !== id));
    setTasks((prev) => prev.filter((t) => t.chat_id !== id));
    setJobs((prev) => prev.filter((j) => j.chat_id !== id));
    if (chatIdRef.current === id && viewRef.current === "chat") goHome();
  }
  async function deleteChat(id: string) {
    const { error } = await supabase.rpc("delete_chat", { c: id });
    if (error) return error.message;
    dropChat(id);
    return null;
  }

  dropRef.current = dropChat;
  chatIdRef.current = chatId;
  viewRef.current = view;
  generalRef.current = chats.find((c) => c.is_general)?.id ?? generalRef.current;
  // A person's copy that is gone (they were taken off) has nothing to show: back to the table, not an empty middle.
  useEffect(() => {
    if (view === "sandbox" && sandboxOf && !byId.get(sandboxOf)) setView("table");
  }, [view, sandboxOf, byId]);

  function patchDecision(id: string, patch: Partial<Decision>) {
    setDecisions((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }

  // The work panel: what is being worked on, then what finished since this person last cleared it. With nothing to
  // show there is no panel, and the chat has the room to itself.
  const shownTasks = tasks
    .filter((t) => t.status === "working" || !clearedAt || after(t.finished_at ?? t.created_at, clearedAt))
    .sort((a, b) => Number(b.status === "working") - Number(a.status === "working") || (b.finished_at ?? b.created_at).localeCompare(a.finished_at ?? a.created_at));
  // A client's changes waiting for the team's answer show in the work panel too, so nobody has to go looking.
  const toReview = members.filter((m) => m.role === "client" && m.client_mode === "sandbox")
    .map((m) => ({ m, n: changes.filter((c) => c.member_id === m.id && c.status === "ready" && !c.verdict && !c.test).length })).filter((x) => x.n > 0);
  function openSandbox(id: string) {
    setSandboxOf(id); setPersonId(null); setDrawerOpen(false); setInboxOpen(false); setView("sandbox");
    window.history.pushState(null, "", `/t/${table.id}?sandbox=${id}`);
  }
  // The panel on the right is always there beside a chat: work when there is some, and a quiet
  // line when there is none.
  const noSide = view === "settings" || view === "logs" || view === "sandbox";
  async function clearTasks() {
    // At once, to the newest time the server has given for a task: never this computer's own clock, which may be off.
    const before = clearedAt;
    const newest = tasks.reduce((m, t) => { const x = t.finished_at ?? t.created_at; return !m || after(x, m) ? x : m; }, clearedAt ?? "");
    if (newest) setClearedAt(newest);
    setInboxOpen(false);
    const { data, error } = await supabase.rpc("clear_tasks", { t: table.id });
    if (error) { setClearedAt(before); return didNotTake("The finished work was not cleared. Try again."); }
    if (data) setClearedAt(data as string);
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

  // Model choices show at once, and go back if the table did not keep them.
  async function setTableModelKept(model: string) {
    const before = tableModel;
    setTableModel(model || null);
    const { error } = await supabase.rpc("set_table_model", { t: table.id, model });
    if (error) { setTableModel(before); didNotTake("The table's model was not changed. Try again."); }
  }
  async function setModelKept(conn: string, model: string) {
    const before = connections.find((c) => c.id === conn)?.model_choice ?? null;
    setConnections((prev) => prev.map((c) => (c.id === conn ? { ...c, model_choice: model || null } : c)));
    const { error } = await supabase.rpc("set_model", { conn, model });
    if (error) {
      setConnections((prev) => prev.map((c) => (c.id === conn ? { ...c, model_choice: before } : c)));
      didNotTake("The model was not changed. Try again.");
    }
  }
  // Stopping work says so when it did not stop.
  function stopJob(id: string) {
    supabase.rpc("stop_job", { job: id }).then(({ error }: { error: unknown }) => { if (error) didNotTake("That work was not stopped. Try again."); catchUp(); });
  }

  // A test client: a pretend client seat the owner adds to try the client's side for real, and takes off again.
  const testClient = clients.find((c) => c.test);
  const addTest = async () => {
    const { data: id, error } = await supabase.rpc("add_test_client", { t: table.id });
    if (error || !id) return didNotTake(error?.message || "The test client was not added. Try again.");
    const { data: row } = await supabase.from("members").select(MEMBER_COLUMNS).eq("id", id as string).maybeSingle();
    if (row) setMembers((prev) => (prev.some((m) => m.id === id) ? prev : [...prev, row as unknown as Member]));
    setClientId(id as string);
  };
  const removeTest = async () => {
    // What was attached as the test client goes from storage first: removing the seat used to leave the files behind.
    if (testClient) {
      const { data: files } = await supabase.from("attachments").select("path").eq("table_id", table.id).eq("member_id", testClient.id);
      const paths = ((files ?? []) as { path: string }[]).map((f) => f.path);
      if (paths.length) await supabase.storage.from("attachments").remove(paths);
    }
    const { error } = await supabase.rpc("remove_test_client", { t: table.id });
    if (error) return didNotTake("The test client was not removed. Try again.");
    setMembers((prev) => prev.filter((m) => !m.test));
    setClientId(null);
  };

  // The client's own page, whole, in place of the room. A real client's is looked at, never used; the test client's
  // is used by the owner as if they were the client.
  if (view === "client" && !gone) {
    const seen = clients.find((c) => c.id === clientId) ?? client;
    if (seen) {
      return (
        <>
        {failed && <div className={styles.toast} role="alert" data-testid="did-not-take">{failed}</div>}
        <ClientPage key={seen.id} table={{ id: table.id, name: tableName }} me={{ id: seen.id, display_name: seen.display_name, color: seen.color }}
          initialRequests={requests.filter((r) => r.member_id === seen.id)} initialEvents={[]} initialUpdates={[]} initialLines={[]}
          initialConnections={connections.filter((c) => c.member_id === seen.id && !c.revoked_at)} initialJobs={[]}
          viewer={{ onBack: goHome, others: clients, onPick: setClientId, acting: !!seen.test && self.role === "owner", uploader: self.id,
            onTest: self.role === "owner" && !testClient ? addTest : undefined, onRemoveTest: seen.test && self.role === "owner" ? removeTest : undefined }} />
        </>
      );
    }
    return (
      <main className={`page-center ${styles.noClient}`} data-testid="client-view">
        {failed && <div className={styles.toast} role="alert" data-testid="did-not-take">{failed}</div>}
        <div className="panel" style={{ alignItems: "center", textAlign: "center" }}>
          <Mark size={48} />
          <h1>No client is at this table yet</h1>
          <div style={{ display: "flex", gap: 8 }}>
            {self.role === "owner" && <button className="btn" onClick={addTest} data-testid="add-test-client">Try it as a test client</button>}
            {self.role === "owner" && <button className="btn btn-quiet" onClick={() => { goHome(); setInviting(true); }}>Invite the client</button>}
            <button className="btn btn-quiet" onClick={goHome} data-testid="table-portal">Back to the table</button>
          </div>
        </div>
      </main>
    );
  }

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
    <div className={`${styles.shell} ${noSide ? styles.shellWide : ""}`} data-live={live || undefined}>
      <header className={styles.header}>
        <button className={styles.menuToggle} aria-label="Menu" aria-expanded={drawerOpen} onClick={() => { setDrawerOpen(!drawerOpen); setInboxOpen(false); }}>
          <span /><span /><span />
        </button>
        <button className={`${styles.brand} ${view === "table" ? styles.brandOn : ""}`} onClick={goHome} aria-current={view === "table" ? "page" : undefined} data-testid="home"><Mark size={26} /> Longtable</button>
        <div className={styles.divider} />
        <div className={styles.project}>{tableName}</div>
        <div className={styles.spacer} />
        <div className={styles.faces} title={`${here.length} here now`}>
          {here.filter((m) => m.id !== me.id).map((m) => (
            <div key={m.id} className={styles.face} style={{ background: m.color }} title={m.display_name}><Face who={m} /></div>
          ))}
        </div>
        {/* One plain way to the client's side, there whenever a client is at the table. */}
        {(clients.length > 0 || self.role === "owner") && <button className={`btn btn-quiet ${styles.clientSide}`} onClick={() => go("client", `${base}?side=client`)} data-testid="client-portal">Client side</button>}
        {!noSide && <button className={`btn btn-quiet ${styles.inboxToggle}`} onClick={() => { setInboxOpen(!inboxOpen); setDrawerOpen(false); }}>
          {view === "table" ? "Usage" : "Work"}
        </button>}
        <ProfileMenu me={self} tableId={table.id} onInvite={self.role === "owner" ? () => setInviting(true) : undefined}
          onMe={() => openPerson(me.id, true)} onSettings={() => go("settings", `${base}/settings`)} onLogs={() => go("logs", `${base}/activity`)}
          ai={myConnection?.kind ?? null} onConnect={() => setConnectOpen(true)} onDisconnect={() => myConnection && disconnect(myConnection.id)} />
      </header>

      <div className={`${styles.grid} ${noSide ? styles.gridWide : ""}`}>
        {drawerOpen && <button className={styles.drawerBack} aria-label="Close the menu" onClick={() => setDrawerOpen(false)} />}
        <aside className={`${styles.aside} ${drawerOpen ? styles.asideOpen : ""}`} aria-label="Menu">
          <div className={styles.drawerProject}>{tableName}</div>
          <ChatList chats={chats} activeId={view === "chat" ? chat?.id ?? null : null}
            waiting={new Set(decisions.filter((d) => d.status === "open").map((d) => d.chat_id))}
            canDelete={(c) => !c.is_general && (self.role === "owner" || c.created_by === me.id)}
            onOpen={openChat} onCreate={makeChat} onRename={renameChat} onDelete={deleteChat} />
          {/* Handouts: what the AIs made for the table to look at. Its own section, there only once there is one. */}
          {pages.length > 0 && (
            <div className={`${styles.section} ${styles.handouts}`} data-testid="handouts">
              <div className={styles.sectionHead}>
                <div className={styles.sectionTitle}>Handouts</div>
                {pages.length > 4 && <button className={styles.sectionMore} onClick={() => setPagesOpen(true)} data-testid="pages-link">All {pages.length}</button>}
              </div>
              {[...pages].sort((a, b) => Number(pins.has(b.id)) - Number(pins.has(a.id)) || b.touched_at.localeCompare(a.touched_at)).slice(0, 4).map((p, i) => (
                <button key={p.id} className={`${styles.chat} ${styles.handout} ${openPage === p.id ? styles.chatActive : ""}`} style={{ "--i": i } as React.CSSProperties}
                  onClick={() => { setOpenPage(p.id); setDrawerOpen(false); }} title={p.about || p.title}>
                  <span className={styles.handoutIcon}><PageIcon icon={p.icon} size={15} /></span>
                  <span className={styles.handoutName}>{p.title}</span>
                </button>
              ))}
            </div>
          )}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>People</div>
            {/* The people working first, then a quiet line, then the clients. */}
            {[...members.filter((m) => m.role !== "client"), ...clients].map((m, i, all) => (
              <Fragment key={m.id}>
              {m.role === "client" && i > 0 && all[i - 1].role !== "client" && <div className={styles.peopleRule} role="separator" data-testid="people-rule" />}
              <button className={`${styles.person} ${styles.personButton} ${personId === m.id ? styles.personOn : ""}`}
                data-here={online.has(m.id)} data-member={m.display_name} onClick={() => openPerson(m.id)}>
                <div className={styles.avatar} style={{ background: m.color }}>
                  <Face who={m} />
                  {m.role === "owner" && <span className={styles.crown}><Crown size={16} /></span>}
                </div>
                <div className={styles.personText}>
                  <div className={styles.personName} style={{ color: m.name_color || undefined }}>{m.display_name}</div>
                  {(() => {
                    const ai = m.role === "client" ? null : aiState(m.id);
                    const words = [ai ? `${ai.word} ${ai.on ? "connected" : "disconnected"}` : m.test ? "Not a real person" : m.role === "client" ? "Client" : "", m.status].filter(Boolean).join(" · ");
                    return words ? <div className={styles.personMeta} data-ai={ai ? (ai.on ? "on" : "off") : undefined}>{ai && <i className={`${styles.aiDot} ${ai.on ? styles.aiDotOn : ""}`} />}{words}</div> : null;
                  })()}
                </div>
              </button>
              </Fragment>
            ))}
          </div>
          {/* On a phone the top bar has no room, so the same button lives in the menu. */}
          {(clients.length > 0 || self.role === "owner") && <button className={`btn btn-quiet ${styles.clientSideMenu}`} onClick={() => { setDrawerOpen(false); go("client", `${base}?side=client`); }}>Client side</button>}
          <BugButton tableId={table.id} place={view} />
          <ApprovalCards items={approvals} ai={myConnection?.kind === "codex" ? "ChatGPT" : "Claude"}
            onAnswer={async (a, allow, always) => {
              setApprovals((prev) => prev.filter((x) => x.id !== a.id));
              const { error } = await supabase.rpc("decide_approval", { a: a.id, allow, always_allow: always });
              if (error) { didNotTake("That answer did not reach your Claude. Try again."); readApprovals(); }
            }} />
        </aside>

        {view === "table" && (
          <main className={`${styles.main} ${styles.stage}`}>
            <TableView table={{ id: table.id, name: tableName }} me={self} members={members} connections={connections} jobs={jobs} online={online} messages={messages}
              chats={chats} onOpenChat={openChat} onConnect={() => setConnectOpen(true)}
              tableModel={tableModel}
              onTableModel={(model) => setTableModelKept(model)}
              onModel={(conn, model) => setModelKept(conn, model)} onInvite={self.role === "owner" ? () => setInviting(true) : undefined}
              onPerson={(id) => openPerson(id)} onAi={setAiOf} onTable={() => setTableOpen(true)} />
          </main>
        )}
        {view === "sandbox" && sandboxOf && byId.get(sandboxOf) && (
          <main className={styles.main}>
            <SandboxReview table={{ id: table.id, name: tableName }} me={self} client={byId.get(sandboxOf)!} box={boxes.current.get(sandboxOf) ?? null}
              aiOn={connections.some((c) => !c.revoked_at && c.kind === "claude" && byId.get(c.member_id)?.role !== "client" && !!c.last_seen && Date.now() - new Date(c.last_seen).getTime() < 90000)}
              changes={changes} jobs={jobs} onStop={stopJob} links={links} onLinks={setLinks}
              onBox={(b) => { boxes.current.set(b.member_id, { ...(boxes.current.get(b.member_id) ?? { member_id: b.member_id, mode: "chat", branch: "", url: null }), ...b }); setMembers((prev) => [...prev]); }}
              onOpenTask={(taskId) => { const t = tasks.find((x) => x.id === taskId); if (t) openChat(t.chat_id); else goHome(); }} />
          </main>
        )}
        {(view === "settings" || view === "logs") && (
          <main className={styles.main}>
            <div className={styles.setPage} data-testid="settings-page">
              <div className={styles.setHead}>
                <h1 className={styles.setTitle}>{self.role === "owner" ? "Settings" : "Logs"}</h1>
                {self.role === "owner" && (
                  <div className={styles.seg} role="tablist">
                    <button role="tab" aria-selected={view === "settings"} className={view === "settings" ? styles.segOn : ""} onClick={() => go("settings", `${base}/settings`)}>The table</button>
                    <button role="tab" aria-selected={view === "logs"} className={view === "logs" ? styles.segOn : ""} onClick={() => go("logs", `${base}/activity`)}>Logs</button>
                  </div>
                )}
              </div>
              {view === "settings" && self.role === "owner"
                ? <SettingsForm table={{ id: table.id, name: tableName }} me={me.id} people={members} chats={chats} data={settings} onData={setSettings}
                    onRenamed={setTableName} onRemoved={(id) => setMembers((prev) => prev.filter((m) => m.id !== id))} />
                : <LogsPanel table={table} members={members} />}
            </div>
          </main>
        )}
        <main className={styles.main} hidden={view !== "chat"}>
          <div ref={scrollRef} className={styles.scroll} onScroll={onScroll} data-testid="messages">
            <div className={styles.list}>
              {items.length === 0 && (
                <div className={styles.empty}>
                  <div className={styles.emptyTitle}>{`Nothing in ${chat?.name ?? "this chat"} yet`}</div>
                </div>
              )}
              {items.map((it, at) => {
                const { follows, held } = runs[at] ?? { follows: false, held: false };
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
                  return (
                    <div key={m.id} className={`${styles.clientSay} ${follows ? styles.follow : ""} ${held ? styles.held : ""}`} data-mid={m.id} data-request={m.meta?.request ?? ""} data-follows={follows || undefined}>
                      {!follows && <div className={styles.sayName} style={{ color: who?.name_color || undefined }}>{name} <span className={styles.clientTag}>client</span></div>}
                      {m.meta?.answers && m.meta.question && <div className={styles.questionQuote}>Answering: {m.meta.question}</div>}
                      <div className={styles.clientRow}>
                        <div className={`${styles.messageAvatar} ${follows ? styles.unseen : ""}`} style={{ background: who?.color ?? "var(--faint)" }} aria-hidden={follows || undefined}><Face who={who} name={name} /></div>
                        <div className={styles.bubble} data-bubble={who?.bubble ?? "stone"}>{m.body}</div>
                      </div>
                      {m.meta?.files?.length ? <div className={styles.clientFiles}><Files supabase={supabase} files={m.meta.files} /></div> : null}
                      <div className={styles.clientTools}>
                        <span className={styles.sayWhen}><Time iso={m.created_at} /></span>
                      </div>
                    </div>
                  );
                }
                if (m.by_ai) {
                  return <Answer key={m.id} m={m} members={byId} views={m.meta?.round ? viewsByRound.get(m.meta.round) ?? [] : []} follows={follows}
                    pages={m.meta?.job ? pages.filter((p) => p.job_id === m.meta?.job || pageVersions.some((v) => v.page_id === p.id && v.job_id === m.meta?.job)) : []}
                    onOpenPage={setOpenPage}
                    again={m.kind === "intro" && items.some((o) => o.kind !== "decision" && o.m.kind === "intro" && o.m.member_id === m.member_id && o.m.created_at < m.created_at)} />;
                }
                const mine = m.member_id === me.id;
                return (
                  <div key={m.id} className={`${styles.say} ${mine ? styles.sayMine : ""} ${m.state === "sending" ? styles.pending : ""} ${follows ? styles.follow : ""} ${held ? styles.held : ""}`} data-mid={m.id} data-follows={follows || undefined}>
                    {!mine && (
                      <div className={`${styles.messageAvatar} ${follows ? styles.unseen : ""}`} style={{ background: who?.color ?? "var(--faint)" }} aria-hidden={follows || undefined}><Face who={who} name={name} /></div>
                    )}
                    <div className={styles.sayCol}>
                      {!mine && !follows && <div className={styles.sayName} style={{ color: who?.name_color || undefined }}>{name}</div>}
                      <div className={styles.bubble} data-bubble={who?.bubble ?? "stone"}><Inline text={m.body} /></div>
                      {m.meta?.files?.length ? <div className={styles.sayFiles}><Files supabase={supabase} files={m.meta.files} /></div> : null}
                      <div className={styles.sayWhen}>
                        {m.state === "failed" ? <span className={styles.failed}>Not sent</span> : <Time iso={m.created_at} />}
                      </div>
                    </div>
                  </div>
                );
              })}
              {working.filter((j) => j.kind !== "listen" && (j.status !== "failed" || Date.now() - new Date(j.created_at).getTime() < 15 * 60 * 1000)).map((j) => {
                // Long work says what it is on and for how long, and anyone on the team can stop it.
                const mins = j.status === "running" && j.started_at ? Math.floor((Date.now() - new Date(j.started_at).getTime()) / 60000) : 0;
                const doing = j.status === "running" && (j.kind === "work" || j.kind === "answer") ? `${j.progress ? `, ${j.progress}` : ""}${mins >= 1 ? ` · ${elapsed(mins)}` : ""}` : "";
                const stoppable = j.status !== "failed" && (j.kind === "work" || j.kind === "answer" || j.kind === "look");
                const name = `${byId.get(j.member_id)?.display_name ?? "Someone"}'s ${aiWord(j.member_id)}`;
                const text = j.status === "failed" ? `${name} couldn't finish: ${j.error ?? "it gave up"}`
                  : j.kind === "combine" ? (j.status === "waiting" ? `${name} writes the answer once the views are in` : `${name} is writing the answer…`)
                  : j.kind === "work" ? (j.status === "waiting" ? `${name} starts once the others have had their say` : j.status === "queued" ? `${name} has this next` : (j.stage ?? 0) > 0 ? `${name} is fixing what the others found…` : `${name} is doing the work…`)
                  : j.kind === "review" ? (j.status === "running" ? `${name} is looking it over…` : `Waiting for ${name} to look it over`)
                  : j.kind === "view" ? (j.status === "running" ? `${name} is giving its view…` : `Waiting for ${name}'s view`)
                  : j.kind === "intro" ? `${name} is reading the project…`
                  : j.kind === "answer" && j.status === "running" ? `${name} is on it…`
                  : j.status === "running" ? `${name} is reading the code…` : `Waiting for ${name}`;
                return (
                  <div key={j.id} className={`${styles.working} ${j.status === "failed" ? styles.workingFailed : ""}`} data-testid="working">
                    {j.status !== "failed" && <span className={styles.workingDot} />}{text.replace(/…$/, doing ? "" : "…")}{doing}
                    {stoppable && <button type="button" className={styles.toolLink} data-testid="stop-job" onClick={() => stopJob(j.id)}>Stop</button>}
                  </div>
                );
              })}
            </div>
          </div>

          <div className={styles.composerWrap} {...dropHandlers(attach)}>
            <AttachTray a={attach} />
            {slash.length > 0 && (
              <div className={styles.slash} role="listbox" aria-label={`Your ${aiWord(me.id)}'s own commands`} data-testid="slash-menu">
                {slash.map((c, i) => (
                  <Fragment key={c.name}>
                    {i === slashBuiltAt && i > 0 && <div className={styles.slashHead} role="presentation">Built in</div>}
                    {i === slashOwnAt && i > 0 && <div className={styles.slashHead} role="presentation">Claude Code&apos;s own</div>}
                    <button type="button" role="option" aria-selected={i === slashIndex} className={`${styles.slashItem} ${i === slashIndex ? styles.slashOn : ""}`} style={{ "--i": i } as React.CSSProperties}
                      ref={i === slashIndex ? (el) => { el?.scrollIntoView({ block: "nearest" }); } : undefined}
                      onMouseMove={() => { if (i !== slashIndex) setSlashAt(i); }} onMouseDown={(e) => { e.preventDefault(); pickSlash(c.name); }}>
                      <b>/{c.name}</b><span>{c.about || (c.kind === "builtin" ? "Built in" : c.kind === "skill" ? "A skill of yours" : "A command of yours")}</span>
                    </button>
                  </Fragment>
                ))}
              </div>
            )}
            <form className={styles.composer} onSubmit={(e) => { e.preventDefault(); send(); }}>
              <textarea
                ref={inputRef}
                className={styles.input}
                rows={1}
                maxLength={8000}
                value={draft}
                placeholder={`Message ${chat?.name ?? "the table"}`}
                aria-label="Message the table"
                onChange={(e) => { setDraft(e.target.value); setSlashAt(0); grow(); }}
                onKeyDown={(e) => {
                  // With the list of their own commands open, the arrows move through it and Enter or Tab takes one.
                  if (slash.length > 0) {
                    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); return setSlashAt((slashIndex + (e.key === "ArrowDown" ? 1 : slash.length - 1)) % slash.length); }
                    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") { e.preventDefault(); return pickSlash(slash[slashIndex].name); }
                    if (e.key === "Escape") { e.preventDefault(); return setDraft(""); }
                  }
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (e.ctrlKey || e.metaKey) askTable();
                    else send();
                  }
                }}
              />
              <AttachButtons a={attach} />
              <button className="btn" disabled={(!draft.trim() && attach.pending.length === 0) || attach.busy || attach.recording}>Send</button>
            </form>
            <div className={styles.composerTools}>
              <button className={styles.toolLink} onClick={() => { setAskingFor(null); setAsking(true); }}>Make a poll</button>
              {notice && <span className={styles.notice} role="status">{notice}</span>}
              {/* When this person's own AI cannot answer here, say why, with the one fix. */}
              {!notice && self.role !== "client" && (() => {
                if (!myConnection) return <span className={styles.notice} data-testid="ai-status">Your AI is not connected. <button className={styles.toolLink} onClick={() => setConnectOpen(true)}>Connect your AI</button></span>;
                const quiet = !myConnection.last_seen || Date.now() - new Date(myConnection.last_seen).getTime() > 90000;
                return quiet ? <span className={styles.notice} data-testid="ai-status">Your computer&apos;s connection is off. It rejoins by itself once your computer is awake.</span> : null;
              })()}
            </div>
          </div>
        </main>

        {view === "settings" || view === "logs" || view === "sandbox" ? null : view === "table" ? (
          <aside className={`${styles.inbox} ${inboxOpen ? styles.inboxOpen : ""}`} aria-label="Usage">
            <div className={styles.inboxHead}><div className={styles.inboxTitle}>Usage</div></div>
            <div className={styles.inboxList}>
              <UsagePanel members={members} connections={connections} />
            </div>
          </aside>
        ) : (
          <WorkPanel review={toReview.map((x) => ({ id: x.m.id, name: firstName(x.m.display_name), n: x.n }))} onReview={openSandbox} tasks={shownTasks} jobs={jobs} members={byId} aiWord={aiWord} open={inboxOpen}
            onOpenChat={(id) => openChat(id)} onClear={clearTasks}
            onStop={stopJob} />
        )}
      </div>

      {personId && byId.get(personId) && (
        <PersonWindow table={{ id: table.id, name: tableName }} me={self} person={byId.get(personId)!} connections={connections} here={online.has(personId)} edit={editingMe && personId === me.id} members={members}
          onClose={() => setPersonId(null)}
          onSaved={(m) => setMembers((prev) => prev.map((x) => (x.id === m.id ? { ...x, ...m } : x)))}
          onGone={(id) => setMembers((prev) => prev.filter((x) => x.id !== id))} onSandbox={openSandbox}
          waiting={changes.filter((c) => c.member_id === personId && c.status === "ready" && !c.verdict && !c.test).length} />
      )}
      {inviting && <Invite tableId={table.id} onClose={() => setInviting(false)} />}
      {pagesOpen && <PagesList pages={pages} pins={pins} members={byId} onClose={() => setPagesOpen(false)} onOpen={(id) => { setPagesOpen(false); setOpenPage(id); }} />}
      {openPage && pages.some((p) => p.id === openPage) && (
        <PageWindow supabase={supabase} page={pages.find((p) => p.id === openPage)!} me={self} owner={self.role === "owner"} members={byId}
          versions={pageVersions.filter((v) => v.page_id === openPage)} comments={pageComments.filter((c) => c.page_id === openPage).sort((a, b) => a.created_at.localeCompare(b.created_at))}
          values={pageValues.filter((v) => v.page_id === openPage)} pinned={pins.has(openPage)} viewers={viewing.get(openPage) ?? []}
          onClose={() => setOpenPage(null)} onFailed={(msg) => { didNotTake(msg); readPages(); }}
          onPinned={(on) => setPins((prev) => { const next = new Set(prev); if (on) next.add(openPage); else next.delete(openPage); return next; })} />
      )}
      {aiOf && byId.get(aiOf) && (() => {
        const all = connections.filter((c) => c.member_id === aiOf);
        const conn = all.find((c) => !c.revoked_at) ?? [...all].sort((a, b) => (b.revoked_at ?? "").localeCompare(a.revoked_at ?? ""))[0] ?? null;
        const on = !!conn && !conn.revoked_at && !!conn.last_seen && Date.now() - new Date(conn.last_seen).getTime() < 75000;
        return (
          <AiWindow me={self} person={byId.get(aiOf)!} conn={conn} commands={aiOf === me.id ? myCommands : []} on={on} busy={on && jobs.some((j) => j.member_id === aiOf && (j.status === "running" || j.status === "queued"))}
            onClose={() => setAiOf(null)} onConnect={() => setConnectOpen(true)} onDisconnect={disconnect}
            onModel={(id, model) => setModelKept(id, model)}
            onSpeed={(id, patch) => { setSpeed(id, patch); }}
            onOptions={async (id, patch) => {
              const before = connections.find((c) => c.id === id);
              setConnections((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
              const { error } = patch.full_claude !== undefined
                ? await supabase.rpc("set_full_claude", { conn: id, full_on: patch.full_claude })
                : await supabase.rpc("set_connection_options", { conn: id, open: patch.open_paths ?? null, share: patch.share_paths ?? null });
              if (error && before) {
                setConnections((prev) => prev.map((c) => (c.id === id ? { ...c, open_paths: before.open_paths, share_paths: before.share_paths, full_claude: before.full_claude } : c)));
                didNotTake("That switch was not changed. Try again.");
              }
            }} />
        );
      })()}
      {tableOpen && (() => {
        const onNow = connections.filter((c) => !c.revoked_at && !!c.last_seen && Date.now() - new Date(c.last_seen).getTime() < 75000 && byId.get(c.member_id)?.role !== "client");
        const w = onNow.find((c) => byId.get(c.member_id)?.role === "owner") ?? onNow[0];
        return (
          <TableWindow me={self} tableName={tableName} writer={w && byId.get(w.member_id) ? { person: byId.get(w.member_id)!, conn: w } : null}
            tableModel={tableModel} people={members.filter((m) => m.role !== "client").length} aisOn={onNow.length}
            onTableModel={(model) => setTableModelKept(model)}
            onSettings={self.role === "owner" ? () => go("settings", `${base}/settings`) : undefined} onClose={() => setTableOpen(false)} />
        );
      })()}
      {failed && <div className={styles.toast} role="alert" data-testid="did-not-take">{failed}</div>}
      {connectOpen && (
        <ConnectModal tableId={table.id} tableName={tableName} connected={myConnection?.kind ?? null} onClose={() => setConnectOpen(false)} />
      )}
      {asking && chat && (
        <NewDecision
          chatId={chat.id}
          myName={me.display_name}
          clientName={clientName}
          hasClient={!!client}
          request={askingFor ? { id: askingFor.id, title: askingFor.title, body: askingFor.body, who: byId.get(askingFor.member_id)?.display_name ?? clientName } : null}
          requests={requests.filter((r) => r.status === "asked" || r.status === "answered").map((r) => ({ id: r.id, title: r.title, body: r.body, who: byId.get(r.member_id)?.display_name ?? clientName }))}
          onClose={() => { setAsking(false); setAskingFor(null); }}
        />
      )}
    </div>
  );
}
