"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import styles from "./computer.module.css";

// The person's own computer, from their own page: a terminal and a browser served by their connection's bridge on that
// computer (packages/connect/src/local.mjs). The page talks to it directly on 127.0.0.1, so what is typed here, a
// password included, never passes through Longtable. Longtable only hands this person where it listens and its key
// (`my_local`), and only while their AI runs as their full Claude Code.

export type Local = { port: number; key: string };

const UNREACHABLE = "Longtable could not reach your computer from this browser. Use it on the computer your Claude runs on, and allow it if your browser asks.";

export function useLocal(supabase: SupabaseClient, table: string, on: boolean) {
  const [local, setLocal] = useState<Local | null>(null);
  const refresh = useCallback(async () => {
    if (!on) return setLocal(null);
    const { data, error } = await supabase.rpc("my_local", { t: table });
    if (error) console.warn("[computer] could not read where your connection listens:", error.code);
    const next = !error && data && typeof data === "object" ? (data as Local) : null;
    // The same place keeps the same object, so what is listening to it is not started again.
    setLocal((prev) => (prev && next && prev.port === next.port && prev.key === next.key ? prev : next));
  }, [supabase, table, on]);
  useEffect(() => {
    refresh();
    // A connection that starts again listens somewhere new; this hears it within a minute.
    const t = on ? setInterval(refresh, 60000) : null;
    return () => { if (t) clearInterval(t); };
  }, [refresh, on]);
  return { local, refresh };
}

const at = (local: Local, path: string, table: string) => `http://127.0.0.1:${local.port}${path}?t=${encodeURIComponent(table)}`;

export async function bridge(local: Local, table: string, path: string, body: object) {
  const res = await fetch(at(local, path, table), { method: "POST", headers: { Authorization: `Bearer ${local.key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `your computer said no (${res.status})`);
  return out as { ok?: boolean; busy?: boolean };
}

// Lines of JSON from the bridge, until the page stops listening or the connection goes away.
function useStream(local: Local | null, table: string, path: string, on: boolean, onEvent: (e: Record<string, unknown>) => void, onLost: () => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const lost = useRef(onLost);
  lost.current = onLost;
  const [down, setDown] = useState(false);
  useEffect(() => {
    if (!local || !on) return;
    const stop = new AbortController();
    let retry: ReturnType<typeof setTimeout> | null = null;
    (async function listen() {
      try {
        const res = await fetch(at(local, path, table), { headers: { Authorization: `Bearer ${local.key}` }, signal: stop.signal });
        if (!res.ok || !res.body) throw new Error(`status ${res.status}`);
        setDown(false);
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (line) handler.current(JSON.parse(line));
          }
        }
        throw new Error("closed");
      } catch (e) {
        if (stop.signal.aborted) return;
        console.warn("[computer] lost your computer:", (e as Error).message);
        setDown(true);
        lost.current();
        retry = setTimeout(listen, 3000);
      }
    })();
    return () => { stop.abort(); if (retry) clearTimeout(retry); };
  }, [local, table, path, on]);
  return down;
}

// Colours and cursor moves are left out: the terminal shows plain text.
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\r(?!\n)/g, "");

function Terminal({ local, table, on, onLost, setNotice }: { local: Local | null; table: string; on: boolean; onLost: () => void; setNotice: (s: string) => void }) {
  const [text, setText] = useState("");
  const [cwd, setCwd] = useState("");
  const [running, setRunning] = useState(false);
  const [line, setLine] = useState("");
  const history = useRef<string[]>([]);
  const back = useRef(-1);
  const out = useRef<HTMLPreElement>(null);
  const down = useStream(local, table, "/term", on, (e) => {
    const state = e.state as { cwd: string; running: boolean; text: string } | undefined;
    if (state) { setText(plain(state.text)); setCwd(state.cwd); setRunning(state.running); }
    if (typeof e.text === "string") setText((t) => (t + plain(e.text as string)).slice(-200000));
    if (e.clear) setText("");
    if (typeof e.cwd === "string") setCwd(e.cwd);
    if (typeof e.running === "boolean") setRunning(e.running);
  }, onLost);
  useEffect(() => { const el = out.current; if (el) el.scrollTop = el.scrollHeight; }, [text]);
  const call = (path: string, body: object) => { if (local) bridge(local, table, path, body).catch((e) => setNotice(`Your terminal: ${(e as Error).message}`)); };
  const folder = cwd.split(/[\\/]/).filter(Boolean).pop() ?? "";
  return (
    <div className={styles.term} onClick={() => { if (!getSelection()?.toString()) document.getElementById("lt-term-line")?.focus(); }}>
      <pre ref={out} className={styles.termOut} data-testid="term-out">{down ? UNREACHABLE : text}</pre>
      <form className={styles.termLine} onSubmit={(e) => {
        e.preventDefault();
        if (line.trim()) history.current = [line, ...history.current.filter((h) => h !== line)].slice(0, 100);
        back.current = -1;
        call("/term", { line });
        setLine("");
      }}>
        <span className={styles.termWhere} title={cwd}>{running ? "" : `${folder}>`}</span>
        <input id="lt-term-line" className={styles.termInput} value={line} onChange={(e) => setLine(e.target.value)} autoComplete="off" spellCheck={false}
          aria-label="Command" data-testid="term-line" placeholder={running ? "Input for what is running" : ""}
          onKeyDown={(e) => {
            if (e.key === "c" && e.ctrlKey && !getSelection()?.toString()) { e.preventDefault(); call("/term/stop", {}); }
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              back.current = Math.max(-1, Math.min(history.current.length - 1, back.current + (e.key === "ArrowUp" ? 1 : -1)));
              setLine(back.current < 0 ? "" : history.current[back.current]);
            }
          }} />
        {running && <button type="button" className={styles.stop} onClick={() => call("/term/stop", {})} data-testid="term-stop">Stop</button>}
      </form>
    </div>
  );
}

function Browser({ local, table, on, onLost, setNotice }: { local: Local | null; table: string; on: boolean; onLost: () => void; setNotice: (s: string) => void }) {
  const [frame, setFrame] = useState("");
  const [url, setUrl] = useState("");
  const [typed, setTyped] = useState<string | null>(null);
  const [error, setError] = useState("");
  const down = useStream(local, table, "/browser", on, (e) => {
    if (typeof e.frame === "string") { setFrame(e.frame); setError(""); }
    if (typeof e.url === "string") setUrl(e.url);
    if (typeof e.error === "string") setError(e.error);
    if (e.closed) setFrame("");
  }, onLost);
  const act = (body: object) => { if (local) bridge(local, table, "/browser", body).catch((e) => setNotice(`Your browser: ${(e as Error).message}`)); };
  const point = (e: React.MouseEvent<HTMLImageElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const wheel = useRef(0);
  // The page is laid out at the size it is shown at (the bridge sets the browser to it), so it reads as it would in a
  // window this size, sharp on this screen.
  const view = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = view.current;
    if (!el || !local || !on || down) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tell = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const { width, height } = el.getBoundingClientRect();
        if (width > 50 && height > 50) bridge(local, table, "/browser", { do: "size", w: width, h: height, dpr: devicePixelRatio }).catch((e) => console.warn("[computer] browser size not set:", (e as Error).message));
      }, 200);
    };
    const watch = new ResizeObserver(tell);
    watch.observe(el);
    return () => { watch.disconnect(); if (timer) clearTimeout(timer); };
  }, [local, table, on, down]);
  return (
    <div className={styles.browser}>
      <form className={styles.bar} onSubmit={(e) => { e.preventDefault(); if (typed?.trim()) act({ do: "go", url: typed }); setTyped(null); (document.activeElement as HTMLElement)?.blur(); }}>
        <button type="button" className={styles.barBtn} aria-label="Back" onClick={() => act({ do: "back" })}>‹</button>
        <button type="button" className={styles.barBtn} aria-label="Forward" onClick={() => act({ do: "forward" })}>›</button>
        <button type="button" className={styles.barBtn} aria-label="Reload" onClick={() => act({ do: "reload" })}>↻</button>
        <input className={styles.address} value={typed ?? (url === "about:blank" ? "" : url)} onChange={(e) => setTyped(e.target.value)} onFocus={(e) => e.target.select()}
          onBlur={() => setTyped(null)} placeholder="Type an address, or localhost:3000" aria-label="Address" spellCheck={false} data-testid="browser-address" />
      </form>
      <div ref={view} className={styles.view} tabIndex={0} data-testid="browser-view"
        onKeyDown={(e) => {
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); return act({ do: "type", text: e.key }); }
          if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
          if (e.key.length > 1 || e.ctrlKey || e.metaKey) {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return; // the paste event sends the words
            e.preventDefault();
            act({ do: "key", key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey });
          }
        }}
        onPaste={(e) => { const t = e.clipboardData.getData("text/plain"); if (t) { e.preventDefault(); act({ do: "type", text: t }); } }}>
        {down ? <p className={styles.empty}>{UNREACHABLE}</p>
          : error ? <p className={styles.empty}>{error}</p>
          : frame ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className={styles.frame} alt={url || "Your browser"} src={`data:image/jpeg;base64,${frame}`} draggable={false}
              onClick={(e) => { (e.currentTarget.parentElement as HTMLElement).focus(); act({ do: "click", ...point(e) }); }}
              onWheel={(e) => {
                // At most one scroll every 60 ms, carrying everything turned meanwhile.
                const now = Date.now();
                if (now - wheel.current < 60) return;
                wheel.current = now;
                act({ do: "scroll", ...point(e as unknown as React.MouseEvent<HTMLImageElement>), dy: e.deltaY });
              }} />
          ) : <p className={styles.empty}>Starting your browser…</p>}
      </div>
    </div>
  );
}

export function ComputerPanel({ tab, onTab, onClose, local, table, onLost, setNotice }: {
  tab: "terminal" | "browser"; onTab: (t: "terminal" | "browser") => void; onClose: () => void;
  local: Local | null; table: string; onLost: () => void; setNotice: (s: string) => void;
}) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !(e.target as HTMLElement)?.closest?.("[data-testid=browser-view]")) onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <aside className={styles.panel} aria-label="Your computer" data-testid="computer">
      <div className={styles.head}>
        <div className={styles.tabs} role="tablist">
          {(["terminal", "browser"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={`${styles.tab} ${tab === t ? styles.tabOn : ""}`} onClick={() => onTab(t)} data-testid={`computer-${t}`}>
              {t === "terminal" ? "Terminal" : "Browser"}
            </button>
          ))}
        </div>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close">×</button>
      </div>
      {/* Both stay mounted, so switching tabs keeps what each shows; only the one in front listens. */}
      <div hidden={tab !== "terminal"} className={styles.body}><Terminal local={local} table={table} on={tab === "terminal"} onLost={onLost} setNotice={setNotice} /></div>
      <div hidden={tab !== "browser"} className={styles.body}><Browser local={local} table={table} on={tab === "browser"} onLost={onLost} setNotice={setNotice} /></div>
    </aside>
  );
}
