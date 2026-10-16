"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useEscape } from "@/components/use-escape";
import { Face } from "@/components/face";
import { Time } from "@/components/time";
import { Inline } from "@/lib/inline";
import { firstName } from "@/lib/names";
import { FRAME_SANDBOX, frameDoc } from "@/lib/page-frame.mjs";
import type { Member, Page, PageComment, PageValue, PageVersion } from "./types";
import s from "./pages.module.css";

// One small picture per kind of page, drawn the same way as the rest of the app's icons.
export function PageIcon({ icon, size = 18 }: { icon: string; size?: number }) {
  const paths: Record<string, string> = {
    chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
    table: "M3 5h18v14H3zM3 10h18M9 10v9",
    map: "M9 4l-6 2v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14",
    form: "M5 4h14v16H5zM8 8h8M8 12h8M8 16h5",
    plan: "M4 6h10M4 12h16M4 18h7M17 4l3 3-3 3",
    report: "M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5",
    diagram: "M4 4h6v6H4zM14 14h6v6h-6zM10 7h4a3 3 0 0 1 3 3v4",
    tool: "M14 7a4 4 0 1 0-5 5l-5 5 3 3 5-5a4 4 0 0 0 2-8z",
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={paths[icon] ?? "M6 3h9l4 4v14H6zM14 3v5h5"} />
    </svg>
  );
}

// The card under an answer that made a page, or that changed one.
export function PageCard({ page, onOpen }: { page: Page; onOpen: () => void }) {
  return (
    <button className={s.card} onClick={onOpen} data-testid="page-card">
      <span className={s.cardIcon}><PageIcon icon={page.icon} /></span>
      <span className={s.cardText}><b>{page.title}</b>{page.about && <span>{page.about}</span>}</span>
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
  useEscape(onClose);
  const frame = useRef<HTMLIFrameElement>(null);
  // A fresh key for each time the page is drawn: only messages carrying it are answered.
  const [key] = useState(() => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""));
  const [n, setN] = useState(page.version);
  const [html, setHtml] = useState<string | null>(null);
  const [side, setSide] = useState(true);
  const [draft, setDraft] = useState("");
  const [picked, setPicked] = useState("");
  const [toAi, setToAi] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const newest = n === page.version;

  // A new version arriving moves the window to it, unless someone is looking at an older one on purpose.
  const lastSeen = useRef(page.version);
  useEffect(() => {
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
      if (error || !data) { failedRef.current("This page could not be opened just now."); return; }
      setHtml((data as { html: string }).html);
    });
    return () => { gone = true; };
  }, [supabase, page.id, n]);

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
      if (d.op === "picked" && typeof d.a === "string") { setPicked(d.a.slice(0, 300)); setSide(true); return; }
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
  }, [key, supabase, page.id]);

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

  const mine = page.made_by === me.id;
  const name = (id: string | null) => (id ? members.get(id)?.display_name ?? "Someone" : "Someone");
  const madeBy = (v: PageVersion) => (v.by_ai ? `${firstName(name(v.made_by))}'s AI` : firstName(name(v.made_by)));

  async function call(fn: string, args: Record<string, unknown>, failed: string) {
    setBusy(true);
    const { error } = await supabase.rpc(fn, args);
    setBusy(false);
    if (error) onFailed(failed);
    return !error;
  }

  async function send() {
    const body = draft.trim();
    if (!body) return;
    const ok = await call("comment_page", { p: page.id, body, anchor: replyTo ? "" : picked, parent: replyTo, to_ai: !replyTo && toAi },
      toAi ? "Your comment was not sent to the AIs. Try again." : "Your comment was not kept. Try again.");
    if (ok) { setDraft(""); setPicked(""); setReplyTo(null); setToAi(false); }
  }

  function download() {
    if (html === null) return;
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${page.title.replace(/[^\w\- ]+/g, "").trim() || "page"}${newest ? "" : ` v${n}`}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  const live = comments.filter((c) => !c.deleted_at || comments.some((r) => r.parent_id === c.id && !r.deleted_at));
  const tops = live.filter((c) => !c.parent_id);
  const open = tops.filter((c) => !c.resolved_at);
  const resolved = tops.filter((c) => c.resolved_at);
  const others = viewers.filter((id) => id !== me.id);

  // Drawn by a plain function, never a component made inside this one (that would remount it on every change).
  const comment = (c: PageComment): ReactNode => {
    const who = c.member_id ? members.get(c.member_id) : undefined;
    const replies = live.filter((r) => r.parent_id === c.id);
    return (
      <div key={c.id} className={`${s.comment} ${c.resolved_at ? s.resolved : ""}`} data-testid="page-comment">
        <div className={s.commentHead}>
          <span className={s.face} style={{ background: who?.color }}><Face who={who} /></span>
          <b>{c.deleted_at ? "Taken away" : firstName(who?.display_name ?? "Someone")}</b>
          <span className={s.when}><Time iso={c.created_at} style="when" /></span>
          {c.version !== page.version && <span className={s.when}>on v{c.version}</span>}
          {c.to_ai && <span className={s.toAi}>sent to the AIs</span>}
        </div>
        {c.anchor && <div className={s.anchor}>{c.anchor}</div>}
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

  return (
    <div className={s.back} onClick={onClose}>
      <div className={`${s.window} ${side ? s.withSide : ""}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={page.title} data-testid="page-window">
        <div className={s.top}>
          <span className={s.topIcon}><PageIcon icon={page.icon} /></span>
          {naming === null ? (
            <button className={s.title} title="Rename" onClick={() => setNaming(page.title)}>{page.title}</button>
          ) : (
            <form className={s.rename} onSubmit={async (e) => { e.preventDefault(); if (naming.trim() && naming.trim() !== page.title) await call("rename_page", { p: page.id, title: naming.trim() }, "The page was not renamed. Try again."); setNaming(null); }}>
              <input className="field" autoFocus value={naming} maxLength={120} onChange={(e) => setNaming(e.target.value)} onBlur={() => setNaming(null)} aria-label="The page's name" />
            </form>
          )}
          <select className={s.versions} value={n} onChange={(e) => setN(Number(e.target.value))} aria-label="Version" data-testid="page-version">
            {[...versions].sort((a, b) => b.n - a.n).map((v) => (
              <option key={v.id} value={v.n}>v{v.n}{v.n === page.version ? " (newest)" : ""}, {madeBy(v)}{v.note ? `: ${v.note}` : ""}</option>
            ))}
          </select>
          {others.length > 0 && (
            <span className={s.viewers} title={`Also here: ${others.map((id) => firstName(name(id))).join(", ")}`} data-testid="page-viewers">
              {others.slice(0, 4).map((id) => { const w = members.get(id); return <span key={id} className={s.face} style={{ background: w?.color }}><Face who={w} /></span>; })}
            </span>
          )}
          <span className={s.spacer} />
          {!newest && <button className="btn btn-quiet" disabled={busy} onClick={async () => { if (await call("restore_page_version", { p: page.id, n }, "That version was not brought back. Try again.")) setN(page.version + 1); }}>Go back to this version</button>}
          <button className={`${s.tool} ${pinned ? s.on : ""}`} onClick={async () => { if (await call("pin_page", { p: page.id, pinned: !pinned }, "That did not take. Try again.")) onPinned(!pinned); }} aria-pressed={pinned} title={pinned ? "Unpin" : "Pin"}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill={pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.7"><path d="M9 3h6l-1 6 4 4H6l4-4-1-6zM12 13v8" /></svg>
          </button>
          <button className={s.tool} onClick={download} title="Download" disabled={html === null}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
          </button>
          <button className={`${s.tool} ${side ? s.on : ""}`} onClick={() => setSide(!side)} title="Comments" aria-pressed={side} data-testid="page-comments-toggle">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M4 5h16v11H9l-5 4z" /></svg>
            {open.length > 0 && <span className={s.count}>{open.length}</span>}
          </button>
          {(mine || owner) && (
            <button className={s.tool} title="Delete the page" onClick={async () => { if (window.confirm(`Delete "${page.title}" with all its versions and comments?`) && await call("delete_page", { p: page.id }, "The page was not deleted. Try again.")) onClose(); }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12" /></svg>
            </button>
          )}
          <button className={s.tool} onClick={onClose} title="Close" aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div className={s.body}>
          <div className={s.stage}>
            {doc === null ? <div className={s.loading}>Opening…</div>
              : <iframe ref={frame} className={s.frame} title={page.title} sandbox={FRAME_SANDBOX} srcDoc={doc} referrerPolicy="no-referrer" data-testid="page-frame" />}
          </div>
          {side && (
            <aside className={s.side} aria-label="Comments">
              <div className={s.sideList}>
                {open.length === 0 && resolved.length === 0 && <div className="note">No comments yet. Pick words out of the page to comment on them, or say something about the whole of it.</div>}
                {open.map((c) => comment(c))}
                {resolved.length > 0 && (
                  <button className={s.showResolved} onClick={() => setShowResolved(!showResolved)}>{showResolved ? "Hide" : "Show"} {resolved.length} resolved</button>
                )}
                {showResolved && resolved.map((c) => comment(c))}
              </div>
              <form className={s.compose} onSubmit={(e) => { e.preventDefault(); send(); }}>
                {replyTo && <div className={s.replying}>Replying <button type="button" onClick={() => setReplyTo(null)}>Cancel</button></div>}
                {!replyTo && picked && <div className={s.anchor}>{picked} <button type="button" className={s.unpick} onClick={() => setPicked("")} aria-label="Comment on the whole page instead">×</button></div>}
                <textarea className="field" rows={3} maxLength={4000} value={draft} placeholder={replyTo ? "Your reply" : picked ? "About these words" : "About this page"}
                  onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} data-testid="page-comment-box" />
                <div className={s.composeRow}>
                  {!replyTo && (
                    <label className={s.askAi}><input type="checkbox" checked={toAi} onChange={(e) => setToAi(e.target.checked)} data-testid="page-to-ai" /> Ask the AIs to change it</label>
                  )}
                  <button className="btn" disabled={busy || !draft.trim()}>{toAi && !replyTo ? "Send to the AIs" : "Comment"}</button>
                </div>
              </form>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}

// Every page at the table, pinned ones first, then the newest.
export function PagesList({ pages, pins, members, onOpen, onClose }: { pages: Page[]; pins: Set<string>; members: Map<string, Member>; onOpen: (id: string) => void; onClose: () => void }) {
  useEscape(onClose);
  const sorted = [...pages].sort((a, b) => Number(pins.has(b.id)) - Number(pins.has(a.id)) || b.touched_at.localeCompare(a.touched_at));
  return (
    <div className={s.back} onClick={onClose}>
      <div className={s.list} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Pages" data-testid="pages-list">
        <div className={s.listHead}><b>Pages</b><button className="btn btn-quiet" onClick={onClose}>Close</button></div>
        {sorted.length === 0 && <div className="note">No pages yet. Ask an AI at the table for one: a report, a chart, a mockup, a small tool.</div>}
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
