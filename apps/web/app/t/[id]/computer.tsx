"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import "@xterm/xterm/css/xterm.css";
import { Globe, TerminalIcon } from "@/components/icons";
import styles from "./computer.module.css";

// The person's own computer, from their own page: a terminal and a browser served by their connection's bridge on that
// computer (packages/connect/src/local.mjs). The page talks to it directly on 127.0.0.1, so what is typed here, a
// password included, never passes through Longtable. Longtable only hands this person where it listens and its key
// (`my_local`), and only while their AI runs as their full Claude Code.
// Each is its own window, moved by its top bar and sized from its corner; two windows can be put together as tabs of
// one, and a tab taken back out into its own window.

export type Local = { port: number; key: string };
export type Pane = "terminal" | "browser";
export type Win = { id: string; panes: Pane[]; active: Pane; x: number; y: number; w: number; h: number; z: number };

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

export async function bridge(local: Local, table: string, path: string, body: object) {
  const res = await fetch(at(local, path, table), { method: "POST", headers: { Authorization: `Bearer ${local.key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `your computer said no (${res.status})`);
  return out as { ok?: boolean };
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

// A real terminal (xterm.js, as in VS Code) on their own shell. Every key goes to the shell as typed; Ctrl+C with
// words picked copies them, Ctrl+V pastes, as in Windows Terminal.
function Terminal({ local, table, onLost }: { local: Local | null; table: string; onLost: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<{ write: (s: string) => void; reset: () => void; cols: number; rows: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  // Keys go out in order, gathered while one is on its way.
  const send = useRef<{ queue: string; busy: boolean }>({ queue: "", busy: false });
  const flush = useCallback(async () => {
    const s = send.current;
    if (s.busy || !s.queue || !local) return;
    s.busy = true;
    const data = s.queue;
    s.queue = "";
    try { await bridge(local, table, "/term", { data }); } catch (e) { console.warn("[computer] a key did not reach your terminal:", (e as Error).message); }
    s.busy = false;
    flush();
  }, [local, table]);
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
      const t = new XTerm({ fontFamily: "'Cascadia Mono', Consolas, 'SF Mono', Menlo, monospace", fontSize: 13.5, lineHeight: 1.15, cursorBlink: true, scrollback: 5000,
        theme: { background: "#14211e", foreground: "#e6e4df", cursor: "#8fd1b9", selectionBackground: "#35534b" } });
      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(el);
      fit.fit();
      t.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown" || !(e.ctrlKey || e.metaKey)) return true;
        const k = e.key.toLowerCase();
        if (k === "c" && t.hasSelection()) { navigator.clipboard.writeText(t.getSelection()).catch(() => {}); t.clearSelection(); return false; }
        if (k === "v") return false; // the browser's own paste, which xterm passes on
        return true;
      });
      const data = t.onData((d) => { send.current.queue += d; flush(); });
      const sized = t.onResize(({ cols, rows }) => { if (local) bridge(local, table, "/term/size", { cols, rows }).catch(() => {}); });
      const watch = new ResizeObserver(() => { try { fit.fit(); } catch {} });
      watch.observe(el);
      term.current = t;
      setReady(true);
      t.focus();
      cleanup = () => { watch.disconnect(); data.dispose(); sized.dispose(); t.dispose(); term.current = null; };
    })();
    return () => { gone = true; cleanup(); };
  }, [local, table, flush]);
  const down = useStream(local, table, "/term", ready, (e) => {
    if (typeof e.error === "string") return setError(e.error);
    setError("");
    if (e.all) term.current?.reset();
    if (typeof e.data === "string") term.current?.write(e.data);
  }, onLost, () => `&cols=${term.current?.cols ?? 100}&rows=${term.current?.rows ?? 30}`);
  return (
    <div className={styles.term} onMouseDown={() => setTimeout(() => (box.current?.querySelector("textarea") as HTMLTextAreaElement | null)?.focus(), 0)}>
      <div ref={box} className={styles.termBox} data-testid="term-out" />
      {(down || error) && <p className={styles.termNote}>{down ? UNREACHABLE : `Your terminal could not start: ${error}`}</p>}
    </div>
  );
}

type Tab = { id: string; url: string; title: string };

function Browser({ local, table, on, onLost, setNotice }: { local: Local | null; table: string; on: boolean; onLost: () => void; setNotice: (s: string) => void }) {
  const [frame, setFrame] = useState("");
  const [url, setUrl] = useState("");
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const [error, setError] = useState("");
  const down = useStream(local, table, "/browser", on, (e) => {
    if (typeof e.frame === "string") { setFrame(e.frame); setError(""); }
    if (typeof e.url === "string") setUrl(e.url);
    if (Array.isArray(e.tabs)) { setTabs(e.tabs as Tab[]); setActive((e.active as string) ?? null); }
    if (typeof e.error === "string") setError(e.error);
    if (e.closed) { setFrame(""); setTabs([]); }
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
  const name = (t: Tab) => t.title && t.title !== t.url ? t.title : t.url === "about:blank" || !t.url ? "New tab" : t.url.replace(/^https?:\/\//, "");
  return (
    <div className={styles.browser}>
      <div className={styles.tabStrip} role="tablist" aria-label="Browser tabs">
        {tabs.map((t) => (
          <div key={t.id} role="tab" aria-selected={t.id === active} className={`${styles.btab} ${t.id === active ? styles.btabOn : ""}`} onClick={() => act({ do: "tab", id: t.id })} title={t.url} data-testid="browser-tab">
            <span>{name(t)}</span>
            <button type="button" className={styles.btabX} aria-label="Close tab" onClick={(e) => { e.stopPropagation(); act({ do: "closetab", id: t.id }); }}>×</button>
          </div>
        ))}
        <button type="button" className={styles.newTab} aria-label="New tab" onClick={() => act({ do: "newtab" })} data-testid="browser-newtab">+</button>
      </div>
      {tabs.length > MANY_TABS && <p className={styles.many} role="status" data-testid="many-tabs">{tabs.length} tabs open. Past {MANY_TABS}, your computer may start to slow down.</p>}
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

// Where each kind of window last was on this device, so it opens there again.
const placeKey = (p: Pane) => `lt-computer-${p}`;
function savedPlace(p: Pane) {
  try { const v = JSON.parse(localStorage.getItem(placeKey(p)) || "null"); if (v && [v.x, v.y, v.w, v.h].every(Number.isFinite)) return v as Pick<Win, "x" | "y" | "w" | "h">; } catch {}
  return null;
}
function keepPlace(w: Win) {
  try { localStorage.setItem(placeKey(w.panes[0]), JSON.stringify({ x: w.x, y: w.y, w: w.w, h: w.h })); } catch {}
}
// Kept on the screen, whatever size it now is.
function onScreen<T extends Pick<Win, "x" | "y" | "w" | "h">>(v: T): T {
  const W = window.innerWidth, H = window.innerHeight;
  const w = Math.min(v.w, W - 16), h = Math.min(v.h, H - 72);
  return { ...v, w, h, x: Math.max(8, Math.min(v.x, W - w - 8)), y: Math.max(60, Math.min(v.y, H - 48)) };
}
const top = (wins: Win[]) => wins.reduce((z, w) => Math.max(z, w.z), 0) + 1;

// Show a pane: brought to the front where it already is, else in a window of its own where it last was.
export function openPane(wins: Win[], pane: Pane): Win[] {
  const z = top(wins);
  if (wins.some((w) => w.panes.includes(pane))) return wins.map((w) => (w.panes.includes(pane) ? { ...w, active: pane, z } : w));
  const W = typeof window === "undefined" ? 1200 : window.innerWidth;
  const first = { x: W - 660 - (pane === "browser" ? 40 : 0), y: 68 + (pane === "browser" ? 40 : 0), w: 640, h: pane === "browser" ? 560 : 420 };
  return [...wins, { id: `${pane}-${Date.now()}`, panes: [pane], active: pane, z, ...onScreen(savedPlace(pane) ?? first) }];
}
// The icon under the box: opens it, or closes it when it is already in front.
export function togglePane(wins: Win[], pane: Pane): Win[] {
  const w = wins.find((x) => x.panes.includes(pane));
  return w && w.active === pane && w.z === top(wins) - 1 ? dropPane(wins, pane) : openPane(wins, pane);
}
function dropPane(wins: Win[], pane: Pane): Win[] {
  return wins.flatMap((w) => {
    if (!w.panes.includes(pane)) return [w];
    const panes = w.panes.filter((p) => p !== pane);
    return panes.length ? [{ ...w, panes, active: panes[0] }] : [];
  });
}

const PANE = { terminal: { name: "Terminal", Icon: TerminalIcon }, browser: { name: "Browser", Icon: Globe } };

function Window({ win, wins, setWins, children }: {
  win: Win; wins: Win[]; setWins: (f: (w: Win[]) => Win[]) => void; children: React.ReactNode;
}) {
  const box = useRef<HTMLElement>(null);
  const update = useCallback((patch: Partial<Win>) => setWins((all) => all.map((w) => (w.id === win.id ? { ...w, ...patch } : w))), [setWins, win.id]);
  const front = () => { if (win.z !== top(wins) - 1) update({ z: top(wins) }); };
  // Moved by its top bar.
  const drag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button") || e.button !== 0) return;
    e.preventDefault();
    const sx = e.clientX - win.x, sy = e.clientY - win.y;
    const move = (m: PointerEvent) => update(onScreen({ x: m.clientX - sx, y: m.clientY - sy, w: win.w, h: win.h }));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  // Sized from its corner (the browser's own handle); the size is kept.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const watch = new ResizeObserver(() => {
      const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
      if (Math.abs(w - win.w) > 2 || Math.abs(h - win.h) > 2) update({ w, h });
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, [win.w, win.h, update]);
  useEffect(() => { keepPlace(win); }, [win]);
  const others = wins.filter((w) => w.id !== win.id);
  // Put together: this window's tabs join the other window. Taken apart: a tab gets a window of its own beside it.
  const combine = () => setWins((all) => {
    const into = others.reduce((a, b) => (b.z > a.z ? b : a));
    return all.filter((w) => w.id !== win.id).map((w) => (w.id === into.id ? { ...w, panes: [...w.panes, ...win.panes], active: win.active, z: top(all) } : w));
  });
  const separate = (p: Pane) => setWins((all) => [...all.map((w) => (w.id === win.id ? { ...w, panes: w.panes.filter((x) => x !== p), active: w.panes.find((x) => x !== p)! } : w)),
    { id: `${p}-${Date.now()}`, panes: [p], active: p, z: top(all), ...onScreen({ x: win.x - 40, y: win.y + 40, w: win.w, h: win.h }) }]);
  return (
    <section ref={box} className={styles.window} style={{ left: win.x, top: win.y, width: win.w, height: win.h, zIndex: 40 + win.z }}
      onPointerDownCapture={front} aria-label={win.panes.map((p) => PANE[p].name).join(" and ")} data-testid={`window-${win.panes.join("-")}`}>
      <header className={styles.head} onPointerDown={drag}>
        <div className={styles.tabs} role="tablist">
          {win.panes.map((p) => {
            const { name, Icon } = PANE[p];
            return (
              <div key={p} role="tab" aria-selected={win.active === p} className={`${styles.tab} ${win.active === p ? styles.tabOn : ""}`}
                onClick={() => update({ active: p })} data-testid={`tab-${p}`}>
                <Icon size={15} />{name}
                {win.panes.length > 1 && <button type="button" className={styles.tabOut} aria-label={`Take ${name} into its own window`} title="Its own window" onClick={(e) => { e.stopPropagation(); separate(p); }} data-testid={`separate-${p}`}>↗</button>}
              </div>
            );
          })}
        </div>
        <div className={styles.headTools}>
          {others.length > 0 && <button type="button" className={styles.headBtn} onClick={combine} aria-label="Put together in one window" title="Put together in one window" data-testid="combine">⧉</button>}
          <button type="button" className={styles.headBtn} onClick={() => setWins((all) => all.filter((w) => w.id !== win.id))} aria-label="Close" data-testid="close-window">×</button>
        </div>
      </header>
      {children}
    </section>
  );
}

export function ComputerWindows({ wins, setWins, local, table, onLost, setNotice }: {
  wins: Win[]; setWins: (f: (w: Win[]) => Win[]) => void; local: Local | null; table: string; onLost: () => void; setNotice: (s: string) => void;
}) {
  // A page made smaller (a window resized, a phone turned) keeps every window on it.
  useEffect(() => {
    const fit = () => setWins((all) => all.map((w) => ({ ...w, ...onScreen(w) })));
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [setWins]);
  // Closing the terminal, however it is closed, ends its shell, as closing a terminal app does.
  const terminalOpen = wins.some((w) => w.panes.includes("terminal"));
  const wasOpen = useRef(terminalOpen);
  useEffect(() => {
    if (wasOpen.current && !terminalOpen && local) bridge(local, table, "/term/stop", {}).catch((e) => console.warn("[computer] the shell was not ended:", (e as Error).message));
    wasOpen.current = terminalOpen;
  }, [terminalOpen, local, table]);
  return (
    <>
      {wins.map((win) => (
        <Window key={win.id} win={win} wins={wins} setWins={setWins}>
          {/* Every pane stays mounted while its window is open, so switching tabs keeps it as it was. */}
          {win.panes.map((p) => (
            <div key={p} hidden={win.active !== p} className={styles.body}>
              {p === "terminal" ? <Terminal local={local} table={table} onLost={onLost} />
                : <Browser local={local} table={table} on={win.active === p} onLost={onLost} setNotice={setNotice} />}
            </div>
          ))}
        </Window>
      ))}
    </>
  );
}
