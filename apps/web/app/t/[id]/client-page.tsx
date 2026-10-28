"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { AI_NAME, AiLogo } from "@/components/ai-logo";
import { Arrow } from "@/components/icons";
import { Mark, WorkingMark } from "@/components/mark";
import { downloadExport } from "@/lib/download";
import { Prose } from "@/lib/inline";
import { browserClient } from "@/lib/supabase/browser";
import { ConnectModal } from "./connect-modal";
import {
  CONNECTION_COLUMNS, JOB_COLUMNS, LINE_COLUMNS, REQUEST_COLUMNS, UPDATE_COLUMNS,
  type ClientLine, type ClientUpdate, type Connection, type Job, type Request, type RequestEvent,
} from "./types";
import { ProfileMenu } from "./profile-menu";
import { AttachButtons, AttachTray, Files, dropHandlers, useAttach } from "./attach";
import room from "./room.module.css";
import styles from "./client.module.css";
import { firstName } from "@/lib/names";
import { ClientPanel, ClientWelcome, type Overview } from "./client-panel";


// A change in the client's own copy, as their page is given it: their words, where it stands, what they were told in
// plain words, and what the team made of it. Nothing of the team's part.
type Change = { id: string; words: string; status: "working" | "ready" | "nothing" | "passed" | "failed" | "stopped"; summary: string | null;
  verdict: "take" | "differently" | "no" | null; note: string | null; request_id: string | null; created_at: string; finished_at: string | null;
  undone?: "undoing" | "undone" | "stuck" | null; did_not_build?: boolean };
// building: their newest change is not online yet; broken: it did not build, so the copy shows the version before it.
type Sandbox = { on: boolean; url: string | null; left: number | null; changes: Change[]; building?: boolean; broken?: boolean; behind?: boolean };
const VERDICT = { take: "The team is building this into the real thing.", differently: "The team will do this, in a different way.", no: "The team decided against this one." } as const;

const byTime = <T extends { created_at: string }>(a: T, b: T) => a.created_at.localeCompare(b.created_at);
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
  // acting: the owner is using the table's test client, so the page works; otherwise a viewer only looks.
  viewer?: { onBack: () => void; others?: { id: string; display_name: string }[]; onPick?: (id: string) => void; preview?: boolean; acting?: boolean; uploader?: string; onTest?: () => void; onRemoveTest?: () => void };
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
  // What is typed in the box survives a refresh (after an update, or any other), kept only in this tab.
  useEffect(() => { try { const kept = sessionStorage.getItem(`lt-draft:${table.id}:client`); if (kept) setDraft((d) => d || kept); } catch {} }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { try { if (draft) sessionStorage.setItem(`lt-draft:${table.id}:client`, draft); else sessionStorage.removeItem(`lt-draft:${table.id}:client`); } catch {} }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps
  // What they attach goes into the folder of whoever is really signed in: themselves, or the owner trying their side.
  const attach = useAttach(supabase, table.id, viewer?.uploader ?? me.id);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ body: string; at: string } | null>(null);
  const [error, setError] = useState("");
  const [gone, setGone] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const putRequest = useCallback((r: Request) => setRequests((prev) => put(prev, [r])), []);
  const putUpdates = useCallback((list: ClientUpdate[]) => setUpdates((prev) => put(prev, list)), []);
  const putLines = useCallback((list: ClientLine[]) => setLines((prev) => put(prev, list)), []);

  // Everything again from the database: covers the moment between the page loading and the channels opening,
  // and anything missed while a laptop slept.
  // Beside the conversation: their team, their requests and where each stands, and what is being built.
  const [overview, setOverview] = useState<Overview | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  // Nothing stands in for the page before its first read: a placeholder line used to flash and then be swapped for the
  // welcome.
  const [ready, setReady] = useState(false);
  const readOverview = useCallback(async () => {
    if (viewer && !viewer.acting) return;
    const { data, error } = await supabase.rpc("client_overview", { t: table.id });
    if (error) console.warn("[client] overview could not be read:", error.code);
    else setOverview(data as Overview);
  }, [supabase, table.id, !!viewer, !!viewer?.acting]);
  const reload = useCallback(async () => {
    const overviewRead = readOverview();
    const { data: still, error: stillError } = await supabase.from("members").select("id").eq("id", me.id).is("removed_at", null).maybeSingle();
    if (!stillError && !still && !viewer) { setGone(true); return; }
    const [{ data: r }, { data: up }, { data: ln }, { data: cn }, { data: jb }] = await Promise.all([
      supabase.from("requests").select(REQUEST_COLUMNS).eq("table_id", table.id).eq("member_id", me.id),
      supabase.from("client_updates").select(UPDATE_COLUMNS).eq("table_id", table.id),
      supabase.from("client_lines").select(LINE_COLUMNS).eq("table_id", table.id).eq("member_id", me.id).order("created_at", { ascending: false }).limit(200),
      // Ones that were disconnected too: what their assistant said before still shows as that assistant.
      supabase.from("connections").select(CONNECTION_COLUMNS).eq("table_id", table.id).eq("member_id", me.id).order("created_at", { ascending: false }).limit(10),
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
    // Someone of the team looking on reads the copy directly; the owner acting as the test client reads it as a client does.
    if (viewer && !viewer.acting) {
      const [{ data: ch }, { data: box }] = await Promise.all([
        supabase.from("sandbox_changes").select("id, words, status, summary, verdict, note, request_id, created_at, finished_at, undone").eq("member_id", me.id).eq("test", false).order("created_at", { ascending: false }).limit(60),
        supabase.from("sandboxes").select("mode, url").eq("member_id", me.id).maybeSingle(),
      ]);
      const b = box as { mode?: string; url?: string | null } | null;
      if (ch) setSandbox({ on: b?.mode === "sandbox", url: b?.url ?? null, left: null, changes: ch as Change[] });
    } else {
      const { data: sb } = await supabase.rpc("client_sandbox", { t: table.id });
      if (sb) setSandbox(sb as Sandbox);
    }
    await overviewRead;
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, table.id, me.id, putUpdates, putLines, !!viewer, !!viewer?.acting, readOverview]);

  // Read the database as soon as the page opens. It used to wait for its live channel to say it was ready, so with
  // live updates blocked (a strict network) a copy's button and cards could be missing for up to a minute.
  useEffect(() => {
    if (!viewer) reload();
    // Opening the page brings their copy up to what the team has shipped (at most hourly, and only with a copy).
    if (!viewer || viewer.acting) supabase.rpc("client_refresh_copy", { t: table.id }).then(({ error }: { error: { message: string } | null }) => { if (error) console.warn(`Their copy was not brought up to date: ${error.message}`); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A viewer has no place on the client's own channels: the page just reads again every few seconds.
  useEffect(() => {
    if (!viewer) return;
    reload();
    const t = setInterval(() => { if (document.visibilityState === "visible") reload(); }, viewer.preview ? 30000 : viewer.acting ? 3000 : 8000);
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
  // Which AI their assistant is, or was: the one connected now, else the last one they had.
  const theirs = mine?.kind ?? [...connections].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]?.kind ?? null;
  // Their own assistant's job is theirs to see. When the team's AI is answering, the sign is their own last words
  // still waiting: sent to it, not yet answered, not yet passed on, and not long ago.
  const lastLine = lines.length ? [...lines].sort(byTime)[lines.length - 1] : null;
  // Their last words with no answer yet: the answer is forming. Waiting words wait for a team AI to come on.
  const waitingOn = !!lastLine && lastLine.who === "client" && !!lastLine.by_table && !!lastLine.waiting;
  const deskBusy = !!lastLine && lastLine.who === "client" && !!lastLine.by_table && (waitingOn || (!lastLine.request_id && Date.now() - new Date(lastLine.created_at).getTime() < 300000));
  const open = jobs.filter((j) => j.kind === "client" && (j.status === "queued" || j.status === "running"));
  const thinking = !!sent || deskBusy || open.length > 0;
  // How far along: a deeper look means the table asked one of the team's AIs, which reads the project.
  const stage = open.some((j) => (j as { stage?: number }).stage === 1) ? 1 : 0;
  const building = !!sandbox?.changes.some((c) => c.status === "working" || c.undone === "undoing") || !!sandbox?.building;
  // The one change they can take back: their newest that is still in the copy.
  const undoable = sandbox?.on ? [...(sandbox.changes || [])].filter((c) => c.status === "ready" && !c.undone).sort(byTime).pop()?.id : undefined;
  const newestReady = [...(sandbox?.changes || [])].filter((c) => c.status === "ready").sort(byTime).pop()?.id;

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
    | { kind: "told"; id: string; created_at: string; r: Request; u: ClientUpdate }
    | { kind: "line"; id: string; created_at: string; me: boolean; own: boolean; desk?: boolean; text: string; question?: ClientUpdate };
  // What they just sent shows at once, and the answer starts forming under it, before the server has said a word.
  const feed = useMemo(() => {
    const passed = new Set((sandbox?.changes ?? []).map((c) => c.request_id).filter(Boolean));
    const items: Item[] = [
      // A request that came out of a change in their copy is told under that change, not twice.
      ...requests.filter((r) => !passed.has(r.id)).map((r): Item => ({ kind: "request", id: `r-${r.id}`, created_at: r.created_at, r })),
      // What the team said about a request sits at the time it was said, so the conversation reads in order.
      ...requests.filter((r) => !passed.has(r.id)).flatMap((r) => updates.filter((u) => u.request_id === r.id && !isAck(u))
        .map((u): Item => ({ kind: "told", id: `t-${u.id}`, created_at: u.created_at, r, u }))),
      ...(sandbox?.changes ?? []).map((c): Item => ({ kind: "change", id: `c-${c.id}`, created_at: c.created_at, c })),
      // Their own words to their assistant show as a line unless they became a request, which carries them.
      ...lines.filter((l) => !(l.who === "client" && l.request_id)).map((l): Item => ({ kind: "line", id: `l-${l.id}`, created_at: l.created_at, me: l.who === "client", own: true, desk: !!l.by_table, text: l.body })),
      // What every client was told, with no request of theirs behind it.
      ...updates.filter((u) => !u.request_id).map((u): Item => ({ kind: "line", id: `u-${u.id}`, created_at: u.created_at, me: false, own: false, text: u.body, question: u.replies?.length ? u : undefined })),
    ];
    if (sent) items.push({ kind: "line", id: "sent", created_at: sent.at, me: true, own: true, desk: true, text: sent.body });
    return items.sort(byTime);
  }, [requests, lines, updates, sandbox, sent]);
  const told = (requestId: string) => updates.filter((u) => u.request_id === requestId && !isAck(u)).sort(byTime);

  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [feed.length, thinking, building]);

  // A reply that grows after it lands (the forming line, then the words) keeps the bottom in view, unless they scrolled up.
  useEffect(() => {
    const el = chatRef.current;
    const inner = el?.firstElementChild;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    let near = true;
    const onScroll = () => { near = el.scrollHeight - el.scrollTop - el.clientHeight < 120; };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => { if (near) el.scrollTop = el.scrollHeight; });
    ro.observe(inner);
    return () => { ro.disconnect(); el.removeEventListener("scroll", onScroll); };
  }, [ready]);

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

  // Their newest change, taken back out of their copy. It shows as being taken back at once; the database decides.
  async function undo() {
    setError("");
    const { error } = await supabase.rpc("client_undo_change", { t: table.id });
    if (error) setError(sentence(error.message));
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
  async function say(words?: string) {
    const body = (words ?? draft).trim();
    if ((!body && !attach.pending.length) || busy || attach.busy) return;
    setBusy(true);
    setError("");
    const files = await attach.upload();
    if (!files) return setBusy(false);
    if (body) { setSent({ body, at: new Date().toISOString() }); setDraft(""); requestAnimationFrame(grow); }
    const { data, error } = await supabase.rpc("client_say", { t: table.id, body, files });
    setBusy(false);
    if (error) {
      setSent(null);
      setDraft(body);
      // What was uploaded for a message that was refused is not left in storage.
      if (files.length) await supabase.storage.from("attachments").remove(files.map((f) => f.path)).catch(() => {});
      return setError(sentence(error.message));
    }
    attach.clear();
    setDraft("");
    requestAnimationFrame(grow);
    // When their copy could not take it, the words went to the team instead, and they are told why.
    const why = (data as { why?: string } | null)?.why;
    setNotice(why === "asleep" ? "Your copy cannot be changed right now, so this went to the team instead." : why === "full" ? "That is all the changes your copy takes in a day, so this went to the team instead." : "");
    await reload();
    setSent(null);
  }

  async function disconnect() {
    if (mine) {
      const { error } = await supabase.rpc("disconnect", { conn: mine.id });
      if (error) setError("Your assistant was not disconnected. Try again.");
    }
    reload();
  }
  async function downloadMine() {
    const problem = await downloadExport("export_mine", table.id, table.name);
    if (problem) setError(sentence(problem));
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
  const locked = !!viewer && !viewer.acting;
  // Who is answering on the left: their copy, their own assistant, or the team. Beside the name, the one state.
  const speaker = (who: "copy" | "assistant" | "desk" | "team") => (
    <div className={styles.from}>
      {/* An AI answers under its maker's sign; the team answers under the table's. A copy is built by the team's
          Claude today, so that is the sign it carries. */}
      {who === "assistant" && theirs ? <AiLogo kind={theirs} size={18} /> : who === "copy" ? <AiLogo kind="claude" size={18} /> : <Mark size={18} />}
      <span className={styles.fromName}>{who === "copy" ? "Your copy" : who === "assistant" ? "Your assistant" : "The team"}</span>
      {who === "desk" && <span className={styles.fromTag}>assistant</span>}
    </div>
  );
  const answers = (u: ClientUpdate) => (
    <div key={u.id} className={styles.said}>
      {u.body}
      {u.replies?.length > 0 && !u.answer && (
        <div className={styles.replies} data-testid="replies">
          {u.replies.map((label, k) => (
            <button key={label} className={styles.reply} disabled={locked} onClick={() => answer(u, k + 1)}>{label}</button>
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
        <div className={`${room.brand} ${styles.brand}`}><Mark size={26} /> <span className={styles.brandWord}>Longtable</span></div>
        <div className={room.divider} />
        <div className={room.project}>{table.name}</div>
        <div className={room.spacer} />
        {overview && <button className={`btn btn-quiet ${styles.panelButton}`} onClick={() => setPanelOpen(true)} data-testid="open-panel">Your project</button>}
        {sandbox?.on && sandbox.url && (
          <a className={`btn btn-quiet ${styles.openCopy}`} href={sandbox.url} target="_blank" rel="noreferrer" data-testid="open-copy"><span className={styles.wide}>{viewer ? `Open ${first}'s copy` : "Open my copy"}</span><span className={styles.narrow}>{viewer ? `${first}'s copy` : "My copy"}</span> <Arrow size={15} /></a>
        )}
        {viewer ? (
          <button className="btn" onClick={viewer.onBack} data-testid={viewer.preview ? undefined : "table-portal"}>Back to the table</button>
        ) : (
          <ProfileMenu me={{ id: me.id, display_name: me.display_name, role: "client", color: me.color ?? "var(--sage)" }} tableId={table.id}
            ai={mine?.kind ?? null} aiWord="assistant"
            onConnect={sandbox?.on ? undefined : () => setConnectOpen(true)} onDisconnect={sandbox?.on ? undefined : disconnect}
            onDownload={downloadMine} privacy />
        )}
      </header>

      {viewer && !viewer.preview && (
        <div className={styles.viewing} data-testid="viewing">
          {viewer.acting
            ? <span>You are trying the client&apos;s side as a test client. What you send here reaches your table the way a real client&apos;s words would.</span>
            : <span>You are looking at {first}&apos;s side. Nothing here can be changed.</span>}
          {viewer.onRemoveTest && <button className={styles.other} onClick={viewer.onRemoveTest} data-testid="remove-test-client">Remove the test client</button>}
          {viewer.onTest && <button className={styles.other} onClick={viewer.onTest} data-testid="add-test-client">Try it as a test client</button>}
          {(viewer.others?.length ?? 0) > 1 && viewer.others!.map((o) => (
            <button key={o.id} className={`${styles.other} ${o.id === me.id ? styles.otherOn : ""}`} onClick={() => viewer.onPick?.(o.id)}>{firstName(o.display_name)}</button>
          ))}
        </div>
      )}

      <div className={styles.body}>
      <main className={styles.thread}>
        <div ref={chatRef} className={styles.scroll} data-testid="client-chat" data-with={sandbox?.on ? "copy" : mine ? "assistant" : "team"}>
          <div className={styles.col}>
            {ready && feed.length === 0 && !sandbox?.on && !mine && overview && (
              <ClientWelcome first={first} tableName={table.name} team={overview.team} />
            )}
            {ready && feed.length === 0 && (sandbox?.on || mine || !overview) && (
              <div className={styles.empty} data-testid="chat-head">
                {sandbox?.on ? `Say what you would like changed in ${table.name}. It is built in your own copy for you to try, and the team decides what goes into the real thing.`
                  : mine ? `Ask where anything stands, or for something new. Your ${AI_NAME[mine.kind]} answers what it can and passes the rest to the team.`
                  : `Ask the team for anything about ${table.name}, in your own words. You hear back here.`}
              </div>
            )}
            {feed.map((item, i) => {
              if (item.kind === "told") {
                // A run of the team's answers reads as one turn: "The team" once, like a person's messages in a row.
                const after = feed[i - 1]?.kind === "told";
                return (
                  <div key={item.id} className={`${styles.turn} ${after ? styles.toldMore : ""}`} data-request={item.r.id} data-told="">
                    <div className={styles.back}>
                      {!after && speaker("team")}
                      {answers(item.u)}
                    </div>
                  </div>
                );
              }
              if (item.kind === "line") {
                if (item.me) return <div key={item.id} className={styles.turn}>{myWords(item.text)}</div>;
                return (
                  <div key={item.id} className={styles.turn}>
                    <div className={styles.back}>
                      {speaker(item.own ? (item.desk ? "desk" : "assistant") : "team")}
                      <div className={styles.said}>
                        <div className={styles.voice}><Prose text={item.text} /></div>
                        {item.question && !item.question.answer && (
                          <div className={styles.replies} data-testid="replies">
                            {item.question.replies.map((label, k) => (
                              <button key={label} className={styles.reply} disabled={locked} onClick={() => answer(item.question!, k + 1)}>{label}</button>
                            ))}
                          </div>
                        )}
                        {/* Once answered, the question says what they chose, as a request's question does. */}
                        {item.question?.answer && <div className={styles.answered}>You answered: {item.question.answer}</div>}
                      </div>
                    </div>
                  </div>
                );
              }
              if (item.kind === "change") {
                const c = item.c;
                const asked = c.request_id ? requests.find((r) => r.id === c.request_id) : undefined;
                return (
                  <div key={item.id} className={styles.turn} data-change={c.id}>
                    {myWords(c.words)}
                    <div className={styles.back}>
                      {speaker(asked ? "team" : "copy")}
                      {c.status === "working" && <div className={styles.formingLine} data-testid="change-status">Building it in your copy<span className={styles.formingDots}><i /><i /><i /></span></div>}
                      {c.summary && <div className={styles.said}>{c.summary}</div>}
                      {c.request_id && told(c.request_id).map(answers)}
                      {c.undone === "undoing" && <div className={styles.formingLine} data-testid="change-status">Taking it back out of your copy<span className={styles.formingDots}><i /><i /><i /></span></div>}
                      {c.undone === "undone" && <div className={styles.said} data-testid="change-undone">Taken back out of your copy.</div>}
                      {c.undone === "stuck" && <div className={styles.said} data-testid="change-undone">This one could not be taken back on its own, because later changes build on it. The team can see it.</div>}
                      {c.did_not_build && !c.undone && <div className={styles.said} data-testid="did-not-build">That one did not work in your copy, so it still shows the version before it. The team has it.</div>}
                      {c.status === "ready" && !c.undone && !c.did_not_build && c.id === newestReady && sandbox?.building
                        ? <div className={styles.formingLine} data-testid="building-copy">Building your copy, about 3 minutes<span className={styles.formingDots}><i /><i /><i /></span></div>
                        : c.status === "ready" && sandbox?.url && !c.verdict && !c.undone && !c.did_not_build && (
                          <a className={`btn ${styles.tryIt}`} href={sandbox.url} target="_blank" rel="noreferrer" data-testid="try-it">Try it <Arrow size={16} /></a>
                        )}
                      {c.id === undoable && !locked && !sandbox?.changes.some((x) => x.undone === "undoing") && (
                        <button className={styles.other} onClick={() => undo()} data-testid="undo-change">Undo this</button>
                      )}
                      {c.verdict && <div className={`${styles.verdict} ${c.verdict === "no" ? styles.verdictNo : ""}`} data-testid="verdict">{VERDICT[c.verdict]}{c.note ? ` ${c.note}` : ""}</div>}
                    </div>
                  </div>
                );
              }
              const r = item.r;
              return (
                <div key={item.id} className={styles.turn} data-request={r.id}>
                  {myWords(r.body)}
                  {r.files?.length ? <div className={styles.mineFiles}><Files supabase={supabase} files={r.files} /></div> : null}
                </div>
              );
            })}
            {/* Their copy could not take in the team's latest: said plainly, last, until it catches up again. */}
            {sandbox?.on && sandbox.behind && (
              <div className={styles.turn} data-testid="copy-behind">
                <div className={styles.back}>
                  {speaker("copy")}
                  <div className={styles.said}>Your copy is behind the real one. Some of the team&apos;s latest work clashes with your changes, so your copy still shows an older version for now. The team knows, and it catches up by itself once the two fit again.</div>
                </div>
              </div>
            )}
            {/* The answer forming, the way a reply forms in Claude: the mark at work and a word on what is happening. */}
            {thinking && (
              <div className={styles.turn}>
                <div className={styles.back}>
                  <div className={styles.from}>
                    <span className={styles.forming} aria-hidden="true"><WorkingMark size={24} /></span>
                    <span className={styles.fromName}>{deskBusy || !mine ? "The team" : "Your assistant"}</span>
                  </div>
                  <div className={styles.formingLine} data-testid="thinking" data-stage={waitingOn ? "waiting" : stage}>
                    {waitingOn ? "Waiting for the team to come online" : stage === 1 ? "Checking with the team" : "Thinking"}<span className={styles.formingDots}><i /><i /><i /></span>
                  </div>
                </div>
              </div>
            )}
            {viewer && mine && <div className={styles.private}>{first}&apos;s chat with their own assistant is private and is not shown.</div>}
          </div>
        </div>

        <div className={styles.foot}>
          <div className={styles.col}>
            {!locked && <AttachTray a={attach} />}
            <form className={room.composer} onSubmit={(e) => { e.preventDefault(); if (!locked) say(); }} {...(locked ? {} : dropHandlers(attach))}>
              <textarea ref={inputRef} className={room.input} rows={1} value={draft} disabled={locked} maxLength={4000}
                placeholder={locked ? "Only they can write here" : sandbox?.on ? "Ask anything, or say what to change" : "Write a message"} aria-label="Ask the team"
                onChange={(e) => { setDraft(e.target.value); grow(); }}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!locked) say(); } }} />
              {!locked && <AttachButtons a={attach} disabled={busy} />}
              <button className="btn" disabled={locked || busy || attach.busy || attach.recording || (!draft.trim() && attach.pending.length === 0)}>Send</button>
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

      {overview && (
        <ClientPanel overview={overview} tableName={table.name} open={panelOpen} onClose={() => setPanelOpen(false)} />
      )}
      </div>

      {connectOpen && (
        <ConnectModal audience="client" tableId={table.id} tableName={table.name} connected={mine?.kind ?? null} onClose={() => setConnectOpen(false)} />
      )}
    </div>
  );
}
