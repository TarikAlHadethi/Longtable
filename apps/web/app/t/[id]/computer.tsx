"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import "@xterm/xterm/css/xterm.css";
import { BackIcon, ForwardIcon, Globe, Plus, ReloadIcon } from "@/components/icons";
import styles from "./computer.module.css";

// The person's own computer, from their own page: a terminal and a browser served by their connection's bridge on that
// computer (packages/connect/src/local.mjs). The page talks to it directly on 127.0.0.1, so what is typed here, a
// password included, never passes through Longtable. Longtable only hands this person where it listens and its key
// (`my_local`), and only while their AI runs as their full Claude Code.
// The windows they sit in are computer-windows.tsx.

export type Local = { port: number; key: string };

const UNREACHABLE = "Longtable could not reach your computer from this browser. Use it on the computer your Claude runs on, and allow it if your browser asks.";
// Past this many tabs a browser starts to weigh on a computer: said once, never a limit.
export const MANY_TABS = 10;

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

const at = (local: Local, path: string, table: string, extra = "") => `http://127.0.0.1:${local.port}${path}?t=${encodeURIComponent(table)}${extra}`;

export async function bridge(local: Local, table: string, path: string, body: object, query = "") {
  const res = await fetch(at(local, path, table, query), { method: "POST", headers: { Authorization: `Bearer ${local.key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `your computer said no (${res.status})`);
  return out as { ok?: boolean };
}

async function bridgeGet<T>(local: Local, table: string, path: string): Promise<T> {
  const res = await fetch(at(local, path, table), { headers: { Authorization: `Bearer ${local.key}` } });
  if (!res.ok) throw new Error(`your computer said no (${res.status})`);
  return res.json() as Promise<T>;
}

// What is typed in a browser's address bar, as a browser reads it: an address opens, anything else is searched.
export function toAddress(typed: string): string {
  const t = typed.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/\S*)?$/i.test(t)) return t;
  if (/^[^\s/?#]+\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(t)) return t;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

// Lines of JSON from the bridge, until the page stops listening or the connection goes away.
function useStream(local: Local | null, table: string, path: string, on: boolean, onEvent: (e: Record<string, unknown>) => void, onLost: () => void, extra = () => "") {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const lost = useRef(onLost);
  lost.current = onLost;
  const query = useRef(extra);
  query.current = extra;
  const [down, setDown] = useState(false);
  useEffect(() => {
    if (!local || !on) return;
    const stop = new AbortController();
    let retry: ReturnType<typeof setTimeout> | null = null;
    (async function listen() {
      try {
        const res = await fetch(at(local, path, table, query.current()), { headers: { Authorization: `Bearer ${local.key}` }, signal: stop.signal });
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

// The colours a terminal draws in: Windows Terminal's own default scheme (Campbell), exactly, so PowerShell, git and
// everything else look as they do there.
const THEME = {
  background: "#0c0c0c", foreground: "#cccccc", cursor: "#ffffff", cursorAccent: "#0c0c0c", selectionBackground: "#ffffff40",
  black: "#0c0c0c", red: "#c50f1f", green: "#13a10e", yellow: "#c19c00", blue: "#0037da", magenta: "#881798", cyan: "#3a96dd", white: "#cccccc",
  brightBlack: "#767676", brightRed: "#e74856", brightGreen: "#16c60c", brightYellow: "#f9f1a5", brightBlue: "#3b78ff", brightMagenta: "#b4009e", brightCyan: "#61d6d6", brightWhite: "#f2f2f2",
};

// A real terminal (xterm.js, as in VS Code) on one of their own shells. Every key goes to the shell as typed; Ctrl+C
// with words picked copies them, Ctrl+V pastes, as in Windows Terminal.
export function TerminalPane({ local, table, id, shown, onLost, onTitle }: {
  local: Local | null; table: string; id: string; shown: boolean; onLost: () => void; onTitle?: (title: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<{ write: (s: string) => void; reset: () => void; focus: () => void; cols: number; rows: number } | null>(null);
  const fitRef = useRef<() => void>(() => {});
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const q = `&id=${encodeURIComponent(id)}`;
  const titled = useRef(onTitle);
  titled.current = onTitle;
  // Keys go out in order, gathered while one is on its way.
  const send = useRef<{ queue: string; busy: boolean }>({ queue: "", busy: false });
  const flush = useCallback(async () => {
    const s = send.current;
    if (s.busy || !s.queue || !local) return;
    s.busy = true;
    const data = s.queue;
    s.queue = "";
    try { await bridge(local, table, "/term", { data }, q); } catch (e) { console.warn("[computer] a key did not reach your terminal:", (e as Error).message); }
    s.busy = false;
    flush();
  }, [local, table, q]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let gone = false;
    let cleanup = () => {};
    (async () => {
      // Loaded here, not at the top: it reaches for the window as it loads.
      const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (gone) return;
      // A terminal draws on a grid of equal cells, so it is the one place the product uses a fixed-width face.
      const t = new XTerm({ fontFamily: "'Cascadia Mono', Consolas, 'SF Mono', Menlo, monospace", fontSize: 14, lineHeight: 1.2, cursorBlink: true, scrollback: 5000,
        theme: THEME, allowProposedApi: false });
      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(el);
      fit.fit();
      fitRef.current = () => { try { fit.fit(); } catch {} };
      t.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown" || !(e.ctrlKey || e.metaKey)) return true;
        const k = e.key.toLowerCase();
        if (k === "c" && t.hasSelection()) { navigator.clipboard.writeText(t.getSelection()).catch(() => {}); t.clearSelection(); return false; }
        if (k === "v") return false; // the browser's own paste, which xterm passes on
        return true;
      });
      const data = t.onData((d) => { send.current.queue += d; flush(); });
      const sized = t.onResize(({ cols, rows }) => { if (local) bridge(local, table, "/term/size", { cols, rows }, q).catch(() => {}); });
      const title = t.onTitleChange((s) => titled.current?.(s));
      // Only a terminal on screen is measured: a hidden one has no size, and keeps the one it had.
      const watch = new ResizeObserver(() => { if (el.offsetWidth) fitRef.current(); });
      watch.observe(el);
      term.current = t;
      setReady(true);
      cleanup = () => { watch.disconnect(); data.dispose(); sized.dispose(); title.dispose(); t.dispose(); term.current = null; };
    })();
    return () => { gone = true; cleanup(); };
  }, [local, table, flush, q]);
  // Brought in front: sized to where it now is, and typed into.
  useEffect(() => { if (shown && ready) { fitRef.current(); term.current?.focus(); } }, [shown, ready]);
  const down = useStream(local, table, "/term", ready, (e) => {
    if (typeof e.error === "string") return setError(e.error);
    setError("");
    if (e.all) term.current?.reset();
    // On Windows the shell draws through ConPTY, which the terminal is told, so lines wrap and redraw as in Windows Terminal.
    const os = e.os as { platform?: string; build?: number } | undefined;
    if (os?.platform === "win32" && term.current) (term.current as unknown as { options: { windowsPty?: object } }).options.windowsPty = { backend: "conpty", buildNumber: os.build };
    if (typeof e.data === "string") term.current?.write(e.data);
  }, onLost, () => `${q}&cols=${term.current?.cols ?? 100}&rows=${term.current?.rows ?? 30}`);
  return (
    <div className={styles.term} hidden={!shown} onMouseDown={() => setTimeout(() => term.current?.focus(), 0)}>
      <div ref={box} className={styles.termBox} data-testid="term-out" data-term={id} />
      {(down || error) && <p className={styles.termNote}>{down ? UNREACHABLE : `Your terminal could not start: ${error}`}</p>}
    </div>
  );
}

type Grab = { onPointerDown: (e: React.PointerEvent) => void; onDoubleClick: (e: React.MouseEvent) => void };
export type TerminalRun = { run: (line: string) => void };

// The terminal window's own content: as many terminals as they open, each its own shell, as tabs in its top bar (as in
// Windows Terminal). The cross on a tab ends that shell; the last one closed closes the window. Shells already running
// on their computer come back as tabs when the window opens.
export function TerminalTabs({ local, table, onLost, grab, tools, runner, onEmpty }: {
  local: Local | null; table: string; onLost: () => void; grab: Grab; tools: React.ReactNode; runner: { current: TerminalRun | null }; onEmpty: () => void;
}) {
  const [tabs, setTabs] = useState<{ id: string; title: string }[] | null>(null);
  const [active, setActive] = useState("1");
  const waiting = useRef<string[]>([]);
  useEffect(() => {
    if (!local || tabs) return;
    bridgeGet<{ id: string }[]>(local, table, "/terms")
      .then((list) => list.map((x) => x.id))
      .catch((e) => { console.warn("[computer] could not list your terminals:", (e as Error).message); return [] as string[]; })
      .then((ids) => { const all = ids.length ? ids : ["1"]; setTabs(all.map((id) => ({ id, title: "" }))); setActive(all[all.length - 1]); });
  }, [local, table, tabs]);
  const add = () => {
    const id = `t${Date.now().toString(36)}`;
    setTabs((list) => [...(list ?? []), { id, title: "" }]);
    setActive(id);
  };
  const close = (id: string) => {
    if (local) bridge(local, table, "/term/close", {}, `&id=${encodeURIComponent(id)}`).catch((e) => console.warn("[computer] the shell was not ended:", (e as Error).message));
    const rest = (tabs ?? []).filter((t) => t.id !== id);
    if (!rest.length) { onEmpty(); setTabs(null); return; }
    setTabs(rest);
    if (active === id) setActive(rest[rest.length - 1].id);
  };
  // A "!" line from the chat runs in the terminal in front.
  const runNow = useCallback((line: string) => { if (local) bridge(local, table, "/term", { line }, `&id=${encodeURIComponent(active)}`).catch((e) => console.warn("[computer] the command did not reach your terminal:", (e as Error).message)); }, [local, table, active]);
  useEffect(() => {
    runner.current = { run: (line) => (tabs ? runNow(line) : waiting.current.push(line)) };
    if (tabs) for (const line of waiting.current.splice(0)) runNow(line);
  }, [runner, runNow, tabs]);
  // Its name, as the shell sets it (a program running, a folder), with the shell's own named plainly.
  const name = (t: { title: string }, i: number) => {
    const title = t.title.replace(/^.*[\\/]/, "").trim();
    return title && !/^(windows )?(powershell|pwsh)(\.exe)?$/i.test(title) ? title : `PowerShell${i ? ` ${i + 1}` : ""}`;
  };
  return (
    <>
      <header data-head className={`${styles.head} ${styles.headDark}`} {...grab}>
        <div className={styles.ttabs} role="tablist" aria-label="Terminals">
          {(tabs ?? []).map((t, i) => (
            <div key={t.id} role="tab" aria-selected={t.id === active} className={`${styles.ttab} ${t.id === active ? styles.ttabOn : ""}`} onClick={() => setActive(t.id)} data-testid="term-tab">
              <span>{name(t, i)}</span>
              <button type="button" className={styles.ttabX} aria-label="Close this terminal" onClick={(e) => { e.stopPropagation(); close(t.id); }}>×</button>
            </div>
          ))}
          <button type="button" className={styles.ttabNew} aria-label="New terminal" title="New terminal" onClick={add} data-testid="term-new"><Plus size={15} /></button>
        </div>
        {tools}
      </header>
      <div className={styles.body}>
        {(tabs ?? []).map((t) => (
          <TerminalPane key={t.id} local={local} table={table} id={t.id} shown={t.id === active} onLost={onLost}
            onTitle={(title) => setTabs((list) => (list ?? []).map((x) => (x.id === t.id ? { ...x, title } : x)))} />
        ))}
      </div>
    </>
  );
}

type Tab = { id: string; url: string; title: string };

// Like a browser's own window: its row of tabs is the top bar it is moved by (`grab`), with its minus and cross
// (`tools`) at the end; under it the address bar, then the page. Pressing a tab, opening or closing one answers at once
// on the page; the browser on their computer follows. Each tab keeps its last picture, so switching never shows
// another tab's page on the way.
export function BrowserPane({ local, table, on, onLost, setNotice, grab, tools }: {
  local: Local | null; table: string; on: boolean; onLost: () => void; setNotice: (s: string) => void; grab?: Grab; tools?: React.ReactNode;
}) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const frames = useRef(new Map<string, string>());
  const [, drawn] = useState(0);
  const picked = useRef(0); // when this page last picked a tab itself, so the browser's word does not undo it meanwhile
  const [typed, setTyped] = useState<string | null>(null);
  const [error, setError] = useState("");
  const down = useStream(local, table, "/browser", on, (e) => {
    if (typeof e.frame === "string") {
      // A picture belongs to the tab it was drawn for (older connections do not say: then the tab in front).
      const tab = typeof e.tab === "string" ? e.tab : activeRef.current;
      if (tab) { frames.current.set(tab, e.frame); if (tab === activeRef.current) drawn((n) => n + 1); }
      setError("");
    }
    if (Array.isArray(e.tabs)) {
      const list = e.tabs as Tab[];
      setTabs(list);
      for (const id of [...frames.current.keys()]) if (!list.some((t) => t.id === id)) frames.current.delete(id);
      if (typeof e.active === "string" && Date.now() - picked.current > 800) setActive(e.active);
    }
    if (typeof e.error === "string") setError(e.error);
    if (e.closed) { frames.current.clear(); setTabs([]); }
  }, onLost);
  const activeRef = useRef(active);
  activeRef.current = active;
  const act = (body: object) => { if (local) bridge(local, table, "/browser", body).catch((e) => setNotice(`Your browser: ${(e as Error).message}`)); };
  const pick = (id: string) => { picked.current = Date.now(); setActive(id); act({ do: "tab", id }); };
  const closeTab = (id: string) => {
    const at = tabs.findIndex((t) => t.id === id);
    const rest = tabs.filter((t) => t.id !== id);
    setTabs(rest);
    if (id === active && rest.length) { picked.current = Date.now(); setActive(rest[Math.min(at, rest.length - 1)].id); }
    act({ do: "closetab", id });
  };
  const current = tabs.find((t) => t.id === active);
  const url = current?.url ?? "";
  const frame = active ? frames.current.get(active) : undefined;
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
      }, 150);
    };
    const watch = new ResizeObserver(tell);
    watch.observe(el);
    return () => { watch.disconnect(); if (timer) clearTimeout(timer); };
  }, [local, table, on, down]);
  const name = (t: Tab) => (t.title && t.title !== t.url ? t.title : t.url === "about:blank" || !t.url ? "New tab" : t.url.replace(/^https?:\/\//, ""));
  return (
    <div className={styles.browser}>
      <div className={styles.tabStrip} data-head {...grab}>
        <div className={styles.tabList} role="tablist" aria-label="Browser tabs">
          {tabs.map((t) => (
            <div key={t.id} role="tab" aria-selected={t.id === active} className={`${styles.btab} ${t.id === active ? styles.btabOn : ""}`} onMouseDown={() => pick(t.id)} title={t.url} data-testid="browser-tab">
              <span>{name(t)}</span>
              <button type="button" className={styles.btabX} aria-label="Close tab" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>×</button>
            </div>
          ))}
          <button type="button" className={styles.newTab} aria-label="New tab" title="New tab" onClick={() => act({ do: "newtab" })} data-testid="browser-newtab"><Plus size={15} /></button>
        </div>
        {tools}
      </div>
      {tabs.length > MANY_TABS && <p className={styles.many} role="status" data-testid="many-tabs">{tabs.length} tabs open. Past {MANY_TABS}, your computer may start to slow down.</p>}
      <form className={styles.bar} onSubmit={(e) => { e.preventDefault(); if (typed?.trim()) act({ do: "go", url: toAddress(typed) }); setTyped(null); (document.activeElement as HTMLElement)?.blur(); }}>
        <button type="button" className={styles.barBtn} aria-label="Back" title="Back" onClick={() => act({ do: "back" })}><BackIcon size={17} /></button>
        <button type="button" className={styles.barBtn} aria-label="Forward" title="Forward" onClick={() => act({ do: "forward" })}><ForwardIcon size={17} /></button>
        <button type="button" className={styles.barBtn} aria-label="Reload" title="Reload" onClick={() => act({ do: "reload" })}><ReloadIcon size={16} /></button>
        <input className={styles.address} value={typed ?? (url === "about:blank" ? "" : url)} onChange={(e) => setTyped(e.target.value)} onFocus={(e) => e.target.select()}
          onBlur={() => setTyped(null)} placeholder="Search Google or type an address" aria-label="Address" spellCheck={false} data-testid="browser-address" />
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
          // A new tab is the browser's own blank page, drawn dark in a dark-mode system: shown as a new tab here instead.
          : url === "about:blank" ? <div className={styles.newPage} data-testid="new-tab-page"><Globe size={34} /><span>Search Google or type an address above</span></div>
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
          ) : tabs.length ? null : <p className={styles.empty}>Starting your browser…</p>}
      </div>
    </div>
  );
}
