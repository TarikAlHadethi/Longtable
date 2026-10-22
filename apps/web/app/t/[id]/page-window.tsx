"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { useClosing, useEscape } from "@/components/use-escape";
import { Select } from "@/components/select";
import { Face } from "@/components/face";
import { Time } from "@/components/time";
import { Inline } from "@/lib/inline";
import { firstName } from "@/lib/names";
import { FRAME_SANDBOX, frameDoc } from "@/lib/page-frame.mjs";
import type { Member, Page, PageComment, PageValue, PageVersion } from "./types";
import room from "./room.module.css";
import s from "./pages.module.css";

// One small picture per kind of page, drawn the same way as the rest of the app's icons.
export function PageIcon({ size = 18 }: { icon?: string; size?: number }) {
  // One mark for every handout, whatever it holds: two sheets, the top one with a folded corner.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 3.5h6.5L19 8v10.5a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2z" /><path d="M14 3.5V8h5" /><path d="M9.5 13h6M9.5 16.5h4" />
    </svg>
  );
}

// The card under an answer that made a page, or that changed one.
export function PageCard({ page, onOpen }: { page: Page; onOpen: () => void }) {
  return (
    <button className={s.card} onClick={onOpen} data-testid="page-card">
      <span className={s.cardIcon}><PageIcon icon={page.icon} /></span>
      <span className={s.cardText}><b>{page.title}</b></span>
      <span className={s.cardOpen}>Open</span>
    </button>
  );
}

type Props = {
  supabase: SupabaseClient;
  page: Page;
  me: Member;
  owner: boolean;
  members: Map<string, Member>;
  versions: PageVersion[];
  comments: PageComment[];
  values: PageValue[];
  pinned: boolean;
  viewers: string[];
  onClose: () => void;
  onFailed: (message: string) => void;
  onPinned: (pinned: boolean) => void;
};

// A page, open: the page itself in its locked frame, and beside it what people said about it.
export function PageWindow({ supabase, page, me, owner, members, versions, comments, values, pinned, viewers, onClose, onFailed, onPinned }: Props) {
  const [shut, close] = useClosing(onClose);
  const frame = useRef<HTMLIFrameElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  // What pressing the page does: nothing special, comment on the thing pressed, or edit its words in place.
  const [mode, setMode] = useState<"view" | "comment" | "edit">("view");
  // A comment being written on one thing in the page, a pin's thread open, the comments list, a menu open.
  const [place, setPlace] = useState<{ path: number[]; label: string; x: number; y: number; w: number } | null>(null);
  const [thread, setThread] = useState<{ id: string; x: number; y: number } | null>(null);
  const [list, setList] = useState(false);
  const [menu, setMenu] = useState<"download" | "delete" | null>(null);
  const [popPin, setPopPin] = useState(false);
  const [making, setMaking] = useState(false);
  const [saving, setSaving] = useState(false);
  // What the page sends back is taken only when this person asked for it: the page's own script can read the frame's
  // key from any message, so a page could otherwise save versions in their name, or hand over pictures unasked.
  const wantHtml = useRef(false);
  const wantPng = useRef(false);
  const [reload, setReload] = useState(0);
  // Escape closes the topmost thing open: a menu, a comment being written, a thread, the list, a mode, then the window.
  const escape = useCallback(() => {
    if (menu) setMenu(null);
    else if (place) setPlace(null);
    else if (thread) setThread(null);
    else if (list) setList(false);
    else if (mode !== "view") { setMode("view"); if (mode === "edit") setReload((k) => k + 1); }
    else close();
  }, [menu, place, thread, list, mode, close]);
  useEscape(escape);
  // A fresh key for each time the page is drawn: only messages carrying it are answered.
  const [key] = useState(() => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""));
  const [n, setN] = useState(page.version);
  const [html, setHtml] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [picked, setPicked] = useState("");
  const [toAi, setToAi] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const newest = n === page.version;
  // Where everyone else on this page points, and who is writing a comment, as the table's cursor channel says.
  const [pointers, setPointers] = useState<Record<string, { path: number[]; fx: number; fy: number; at: number }>>({});
  const [writing, setWriting] = useState<Record<string, number>>({});
  const [lit, setLit] = useState<string | null>(null);
  const cursorChannel = useRef<RealtimeChannel | null>(null);
  // The room hands a new map of people on each redraw: read through a ref, so the channel is not joined again for it.
  const membersRef = useRef(members);
  membersRef.current = members;
  const lastPoint = useRef(0);
  const lastTyped = useRef(0);
  useEffect(() => {
    let gone = false;
    let ch: RealtimeChannel | null = null;
    (async () => {
      await supabase.realtime.setAuth();
      if (gone) return;
      ch = supabase.channel(`cursor:${page.table_id}`, { config: { private: true, broadcast: { self: false } } });
      ch.on("broadcast", { event: "point" }, ({ payload }) => {
        const p = payload as { m?: string; page?: string; path?: number[] | null; fx?: number; fy?: number };
        if (!p?.m || p.page !== page.id || p.m === me.id || !membersRef.current.has(p.m)) return;
        const who = p.m;
        setPointers((prev) => {
          const next = { ...prev };
          if (!Array.isArray(p.path)) delete next[who];
          else next[who] = { path: p.path.slice(0, 40).map((x) => Math.max(0, Math.floor(Number(x) || 0))), fx: Number(p.fx) || 0, fy: Number(p.fy) || 0, at: Date.now() };
          return next;
        });
      }).on("broadcast", { event: "writing" }, ({ payload }) => {
        const p = payload as { m?: string; page?: string };
        if (!p?.m || p.page !== page.id || p.m === me.id || !membersRef.current.has(p.m)) return;
        setWriting((prev) => ({ ...prev, [p.m as string]: Date.now() }));
      }).subscribe();
      cursorChannel.current = ch;
    })();
    // Someone who stopped saying where they are has gone: their cursor and their line fade after a while.
    const prune = setInterval(() => {
      const now = Date.now();
      setPointers((prev) => (Object.values(prev).some((c) => now - c.at > 15000) ? Object.fromEntries(Object.entries(prev).filter(([, c]) => now - c.at <= 15000)) : prev));
      setWriting((prev) => (Object.values(prev).some((t) => now - t > 4000) ? Object.fromEntries(Object.entries(prev).filter(([, t]) => now - t <= 4000)) : prev));
    }, 1000);
    return () => {
      gone = true;
      clearInterval(prune);
      if (ch) { ch.send({ type: "broadcast", event: "point", payload: { m: me.id, page: page.id, path: null } }).catch(() => {}); supabase.removeChannel(ch); }
      cursorChannel.current = null;
    };
  }, [supabase, page.table_id, page.id, me.id]);

  // A new version arriving moves the window to it, unless someone is looking at an older one on purpose, or is
  // changing words in this one (moving would throw their changes away; they see the new one once they save or stop).
  const lastSeen = useRef(page.version);
  const editingRef = useRef(false);
  editingRef.current = mode === "edit";
  useEffect(() => {
    if (editingRef.current) return;
    setN((cur) => (cur === lastSeen.current ? page.version : cur));
    lastSeen.current = page.version;
  }, [page.version]);

  // The room redraws often and hands a new callback each time: kept in a ref, so the page is read again only when
  // the version shown changes, never because the room redrew (that reloaded the frame and lost what was in it).
  const failedRef = useRef(onFailed);
  failedRef.current = onFailed;
  useEffect(() => {
    let gone = false;
    setHtml(null);
    supabase.from("page_versions").select("html").eq("page_id", page.id).eq("n", n).maybeSingle().then(({ data, error }) => {
      if (gone) return;
      if (error || !data) { failedRef.current("This handout could not be opened just now."); return; }
      setHtml((data as { html: string }).html);
    });
    return () => { gone = true; };
  }, [supabase, page.id, n]);

  // The message handler is made once per frame key: what it needs that changes is read through refs.
  const saveRef = useRef<(t: string) => void>(() => {});
  const nameRef = useRef("handout");
  const doc = useMemo(() => (html === null ? null : frameDoc(html, { key, me: firstName(me.display_name) })), [html, key, me.display_name]);

  // What the page asks of the table, answered as the person looking, and only for this frame.
  const valuesRef = useRef(values);
  valuesRef.current = values;
  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      const d = e.data as { lt?: string; id?: number; op?: string; a?: { key?: string; value?: unknown } | string } | null;
      if (!win || e.source !== win || !d || d.lt !== key) return;
      const answer = (value: unknown, error?: string) => win.postMessage({ lt: key, id: d.id, value, error }, "*");
      if (d.op === "picked" && typeof d.a === "string") { setPicked(d.a.slice(0, 300)); setList(true); return; }
      if (d.op === "pickEl" && d.a && typeof d.a === "object") {
        const e2 = d.a as { path?: number[]; label?: string; x?: number; y?: number; w?: number };
        setThread(null); setReplyTo(null); setToAi(true);
        setPlace({ path: (e2.path ?? []).slice(0, 40).map((x) => Math.max(0, Math.floor(Number(x) || 0))), label: String(e2.label ?? "").slice(0, 80).replace(/\|/g, " "), x: Number(e2.x) || 0, y: Number(e2.y) || 0, w: Number(e2.w) || 0 });
        return;
      }
      if (d.op === "pin" && d.a && typeof d.a === "object") {
        const e2 = d.a as { id?: string; x?: number; y?: number };
        setPlace(null); setReplyTo(null); setThread({ id: String(e2.id ?? ""), x: Number(e2.x) || 0, y: Number(e2.y) || 0 });
        return;
      }
      if (d.op === "html") { if (!wantHtml.current) return; wantHtml.current = false; setSaving(false); if (typeof d.a === "string") saveRef.current(d.a); return; }
      if (d.op === "png") {
        if (!wantPng.current) return;
        wantPng.current = false;
        setMaking(false);
        if (typeof d.a === "string" && d.a.startsWith("data:image/png")) { const a2 = document.createElement("a"); a2.href = d.a; a2.download = `${nameRef.current}.png`; a2.click(); }
        else failedRef.current("The picture could not be made. Try HTML or PDF.");
        return;
      }
      if (d.op === "pointer") {
        const now = Date.now();
        const where = d.a && typeof d.a === "object" ? (d.a as { path?: number[]; fx?: number; fy?: number }) : null;
        if (where && now - lastPoint.current < 50) return;
        lastPoint.current = now;
        cursorChannel.current?.send({ type: "broadcast", event: "point", payload: where ? { m: me.id, page: page.id, path: where.path, fx: where.fx, fy: where.fy } : { m: me.id, page: page.id, path: null } }).catch(() => {});
        return;
      }
      if (d.op === "mark" && typeof d.a === "string") { setList(true); setLit(d.a); document.querySelector(`[data-cid="${d.a}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }); return; }
      const a = (typeof d.a === "object" && d.a) || {};
      if (d.op === "get") return answer(valuesRef.current.find((v) => v.key === a.key)?.value ?? null);
      if (d.op === "all") return answer(Object.fromEntries(valuesRef.current.map((v) => [v.key, v.value])));
      if (d.op === "set") {
        const { error } = await supabase.rpc("set_page_state", { p: page.id, key: String(a.key ?? ""), value: a.value ?? null });
        return error ? answer(null, "That was not kept.") : answer(true);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [key, supabase, page.id, me.id]);

  // Someone else changing a value reaches the page while it is open.
  const told = useRef(new Map<string, string>());
  useEffect(() => {
    const win = frame.current?.contentWindow;
    for (const v of values) {
      const was = told.current.get(v.key);
      told.current.set(v.key, v.updated_at);
      if (was && was !== v.updated_at && v.updated_by !== me.id) win?.postMessage({ lt: key, op: "changed", key: v.key, value: v.value }, "*");
    }
  }, [values, key, me.id]);

  const cursorList = useMemo(() => Object.entries(pointers).map(([id, c]) => {
    const w = members.get(id);
    return { id, name: firstName(w?.display_name ?? "Someone"), color: w?.color ?? "#555", path: c.path, fx: c.fx, fy: c.fy };
  }), [pointers, members]);
  const markList = useMemo(() => comments.filter((c) => !c.parent_id && !c.deleted_at && !c.resolved_at && c.anchor).map((c) => ({ id: c.id, text: c.anchor })), [comments]);
  const toFrame = (msg: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ lt: key, ...msg }, "*");
  useEffect(() => { toFrame({ op: "cursors", list: cursorList }); });
  useEffect(() => { toFrame({ op: "marks", list: markList }); }, [markList, html]);
  useEffect(() => { toFrame({ op: "focus", id: lit }); }, [lit]);
  const sayWriting = () => {
    const now = Date.now();
    if (now - lastTyped.current < 2000) return;
    lastTyped.current = now;
    cursorChannel.current?.send({ type: "broadcast", event: "writing", payload: { m: me.id, page: page.id } }).catch(() => {});
  };
  const mine = page.made_by === me.id;
  const name = (id: string | null) => (id ? members.get(id)?.display_name ?? "Someone" : "Someone");

  async function call(fn: string, args: Record<string, unknown>, failed: string) {
    setBusy(true);
    const { error } = await supabase.rpc(fn, args);
    setBusy(false);
    if (error) onFailed(failed);
    return !error;
  }

  async function send(anchor: string, body: string, ai: boolean) {
    const words = body.trim();
    if (!words) return false;
    const ok = await call("comment_page", { p: page.id, body: words, anchor: replyTo ? "" : anchor, parent: replyTo, to_ai: !replyTo && ai },
      ai ? "Your comment was not sent to the AIs. Try again." : "Your comment was not kept. Try again.");
    if (ok) { setDraft(""); setPicked(""); setReplyTo(null); setToAi(false); setPlace(null); }
    return ok;
  }

  // Downloads: the page as it is, a picture of it, or a PDF from the browser's own print window.
  const fileName = `${page.title.replace(/[^\w\- ]+/g, "").trim() || "handout"}${newest ? "" : ` v${n}`}`;
  nameRef.current = fileName;
  function save(href: string, ext: string) {
    const a = document.createElement("a");
    a.href = href;
    a.download = `${fileName}.${ext}`;
    a.click();
  }
  function download(kind: "html" | "pdf" | "png") {
    setMenu(null);
    if (html === null) return;
    if (kind === "html") {
      const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      save(url, "html");
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } else if (kind === "pdf") toFrame({ op: "print" });
    else { setMaking(true); wantPng.current = true; toFrame({ op: "png" }); }
  }

  // Changing the words by hand: the page becomes editable in place, and Save keeps it as a new version.
  async function saveEdit(text: string) {
    const { data, error } = await supabase.rpc("edit_page", { p: page.id, html: text });
    if (error) { onFailed("Your changes were not kept. Try again."); return; }
    setMode("view");
    if (typeof data === "number") setN(data);
  }
  saveRef.current = saveEdit;
  useEffect(() => { toFrame({ op: "mode", m: mode }); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const live = comments.filter((c) => !c.deleted_at || comments.some((r) => r.parent_id === c.id && !r.deleted_at));
  const tops = live.filter((c) => !c.parent_id);
  const open = tops.filter((c) => !c.resolved_at);
  const resolved = tops.filter((c) => c.resolved_at);
  const others = viewers.filter((id) => id !== me.id);
  // Comments on a thing in the page are numbered pins on it; comments on words light the words.
  const pinned2 = open.filter((c) => c.anchor?.startsWith("el:"));
  const pinList = useMemo(() => pinned2.map((c, i) => ({ id: c.id, n: i + 1, path: c.anchor.slice(3).split("|")[0].split(".").filter(Boolean).map(Number) })), [pinned2]);
  useEffect(() => { toFrame({ op: "pins", list: pinList }); }, [pinList, html]); // eslint-disable-line react-hooks/exhaustive-deps
  const anchorText = (a: string) => (a.startsWith("el:") ? a.slice(a.indexOf("|") + 1) : a);

  // Drawn by a plain function, never a component made inside this one (that would remount it on every change).
  const comment = (c: PageComment): ReactNode => {
    const who = c.member_id ? members.get(c.member_id) : undefined;
    const replies = live.filter((r) => r.parent_id === c.id);
    return (
      <div key={c.id} data-cid={c.id} className={`${s.comment} ${c.resolved_at ? s.resolved : ""} ${lit === c.id ? s.lit : ""}`} data-testid="page-comment"
        onMouseEnter={() => c.anchor && setLit(c.id)} onMouseLeave={() => setLit((cur) => (cur === c.id ? null : cur))}>
        <div className={s.commentHead}>
          <span className={s.face} style={{ background: who?.color }}><Face who={who} /></span>
          <b>{c.deleted_at ? "Taken away" : firstName(who?.display_name ?? "Someone")}</b>
          <span className={s.when}><Time iso={c.created_at} style="when" /></span>
          {c.version !== page.version && <span className={s.when}>on version {c.version}</span>}
          {c.to_ai && <span className={s.toAi}>sent to the AIs</span>}
        </div>
        {c.anchor && <div className={s.anchor}>{anchorText(c.anchor)}</div>}
        {!c.deleted_at && <div className={s.commentBody}><Inline text={c.body} /></div>}
        {!c.deleted_at && (
          <div className={s.commentActions}>
            {!c.parent_id && <button onClick={() => { setReplyTo(c.id); setPicked(""); }}>Reply</button>}
            {!c.parent_id && <button onClick={() => call("resolve_page_comment", { cm: c.id, done: !c.resolved_at }, "That did not take. Try again.")}>{c.resolved_at ? "Reopen" : "Resolve"}</button>}
            {(c.member_id === me.id || owner) && <button onClick={() => call("delete_page_comment", { cm: c.id }, "The comment was not taken away. Try again.")}>Delete</button>}
          </div>
        )}
        {replies.length > 0 && <div className={s.replies}>{replies.map((r) => comment(r))}</div>}
      </div>
    );
  };

  // The box to write in: for the whole handout, for one thing in it, or a reply.
  const composer = (anchor: string, onDone?: () => void) => (
    <form className={s.compose} onSubmit={async (e) => { e.preventDefault(); if (await send(anchor, draft, toAi)) onDone?.(); }}>
      {replyTo && <div className={s.replying}>Replying <button type="button" onClick={() => setReplyTo(null)}>Cancel</button></div>}
      {!replyTo && anchor && <div className={s.anchor}>{anchorText(anchor)}</div>}
      <textarea className="field" rows={2} autoFocus={!!anchor} maxLength={4000} value={draft} placeholder={replyTo ? "Your reply" : anchor ? "What should change here?" : "About this handout"}
        onChange={(e) => { setDraft(e.target.value); if (e.target.value.trim()) sayWriting(); }}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); (e.currentTarget.form as HTMLFormElement).requestSubmit(); } }} data-testid="page-comment-box" />
      <div className={s.composeRow}>
        {!replyTo && <label className={s.askAi}><input type="checkbox" checked={toAi} onChange={(e) => setToAi(e.target.checked)} data-testid="page-to-ai" /> Ask the AIs to change it</label>}
        <button className="btn" disabled={busy || !draft.trim()} data-testid="page-comment-send">{toAi && !replyTo ? "Send to the AIs" : "Comment"}</button>
      </div>
    </form>
  );

  // Where a popover sits over the page: beside the thing it is about, kept inside the stage.
  const at = (x: number, y: number) => {
    const f = frame.current, st = stage.current;
    if (!f || !st) return { left: 24, top: 24 };
    const fr = f.getBoundingClientRect(), sr = st.getBoundingClientRect();
    return { left: Math.max(12, Math.min(sr.width - 332, fr.left - sr.left + x)), top: Math.max(12, Math.min(sr.height - 240, fr.top - sr.top + y)) };
  };
  const threadOf = thread ? open.find((c) => c.id === thread.id) : undefined;

  return (
    <div className={`${s.back} ${shut ? s.closing : ""}`} onClick={close}>
      <div className={s.window} onClick={(e) => { e.stopPropagation(); setMenu(null); }} role="dialog" aria-label={page.title} data-testid="page-window">
        <div className={s.top}>
          <span className={s.topIcon}><PageIcon icon={page.icon} /></span>
          {naming === null ? (
            <button className={s.title} title="Rename" onClick={() => setNaming(page.title)}>{page.title}</button>
          ) : (
            <form className={s.rename} onSubmit={async (e) => { e.preventDefault(); if (naming.trim() && naming.trim() !== page.title) await call("rename_page", { p: page.id, title: naming.trim() }, "The handout was not renamed. Try again."); setNaming(null); }}>
              <input className="field" autoFocus value={naming} maxLength={120} onChange={(e) => setNaming(e.target.value)} onBlur={() => setNaming(null)} aria-label="The handout's name" />
            </form>
          )}
          {versions.length > 1 && (
            <div className={s.versions} data-testid="page-version">
              <Select label="Version" value={String(n)} onChange={(v) => setN(Number(v))}
                options={[...versions].sort((a, b) => b.n - a.n).map((v) => ({ value: String(v.n), label: `Version ${v.n}` }))} />
            </div>
          )}
          {others.length > 0 && (
            <span className={s.viewers} title={`Also here: ${others.map((id) => firstName(name(id))).join(", ")}`} data-testid="page-viewers">
              {others.slice(0, 4).map((id) => { const w = members.get(id); return <span key={id} className={s.face} style={{ background: w?.color }}><Face who={w} /></span>; })}
            </span>
          )}
          <span className={s.spacer} />
          {!newest && mode === "view" && <button className={`btn btn-quiet ${s.restore}`} disabled={busy} onClick={async () => { if (await call("restore_page_version", { p: page.id, n }, "That version was not brought back. Try again.")) setN(page.version + 1); }}>Go back to this version</button>}
          {mode === "edit" ? (
            <span className={s.editBar} data-testid="page-editing">
              <span>Editing the words</span>
              <button className="btn btn-quiet" onClick={() => { setMode("view"); setReload((k) => k + 1); }}>Cancel</button>
              <button className="btn" onClick={() => { setSaving(true); wantHtml.current = true; toFrame({ op: "serialize" }); }} disabled={saving} data-testid="page-save">Save</button>
            </span>
          ) : (
            <span className={s.modes} role="group" aria-label="What pressing the page does">
              <button className={`${s.mode} ${mode === "comment" ? s.modeOn : ""}`} onClick={() => { setMode(mode === "comment" ? "view" : "comment"); setPlace(null); setThread(null); }} aria-pressed={mode === "comment"} data-testid="page-comment-mode">
                <Icon d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4A2.5 2.5 0 0 1 3 13.5z" />Comment
              </button>
              {/* Words are changed in place only on a page that does not build itself with its own script: saving one
                  that does would keep what its script drew as well as the script, and show it twice. */}
              {newest && html !== null && !/<script(?![^>]*\bdata-lt\b)/i.test(html) && <button className={s.mode} onClick={() => { setMode("edit"); setPlace(null); setThread(null); setList(false); }} data-testid="page-edit-mode">
                <Icon d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM13.5 6.5l4 4" />Edit
              </button>}
            </span>
          )}
          <button className={`${s.tool} ${list ? s.on : ""}`} onClick={() => { setList(!list); setThread(null); setPlace(null); }} title="Comments" aria-pressed={list} data-testid="page-comments-toggle">
            <Icon d="M5 6h14M5 12h14M5 18h9" />
            {open.length > 0 && <span className={s.count}>{open.length}</span>}
          </button>
          <button className={`${s.tool} ${pinned ? s.on : ""} ${popPin ? s.popped : ""}`} title={pinned ? "Unpin" : "Pin"} aria-pressed={pinned} data-testid="page-pin"
            onClick={async () => { const next = !pinned; onPinned(next); setPopPin(true); setTimeout(() => setPopPin(false), 320);
              const { error } = await supabase.rpc("pin_page", { p: page.id, pinned: next }); if (error) { onPinned(!next); onFailed("That did not take. Try again."); } }}>
            <Icon d="M14.5 3.5l6 6-3 1-3.5 3.5.5 4-1.5 1.5-4.5-4.5L4 20.5l-.5-.5L9 14.5 4.5 10 6 8.5l4 .5L13.5 5.5z" fill={pinned} />
          </button>
          <span className={s.menuWrap} onClick={(e) => e.stopPropagation()}>
            <button className={`${s.tool} ${menu === "download" ? s.on : ""}`} title="Download" disabled={html === null} onClick={() => setMenu(menu === "download" ? null : "download")} data-testid="page-download" aria-haspopup="menu" aria-expanded={menu === "download"}>
              {making ? <span className={s.spin} /> : <Icon d="M12 4v10.5M7.5 10.5L12 15l4.5-4.5M5 19.5h14" />}
            </button>
            {menu === "download" && (
              <div className={s.menu} role="menu">
                <button role="menuitem" onClick={() => download("html")}><b>HTML</b><span>The page itself, works anywhere</span></button>
                <button role="menuitem" onClick={() => download("pdf")}><b>PDF</b><span>Choose Save as PDF in the print window</span></button>
                <button role="menuitem" onClick={() => download("png")}><b>PNG</b><span>A picture of the whole page</span></button>
              </div>
            )}
          </span>
          {(mine || owner) && (
            <span className={s.menuWrap} onClick={(e) => e.stopPropagation()}>
              <button className={`${s.tool} ${menu === "delete" ? s.on : ""}`} title="Delete the handout" onClick={() => setMenu(menu === "delete" ? null : "delete")} aria-haspopup="dialog" aria-expanded={menu === "delete"}>
                <Icon d="M5 7h14M10 4h4M7 7l.8 11.2A2 2 0 0 0 9.8 20h4.4a2 2 0 0 0 2-1.8L17 7" />
              </button>
              {menu === "delete" && (
                <div className={`${s.menu} ${s.sure}`} role="dialog">
                  <b>Delete this handout?</b>
                  <span>Every version and comment goes with it.</span>
                  <span className={s.sureRow}>
                    <button className="btn btn-quiet" onClick={() => setMenu(null)}>Keep</button>
                    <button className={`btn ${room.chatSureDelete}`} onClick={async () => { if (await call("delete_page", { p: page.id }, "The handout was not deleted. Try again.")) close(); }} data-testid="page-delete">Delete</button>
                  </span>
                </div>
              )}
            </span>
          )}
          <button className={s.tool} onClick={close} title="Close" aria-label="Close">
            <Icon d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
          </button>
        </div>
        <div className={s.body}>
          <div className={`${s.stage} ${mode !== "view" ? s.stageMode : ""}`} ref={stage}>
            {doc === null ? <div className={s.loading}>Opening…</div>
              : <iframe key={reload} ref={frame} className={s.frame} title={page.title} sandbox={FRAME_SANDBOX} srcDoc={doc} referrerPolicy="no-referrer" data-testid="page-frame"
                  onLoad={() => { toFrame({ op: "marks", list: markList }); toFrame({ op: "cursors", list: cursorList }); toFrame({ op: "pins", list: pinList }); toFrame({ op: "mode", m: mode }); }} />}
            {/* Someone writing a comment shows over the page, whether or not the comments are open. */}
            {Object.keys(writing).length > 0 && (
              <div className={`${s.writing} ${s.writingOver}`} data-testid="page-writing">{Object.keys(writing).map((id) => firstName(name(id))).join(", ")} {Object.keys(writing).length > 1 ? "are" : "is"} writing a comment<span className={s.dots}><i /><i /><i /></span></div>
            )}
            {mode === "comment" && !place && <div className={s.hint}>Point at anything on the page and press it to comment there</div>}
            {place && (
              <div className={s.pop} style={at(place.x + place.w, place.y)} onClick={(e) => e.stopPropagation()} data-testid="page-comment-here">
                {composer(`el:${place.path.join(".")}|${place.label}`, () => setMode("view"))}
                <button className={s.popClose} onClick={() => setPlace(null)} aria-label="Cancel">×</button>
              </div>
            )}
            {threadOf && thread && (
              <div className={s.pop} style={at(thread.x + 28, thread.y)} onClick={(e) => e.stopPropagation()}>
                <div className={s.popList}>{comment(threadOf)}</div>
                {replyTo === threadOf.id && composer("")}
                <button className={s.popClose} onClick={() => { setThread(null); setReplyTo(null); }} aria-label="Close">×</button>
              </div>
            )}
            {list && (
              <aside className={s.drawer} aria-label="Comments" onClick={(e) => e.stopPropagation()}>
                <div className={s.sideList}>
                  {open.length === 0 && resolved.length === 0 && <div className="note">No comments yet. Press Comment, then the thing you want changed.</div>}
                  {open.map((c) => comment(c))}
                  {resolved.length > 0 && (
                    <button className={s.showResolved} onClick={() => setShowResolved(!showResolved)}>{showResolved ? "Hide" : "Show"} {resolved.length} resolved</button>
                  )}
                  {showResolved && resolved.map((c) => comment(c))}
                </div>
                {composer(replyTo ? "" : picked)}
              </aside>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// The soft, round icons of the handout window.
function Icon({ d, fill = false }: { d: string; fill?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill={fill ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

// Every page at the table, pinned ones first, then the newest.
export function PagesList({ pages, pins, members, onOpen, onClose }: { pages: Page[]; pins: Set<string>; members: Map<string, Member>; onOpen: (id: string) => void; onClose: () => void }) {
  useEscape(onClose);
  const sorted = [...pages].sort((a, b) => Number(pins.has(b.id)) - Number(pins.has(a.id)) || b.touched_at.localeCompare(a.touched_at));
  return (
    <div className={s.back} onClick={onClose}>
      <div className={s.list} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Handouts" data-testid="pages-list">
        <div className={s.listHead}><b>Handouts</b><button className="btn btn-quiet" onClick={onClose}>Close</button></div>
        {sorted.length === 0 && <div className="note">No handouts yet. Ask an AI at the table for one: a chart, a mockup, a report, a small tool.</div>}
        {sorted.map((p) => (
          <button key={p.id} className={s.row} onClick={() => onOpen(p.id)}>
            <span className={s.cardIcon}><PageIcon icon={p.icon} /></span>
            <span className={s.cardText}><b>{pins.has(p.id) ? "Pinned: " : ""}{p.title}</b><span>{p.about || `By ${firstName(members.get(p.made_by ?? "")?.display_name ?? "someone")}'s AI`}</span></span>
            <span className={s.rowWhen}>v{p.version}, <Time iso={p.touched_at} style="when" /></span>
          </button>
        ))}
      </div>
    </div>
  );
}
