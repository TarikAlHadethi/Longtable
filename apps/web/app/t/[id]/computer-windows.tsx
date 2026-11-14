"use client";

import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { Globe, TerminalIcon } from "@/components/icons";
import { BrowserPane, TerminalPane, type Local } from "./computer";
import styles from "./computer.module.css";

// The windows of a person's own computer, like windows on a desktop: each moved by its top bar and sized from any edge,
// always wholly on the screen; dropped onto another window's top bar it joins it as a tab, and a tab dragged out of a
// window becomes a window of its own; dragged to a side of the screen it fills that half, to the top the whole. The
// minus sends a window into its icon under the message box, as on a Mac, and the icon brings it back as it was; the
// cross closes the window. Neither ends the shell or the browser: they stay on their computer for the next time.

export type Pane = "terminal" | "browser";
type Box = { x: number; y: number; w: number; h: number };
type Snap = "left" | "right" | "max";
export type Win = Box & { id: string; panes: Pane[]; active: Pane; z: number; hidden: boolean; snap: Snap | null; before: Box | null };
export type ComputerApi = { press: (p: Pane) => void; show: (p: Pane) => void };

const GAP = 8;      // the margin kept on every side
const TOP = 64;     // and below the top bar
const MIN_W = 320;
const MIN_H = 220;
const PANE = { terminal: { name: "Terminal", Icon: TerminalIcon }, browser: { name: "Browser", Icon: Globe } };

// The site scales itself up on wide screens (globals.css, --zoom), so a window's place is in the page's own units: the
// pointer's and the screen's are divided by it, or a window would run ahead of the cursor and past the edge.
export const pageZoom = () => (typeof document === "undefined" ? 1 : parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--zoom")) || 1);
const screen = () => { const z = pageZoom(); return { W: window.innerWidth / z, H: window.innerHeight / z, z }; };
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Wholly on the screen, whatever its size and the screen's.
export function inside(b: Box): Box {
  const { W, H } = screen();
  const w = clamp(b.w, Math.min(MIN_W, W - 2 * GAP), W - 2 * GAP);
  const h = clamp(b.h, Math.min(MIN_H, H - TOP - GAP), H - TOP - GAP);
  return { w, h, x: clamp(b.x, GAP, W - w - GAP), y: clamp(b.y, TOP, H - h - GAP) };
}
export function snapBox(s: Snap): Box {
  const { W, H } = screen();
  const half = (W - 3 * GAP) / 2;
  if (s === "max") return { x: GAP, y: TOP, w: W - 2 * GAP, h: H - TOP - GAP };
  return { x: s === "left" ? GAP : GAP * 2 + half, y: TOP, w: half, h: H - TOP - GAP };
}

// Where each pane's window last was on this device, so it opens there again.
const PLACES = "lt-computer-places";
function places(): Partial<Record<Pane, Box>> { try { return JSON.parse(localStorage.getItem(PLACES) || "{}") || {}; } catch { return {}; } }
function keep(w: Win) {
  if (w.snap) return;
  try { const all = places(); for (const p of w.panes) all[p] = { x: w.x, y: w.y, w: w.w, h: w.h }; localStorage.setItem(PLACES, JSON.stringify(all)); } catch {}
}
function firstPlace(p: Pane): Box {
  const saved = places()[p];
  if (saved && [saved.x, saved.y, saved.w, saved.h].every(Number.isFinite)) return inside(saved);
  const { W } = screen();
  return inside({ x: W - 660 - (p === "browser" ? 40 : 0), y: TOP + 4 + (p === "browser" ? 40 : 0), w: 640, h: p === "browser" ? 560 : 420 });
}
const nextZ = (wins: Win[]) => wins.reduce((z, w) => Math.max(z, w.z), 0) + 1;
const newId = (p: Pane) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

// The Mac's genie: the window drawn down into its icon, narrowing towards it as it goes (or back out of it). Each
// frame is a shape and a scale the browser runs on its own; nothing is computed per frame.
function genie(el: HTMLElement, pane: Pane, out: boolean): Promise<void> {
  const icon = document.querySelector(`[data-computer-icon=${pane}]`);
  const r = el.getBoundingClientRect();
  const z = pageZoom();
  if (!icon || !r.width) return el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.9)" }], { duration: 200, direction: out ? "reverse" : "normal", easing: "ease" }).finished.then(() => {});
  const i = icon.getBoundingClientRect();
  const dx = (i.left + i.width / 2 - (r.left + r.width / 2)) / z;
  const dy = (i.top + i.height / 2 - (r.top + r.height / 2)) / z;
  const at = clamp(((i.left + i.width / 2 - r.left) / r.width) * 100, 4, 96);
  const below = dy > 0;
  const narrow = (a: number, b: number) => below ? `polygon(0% 0%, 100% 0%, ${b}% 100%, ${a}% 100%)` : `polygon(${a}% 0%, ${b}% 0%, 100% 100%, 0% 100%)`;
  const frames: Keyframe[] = [
    { transform: "none", clipPath: narrow(0, 100), opacity: 1 },
    { offset: 0.42, transform: `translate(${dx * 0.12}px, ${dy * 0.32}px) scale(0.92, 0.82)`, clipPath: narrow(at - 14, at + 14), opacity: 1 },
    { transform: `translate(${dx}px, ${dy}px) scale(0.04, 0.03)`, clipPath: narrow(at - 3, at + 3), opacity: 0.25 },
  ];
  el.style.transformOrigin = "50% 50%";
  return el.animate(frames, { duration: 460, easing: "cubic-bezier(0.5, 0, 0.25, 1)", direction: out ? "reverse" : "normal" }).finished.then(() => {}, () => {});
}

type Drag = { kind: "move" | "tab" | "size"; id: string; pane?: Pane; edge?: string; sx: number; sy: number; start: Box; grabX: number };

export function ComputerWindows({ api, local, table, onLost, setNotice, onPanes }: {
  api: Ref<ComputerApi>; local: Local | null; table: string; onLost: () => void; setNotice: (s: string) => void; onPanes: (shown: Pane[]) => void;
}) {
  const [wins, setWinsState] = useState<Win[]>([]);
  const winsRef = useRef(wins);
  const setWins = useCallback((f: (w: Win[]) => Win[]) => setWinsState((all) => { const next = f(all); winsRef.current = next; return next; }), []);
  const els = useRef(new Map<string, HTMLElement>());
  const [drop, setDropState] = useState<string | null>(null);  // the window whose top bar a dragged window would join
  const [snap, setSnapState] = useState<Snap | null>(null);    // the half or whole a dragged window would fill
  const dropRef = useRef<string | null>(null);
  const snapRef = useRef<Snap | null>(null);
  const setDrop = (v: string | null) => { dropRef.current = v; setDropState(v); };
  const setSnap = (v: Snap | null) => { snapRef.current = v; setSnapState(v); };
  const appearing = useRef(new Map<string, Pane>());     // windows to bring out of their icon once drawn
  const busy = useRef(new Set<string>());                // windows in the middle of going into their icon

  useEffect(() => { onPanes(wins.filter((w) => !w.hidden).flatMap((w) => w.panes)); }, [wins, onPanes]);

  // Drawn out of the icon as soon as it is on the page.
  useLayoutEffect(() => {
    for (const [id, pane] of appearing.current) {
      const el = els.current.get(id);
      if (!el) continue;
      appearing.current.delete(id);
      genie(el, pane, true);
    }
  });

  const front = useCallback((id: string) => setWins((all) => {
    const w = all.find((x) => x.id === id);
    const z = nextZ(all);
    return w && w.z === z - 1 ? all : all.map((x) => (x.id === id ? { ...x, z } : x));
  }), [setWins]);

  const show = useCallback((pane: Pane) => {
    const all = winsRef.current;
    const w = all.find((x) => x.panes.includes(pane));
    if (w) {
      if (w.hidden) appearing.current.set(w.id, pane);
      setWins((list) => list.map((x) => (x.id === w.id ? { ...x, hidden: false, active: pane, z: nextZ(list) } : x)));
      return;
    }
    const id = newId(pane);
    appearing.current.set(id, pane);
    setWins((list) => [...list, { id, panes: [pane], active: pane, z: nextZ(list), hidden: false, snap: null, before: null, ...firstPlace(pane) }]);
  }, [setWins]);

  const minimize = useCallback((id: string) => {
    const w = winsRef.current.find((x) => x.id === id);
    const el = els.current.get(id);
    if (!w || w.hidden || busy.current.has(id)) return;
    busy.current.add(id);
    keep(w);
    (el ? genie(el, w.active, false) : Promise.resolve()).then(() => {
      busy.current.delete(id);
      setWins((list) => list.map((x) => (x.id === id ? { ...x, hidden: true } : x)));
    });
  }, [setWins]);

  const close = useCallback((id: string) => {
    const w = winsRef.current.find((x) => x.id === id);
    const el = els.current.get(id);
    if (!w || busy.current.has(id)) return;
    busy.current.add(id);
    keep(w);
    const gone = () => { busy.current.delete(id); setWins((list) => list.filter((x) => x.id !== id)); };
    if (el) el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.95)" }], { duration: 170, easing: "ease-in" }).finished.then(gone, gone);
    else gone();
  }, [setWins]);

  // The icon: brings its window out, or to the front, or onto its tab; pressed again with it in front, into the icon.
  const press = useCallback((pane: Pane) => {
    const all = winsRef.current;
    const w = all.find((x) => x.panes.includes(pane));
    if (w && !w.hidden && w.active === pane && w.z === nextZ(all) - 1) return minimize(w.id);
    show(pane);
  }, [show, minimize]);

  useImperativeHandle(api, () => ({ press, show }), [press, show]);

  // A page made smaller (a window resized, a phone turned) keeps every window on it; one filling a side keeps doing so.
  useEffect(() => {
    const fit = () => setWins((all) => all.map((w) => ({ ...w, ...(w.snap ? snapBox(w.snap) : inside(w)) })));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [setWins]);

  // Dragging: a window by its top bar, a tab out of its window, or an edge to size it.
  const drag = useRef<Drag | null>(null);
  const begin = (e: React.PointerEvent, d: Omit<Drag, "sx" | "sy" | "start" | "grabX">) => {
    if (e.button !== 0) return;
    const w = winsRef.current.find((x) => x.id === d.id);
    if (!w) return;
    e.preventDefault();
    e.stopPropagation();
    front(w.id);
    const z = pageZoom();
    drag.current = { ...d, sx: e.clientX, sy: e.clientY, start: { x: w.x, y: w.y, w: w.w, h: w.h }, grabX: (e.clientX / z - w.x) / w.w };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };
  const headUnder = (cx: number, cy: number, not: string) => {
    for (const w of [...winsRef.current].sort((a, b) => b.z - a.z)) {
      if (w.id === not || w.hidden) continue;
      const r = els.current.get(w.id)?.querySelector("[data-head]")?.getBoundingClientRect();
      if (r && cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return w.id;
    }
    return null;
  };
  const move = (m: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const { z, W } = screen();
    const dx = (m.clientX - d.sx) / z, dy = (m.clientY - d.sy) / z;
    const w = winsRef.current.find((x) => x.id === d.id);
    if (!w) return;
    if (d.kind === "size") {
      const b = { ...d.start };
      if (d.edge!.includes("e")) b.w = d.start.w + dx;
      if (d.edge!.includes("s")) b.h = d.start.h + dy;
      if (d.edge!.includes("w")) { b.w = d.start.w - dx; b.x = d.start.x + dx; }
      if (d.edge!.includes("n")) { b.h = d.start.h - dy; b.y = d.start.y + dy; }
      b.w = Math.max(MIN_W, b.w);
      b.h = Math.max(MIN_H, b.h);
      if (d.edge!.includes("w")) b.x = d.start.x + d.start.w - b.w;
      if (d.edge!.includes("n")) b.y = d.start.y + d.start.h - b.h;
      return setWins((all) => all.map((x) => (x.id === d.id ? { ...x, ...inside(b), snap: null, before: null } : x)));
    }
    // A tab pulled out of its window's top bar (with another tab left behind) becomes a window of its own, under the
    // pointer, and is carried on from there.
    if (d.kind === "tab") {
      if (Math.abs(dy) < 28 / z || w.panes.length < 2) {
        if (Math.hypot(dx, dy) > 6 && w.panes.length < 2) d.kind = "move";
        else return;
      } else {
        const id = newId(d.pane!);
        const size = { w: w.w, h: w.h };
        const at = inside({ x: m.clientX / z - Math.min(120, size.w / 2), y: m.clientY / z - 18, ...size });
        setWins((all) => [...all.map((x) => (x.id === w.id ? { ...x, panes: x.panes.filter((p) => p !== d.pane), active: x.panes.find((p) => p !== d.pane)! } : x)),
          { id, panes: [d.pane!], active: d.pane!, z: nextZ(all), hidden: false, snap: null, before: null, ...at }]);
        drag.current = { kind: "move", id, sx: m.clientX, sy: m.clientY, start: at, grabX: (m.clientX / z - at.x) / at.w };
        return;
      }
    }
    // Moving: a window filling a side first goes back to its own size, still under the pointer where it was held.
    let start = d.start;
    if (w.snap && Math.hypot(dx, dy) > 4) {
      const was = w.before ?? { ...start, w: Math.min(640, start.w), h: Math.min(480, start.h) };
      start = { ...was, x: m.clientX / z - was.w * d.grabX, y: start.y };
      drag.current = { ...d, sx: m.clientX, sy: m.clientY, start };
      setWins((all) => all.map((x) => (x.id === w.id ? { ...x, ...inside(start), snap: null, before: null } : x)));
      return;
    }
    const target = headUnder(m.clientX, m.clientY, w.id);
    setDrop(target);
    const near = m.clientY / z < TOP + 2 ? "max" : m.clientX / z < 6 ? "left" : m.clientX / z > W - 6 ? "right" : null;
    setSnap(target ? null : near);
    setWins((all) => all.map((x) => (x.id === w.id ? { ...x, ...inside({ ...start, x: start.x + dx, y: start.y + dy }) } : x)));
  };
  const up = () => {
    window.removeEventListener("pointermove", onMove);
    const d = drag.current;
    drag.current = null;
    const target = dropRef.current;
    const s = snapRef.current;
    setDrop(null);
    setSnap(null);
    if (!d) return;
    const w = winsRef.current.find((x) => x.id === d.id);
    if (!w) return;
    // Dropped on another window's top bar: its tabs join that window.
    if (d.kind === "move" && target) {
      setWins((all) => all.filter((x) => x.id !== w.id).map((x) => (x.id === target ? { ...x, panes: [...x.panes, ...w.panes.filter((p) => !x.panes.includes(p))], active: w.active, z: nextZ(all) } : x)));
      const head = els.current.get(target)?.querySelector("[data-head]");
      head?.animate([{ background: "var(--chip)" }, { background: "transparent" }], { duration: 420, easing: "ease-out" });
      return;
    }
    if (d.kind === "move" && s) {
      setWins((all) => all.map((x) => (x.id === w.id ? { ...x, ...snapBox(s), snap: s, before: { x: d.start.x, y: d.start.y, w: d.start.w, h: d.start.h } } : x)));
      return;
    }
    keep(w);
  };
  // The listeners stay the same for a whole drag while what they call is always this drawing's.
  const handlers = useRef({ move, up });
  handlers.current = { move, up };
  const [{ onMove, onUp }] = useState(() => ({ onMove: (e: PointerEvent) => handlers.current.move(e), onUp: () => handlers.current.up() }));
  useEffect(() => () => window.removeEventListener("pointermove", onMove), [onMove]);

  // Double-click on the top bar: fill the screen, or back to its own size.
  const toggleMax = (w: Win) => setWins((all) => all.map((x) => (x.id !== w.id ? x : w.snap ? { ...x, ...inside(w.before ?? firstPlace(w.active)), snap: null, before: null }
    : { ...x, ...snapBox("max"), snap: "max", before: { x: w.x, y: w.y, w: w.w, h: w.h } })));

  return (
    <>
      {snap && (() => { const b = snapBox(snap); return <div className={styles.snapPreview} style={{ left: b.x, top: b.y, width: b.w, height: b.h }} aria-hidden="true" data-testid="snap-preview" />; })()}
      {wins.map((win) => (
        // Stacked by their order only (41 and up), so they always sit under the top bar and its menus (46), and under the
        // icons that bring them back, which stay reachable like a dock.
        <section key={win.id} ref={(el) => { if (el) els.current.set(win.id, el); else els.current.delete(win.id); }}
          className={`${styles.window} ${win.snap ? styles.snapped : ""}`}
          style={{ left: win.x, top: win.y, width: win.w, height: win.h, zIndex: 41 + wins.filter((x) => x.z < win.z).length, visibility: win.hidden ? "hidden" : undefined, pointerEvents: win.hidden ? "none" : undefined }}
          onPointerDownCapture={() => front(win.id)} aria-label="Your computer" aria-hidden={win.hidden || undefined}
          data-testid="computer-window" data-panes={win.panes.join(" ")} data-hidden={win.hidden || undefined} data-snap={win.snap ?? undefined}>
          <header data-head className={`${styles.head} ${drop === win.id ? styles.headDrop : ""}`}
            onPointerDown={(e) => { if (!(e.target as HTMLElement).closest("button,[role=tab]")) begin(e, { kind: "move", id: win.id }); }}
            onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest("button,[role=tab]")) toggleMax(win); }}>
            {win.panes.length > 1 ? (
              <div className={styles.tabs} role="tablist">
                {win.panes.map((p) => {
                  const { name, Icon } = PANE[p];
                  return (
                    <div key={p} role="tab" aria-selected={win.active === p} aria-label={name} title={name}
                      className={`${styles.tab} ${win.active === p ? styles.tabOn : ""}`}
                      onClick={() => setWins((all) => all.map((x) => (x.id === win.id ? { ...x, active: p } : x)))}
                      onPointerDown={(e) => begin(e, { kind: "tab", id: win.id, pane: p })} data-testid={`tab-${p}`}>
                      <Icon size={16} />
                    </div>
                  );
                })}
              </div>
            ) : <span />}
            <div className={styles.headTools}>
              <button type="button" className={styles.headBtn} onClick={() => minimize(win.id)} aria-label="Minimize" title="Minimize" data-testid="minimize"><span className={styles.minus} /></button>
              <button type="button" className={styles.headBtn} onClick={() => close(win.id)} aria-label="Close" title="Close" data-testid="close-window">×</button>
            </div>
          </header>
          {/* Every pane stays drawn while its window is open, so switching tabs keeps it as it was. */}
          {win.panes.map((p) => (
            <div key={p} className={`${styles.body} ${win.active === p ? styles.bodyOn : ""}`} aria-hidden={win.active !== p || undefined}>
              {p === "terminal" ? <TerminalPane local={local} table={table} onLost={onLost} />
                : <BrowserPane local={local} table={table} on={!win.hidden && win.active === p} onLost={onLost} setNotice={setNotice} />}
            </div>
          ))}
          {!win.hidden && ["n", "s", "e", "w", "ne", "nw", "se", "sw"].map((edge) => (
            <div key={edge} className={`${styles.edge} ${styles[`edge_${edge}`]}`} onPointerDown={(e) => begin(e, { kind: "size", id: win.id, edge })} aria-hidden="true" />
          ))}
        </section>
      ))}
    </>
  );
}
