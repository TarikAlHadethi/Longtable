"use client";

import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { TerminalTabs, type Local, type TerminalRun } from "./computer";
import styles from "./computer.module.css";

// The terminal's window on a person's own computer, like a window on a desktop: moved by its top bar and sized from any
// edge, always wholly on the screen and clear of the icon that brings it back. Dragged to a side of the screen it fills
// that half, to the top the whole screen. The minus sends it into its icon under the message box, as on a Mac, and the
// icon brings it back as it was; the cross closes it. Neither ends its shells: they stay on their computer.

export type Pane = "terminal";
type Box = { x: number; y: number; w: number; h: number };
type Snap = "left" | "right" | "max";
type Win = Box & { pane: Pane; z: number; hidden: boolean; snap: Snap | null; before: Box | null };
export type ComputerApi = { press: (p: Pane) => void; show: (p: Pane) => void; run: (line: string) => void };

const GAP = 8;      // the margin kept on every side
const TOP = 64;     // and below the top bar
const MIN_W = 320;
const MIN_H = 200;

// The site scales itself up on wide screens (globals.css, --zoom), so a window's place is in the page's own units: the
// pointer's and the screen's are divided by it, or a window would run ahead of the cursor and past the edge.
export const pageZoom = () => (typeof document === "undefined" ? 1 : parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--zoom")) || 1);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
// The room a window has: the screen below the top bar, and above the icons under the message box when they are there.
function room() {
  const z = pageZoom();
  const W = window.innerWidth / z, H = window.innerHeight / z;
  const icon = document.querySelector("[data-computer-icon]")?.getBoundingClientRect();
  const floor = icon && icon.top > 0 ? Math.min(H - GAP, icon.top / z - GAP) : H - GAP;
  return { W, H, z, floor: Math.max(TOP + MIN_H, floor) };
}

// Wholly in its room, whatever its size and the screen's.
export function inside(b: Box): Box {
  const { W, floor } = room();
  const w = clamp(b.w, Math.min(MIN_W, W - 2 * GAP), W - 2 * GAP);
  const h = clamp(b.h, Math.min(MIN_H, floor - TOP), floor - TOP);
  return { w, h, x: clamp(b.x, GAP, W - w - GAP), y: clamp(b.y, TOP, floor - h) };
}
// Where a window filling a side goes.
function snapped(snap: Snap): Box {
  const { W, floor } = room();
  if (snap === "max") return { x: GAP, y: TOP, w: W - 2 * GAP, h: floor - TOP };
  const w = (W - 3 * GAP) / 2;
  return { x: snap === "left" ? GAP : GAP * 2 + w, y: TOP, w, h: floor - TOP };
}
const boxOf = (w: Win): Box => (w.snap ? snapped(w.snap) : w);

// Where each window last was on this device, so it opens there again.
const PLACES = "lt-computer-places";
function places(): Partial<Record<Pane, Box>> { try { return JSON.parse(localStorage.getItem(PLACES) || "{}") || {}; } catch { return {}; } }
function keep(w: Win) {
  if (w.snap) return;
  try { localStorage.setItem(PLACES, JSON.stringify({ ...places(), [w.pane]: { x: w.x, y: w.y, w: w.w, h: w.h } })); } catch {}
}
function firstPlace(p: Pane): Box {
  const saved = places()[p];
  if (saved && [saved.x, saved.y, saved.w, saved.h].every(Number.isFinite)) return inside(saved);
  const { W } = room();
  return inside({ x: W - 680, y: TOP + 6, w: 660, h: 420 });
}
const nextZ = (wins: Win[]) => wins.reduce((z, w) => Math.max(z, w.z), 0) + 1;

// The Mac's genie: the window drawn down into its icon, narrowing towards it as it goes (or back out of it). Each frame
// is a shape and a scale the browser runs on its own, and the last one is held until the window is put away, so nothing
// flashes back at full size in between.
function genie(el: HTMLElement, pane: Pane, out: boolean): Animation {
  const icon = document.querySelector(`[data-computer-icon=${pane}]`);
  const r = el.getBoundingClientRect();
  const z = pageZoom();
  if (!icon || !r.width) {
    return el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.94)" }], { duration: 200, direction: out ? "reverse" : "normal", easing: "ease", fill: "both" });
  }
  const i = icon.getBoundingClientRect();
  const dx = (i.left + i.width / 2 - (r.left + r.width / 2)) / z;
  const dy = (i.top + i.height / 2 - (r.top + r.height / 2)) / z;
  const at = clamp(((i.left + i.width / 2 - r.left) / r.width) * 100, 4, 96);
  const narrow = (a: number, b: number) => (dy > 0 ? `polygon(0% 0%, 100% 0%, ${b}% 100%, ${a}% 100%)` : `polygon(${a}% 0%, ${b}% 0%, 100% 100%, 0% 100%)`);
  return el.animate([
    { transform: "none", clipPath: narrow(0, 100), opacity: 1 },
    { offset: 0.4, transform: `translate(${dx * 0.1}px, ${dy * 0.3}px) scale(0.94, 0.84)`, clipPath: narrow(at - 18, at + 18), opacity: 1 },
    { transform: `translate(${dx}px, ${dy}px) scale(0.04, 0.03)`, clipPath: narrow(at - 3, at + 3), opacity: 0.2 },
  ], { duration: 440, easing: "cubic-bezier(0.5, 0, 0.25, 1)", direction: out ? "reverse" : "normal", fill: "both" });
}

type Drag = { kind: "move" | "size"; pane: Pane; edge?: string; sx: number; sy: number; start: Box; grabX: number };

export function ComputerWindows({ api, local, table, onLost, onPanes }: {
  api: Ref<ComputerApi>; local: Local | null; table: string; onLost: () => void; onPanes: (shown: Pane[]) => void;
}) {
  const [wins, setWinsState] = useState<Win[]>([]);
  const winsRef = useRef(wins);
  const setWins = useCallback((f: (w: Win[]) => Win[]) => setWinsState((all) => { const next = f(all); winsRef.current = next; return next; }), []);
  const els = useRef(new Map<Pane, HTMLElement>());
  const anims = useRef(new Map<Pane, Animation>()); // the genie last run on each window, held at its end
  const appearing = useRef(new Set<Pane>());         // windows to bring out of their icon once drawn
  const busy = useRef(new Set<Pane>());              // windows on their way into their icon or closing
  const [preview, setPreviewState] = useState<Box | null>(null);
  const previewSnap = useRef<Snap | null>(null);
  const [easing, setEasing] = useState<Pane | null>(null); // a window gliding to a side, or back from one

  useEffect(() => { onPanes(wins.filter((w) => !w.hidden).map((w) => w.pane)); }, [wins, onPanes]);

  // Drawn out of the icon as soon as it is on the page.
  useLayoutEffect(() => {
    for (const pane of appearing.current) {
      const el = els.current.get(pane);
      if (!el) continue;
      appearing.current.delete(pane);
      anims.current.get(pane)?.cancel();
      const a = genie(el, pane, true);
      anims.current.set(pane, a);
      a.finished.then(() => { if (anims.current.get(pane) === a) { a.cancel(); anims.current.delete(pane); } }, () => {});
    }
  });

  const glide = (pane: Pane) => { setEasing(pane); setTimeout(() => setEasing((e) => (e === pane ? null : e)), 260); };
  const front = useCallback((pane: Pane) => setWins((all) => {
    const z = nextZ(all);
    return all.find((x) => x.pane === pane)?.z === z - 1 ? all : all.map((x) => (x.pane === pane ? { ...x, z } : x));
  }), [setWins]);

  const show = useCallback((pane: Pane) => {
    const w = winsRef.current.find((x) => x.pane === pane);
    if (w && !w.hidden) return front(pane);
    appearing.current.add(pane);
    if (w) setWins((all) => all.map((x) => (x.pane === pane ? { ...x, hidden: false, z: nextZ(all) } : x)));
    else setWins((all) => [...all, { pane, z: nextZ(all), hidden: false, snap: null, before: null, ...firstPlace(pane) }]);
  }, [front, setWins]);

  const away = useCallback((pane: Pane, close: boolean) => {
    const w = winsRef.current.find((x) => x.pane === pane);
    const el = els.current.get(pane);
    if (!w || (w.hidden && !close) || busy.current.has(pane)) return;
    busy.current.add(pane);
    keep(w);
    anims.current.get(pane)?.cancel();
    const a = el && !w.hidden ? (close ? el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.95)" }], { duration: 170, easing: "ease-in", fill: "both" }) : genie(el, pane, false)) : null;
    if (a) anims.current.set(pane, a);
    const done = () => {
      busy.current.delete(pane);
      setWins((all) => (close ? all.filter((x) => x.pane !== pane) : all.map((x) => (x.pane === pane ? { ...x, hidden: true } : x))));
    };
    if (a) a.finished.then(done, done); else done();
  }, [setWins]);

  // The icon: brings its window out or to the front; pressed again with it in front, back into the icon.
  const press = useCallback((pane: Pane) => {
    const all = winsRef.current;
    const w = all.find((x) => x.pane === pane);
    if (w && !w.hidden && w.z === nextZ(all) - 1) return away(pane, false);
    show(pane);
  }, [show, away]);

  // A "!" line from the chat: the terminal brought out, and the line run in the terminal in front (once it is drawn).
  const runner = useRef<TerminalRun | null>(null);
  const pending = useRef<string[]>([]);
  const run = useCallback((line: string) => {
    show("terminal");
    if (runner.current) runner.current.run(line); else pending.current.push(line);
  }, [show]);
  useEffect(() => { if (runner.current) for (const line of pending.current.splice(0)) runner.current.run(line); });

  useImperativeHandle(api, () => ({ press, show, run }), [press, show, run]);

  // A screen made smaller (a window resized, a phone turned) keeps every window in its room.
  useEffect(() => {
    const fit = () => setWins((all) => all.map((w) => ({ ...w, ...inside(w) })));
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [setWins]);

  // Dragging a window by its top bar, or an edge to size it. While it lasts nothing on the page is picked as text.
  const drag = useRef<Drag | null>(null);
  const begin = (e: React.PointerEvent, pane: Pane, kind: Drag["kind"], edge?: string) => {
    if (e.button !== 0) return;
    const w = winsRef.current.find((x) => x.pane === pane);
    if (!w) return;
    e.preventDefault();
    front(pane);
    const z = pageZoom();
    const b = boxOf(w);
    drag.current = { kind, pane, edge, sx: e.clientX, sy: e.clientY, start: b, grabX: (e.clientX / z - b.x) / b.w };
    document.documentElement.classList.add(styles.dragging);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };
  const setPreview = (s: Snap | null) => {
    previewSnap.current = s;
    setPreviewState(s ? snapped(s) : null);
  };
  const move = (m: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const { z, W } = room();
    const dx = (m.clientX - d.sx) / z, dy = (m.clientY - d.sy) / z;
    const w = winsRef.current.find((x) => x.pane === d.pane);
    if (!w) return;
    if (d.kind === "size") {
      const b = { ...d.start };
      // Each edge stops at its own wall; the opposite side stays where it is.
      const { floor } = room();
      if (d.edge!.includes("e")) b.w = clamp(d.start.w + dx, MIN_W, W - GAP - d.start.x);
      if (d.edge!.includes("s")) b.h = clamp(d.start.h + dy, MIN_H, floor - d.start.y);
      if (d.edge!.includes("w")) { b.w = clamp(d.start.w - dx, MIN_W, d.start.x + d.start.w - GAP); b.x = d.start.x + d.start.w - b.w; }
      if (d.edge!.includes("n")) { b.h = clamp(d.start.h - dy, MIN_H, d.start.y + d.start.h - TOP); b.y = d.start.y + d.start.h - b.h; }
      return setWins((all) => all.map((x) => (x.pane === d.pane ? { ...x, ...inside(b), snap: null, before: null } : x)));
    }
    // A window filling a side first goes back to its own size, still under the pointer where it was held.
    if (w.snap) {
      if (Math.hypot(dx, dy) < 6) return;
      const was = w.before ?? { ...d.start, w: Math.min(660, d.start.w), h: Math.min(480, d.start.h) };
      const start = { ...was, x: m.clientX / z - was.w * d.grabX, y: d.start.y };
      drag.current = { ...d, sx: m.clientX, sy: m.clientY, start };
      setWins((all) => all.map((x) => (x.pane === w.pane ? { ...x, ...inside(start), snap: null, before: null } : x)));
      return;
    }
    const near: Snap | null = m.clientY / z < TOP + 2 ? "max" : m.clientX / z < 6 ? "left" : m.clientX / z > W - 6 ? "right" : null;
    if (near !== previewSnap.current) setPreview(near);
    setWins((all) => all.map((x) => (x.pane === w.pane ? { ...x, ...inside({ ...d.start, x: d.start.x + dx, y: d.start.y + dy }) } : x)));
  };
  const up = () => {
    window.removeEventListener("pointermove", onMove);
    document.documentElement.classList.remove(styles.dragging);
    const d = drag.current;
    drag.current = null;
    const s = previewSnap.current;
    setPreview(null);
    if (!d) return;
    const w = winsRef.current.find((x) => x.pane === d.pane);
    if (!w) return;
    if (d.kind === "move" && s) {
      glide(w.pane);
      setWins((all) => all.map((x) => (x.pane === w.pane ? { ...x, snap: s, before: { x: d.start.x, y: d.start.y, w: d.start.w, h: d.start.h } } : x)));
      return;
    }
    keep(w);
  };
  // The listeners stay the same for a whole drag while what they call is always this drawing's.
  const handlers = useRef({ move, up });
  handlers.current = { move, up };
  const [{ onMove, onUp }] = useState(() => ({ onMove: (e: PointerEvent) => handlers.current.move(e), onUp: () => handlers.current.up() }));
  useEffect(() => () => { window.removeEventListener("pointermove", onMove); document.documentElement.classList.remove(styles.dragging); }, [onMove]);

  // Double-click on the top bar: fill the screen, or back to its own size.
  const toggleMax = (pane: Pane) => {
    glide(pane);
    setWins((all) => all.map((x) => (x.pane !== pane ? x : x.snap ? { ...x, ...inside(x.before ?? firstPlace(pane)), snap: null, before: null }
      : { ...x, snap: "max", before: { x: x.x, y: x.y, w: x.w, h: x.h } })));
  };

  return (
    <>
      {preview && <div className={styles.snapPreview} style={{ left: preview.x, top: preview.y, width: preview.w, height: preview.h }} aria-hidden="true" data-testid="snap-preview" />}
      {wins.map((win) => {
        const b = boxOf(win);
        // What moves it: its top bar, where it is not a tab or a button.
        const grab = {
          onPointerDown: (e: React.PointerEvent) => { if (!(e.target as HTMLElement).closest("button,[role=tab],input")) begin(e, win.pane, "move"); },
          onDoubleClick: (e: React.MouseEvent) => { if (!(e.target as HTMLElement).closest("button,[role=tab],input")) toggleMax(win.pane); },
        };
        const tools = (
          <div className={styles.headTools}>
            <button type="button" className={styles.headBtn} onClick={() => away(win.pane, false)} aria-label="Minimize" title="Minimize" data-testid="minimize"><span className={styles.minus} /></button>
            <button type="button" className={styles.headBtn} onClick={() => away(win.pane, true)} aria-label="Close" title="Close" data-testid="close-window">×</button>
          </div>
        );
        return (
          // Stacked by their order only (41 and up), so they always sit under the top bar and its menus (46).
          <section key={win.pane} ref={(el) => { if (el) els.current.set(win.pane, el); else els.current.delete(win.pane); }}
            className={`${styles.window} ${win.pane === "terminal" ? styles.windowDark : ""} ${easing === win.pane ? styles.easing : ""}`}
            style={{ left: b.x, top: b.y, width: b.w, height: b.h, zIndex: 41 + wins.filter((x) => x.z < win.z).length, visibility: win.hidden ? "hidden" : undefined, pointerEvents: win.hidden ? "none" : undefined }}
            onPointerDownCapture={() => front(win.pane)} aria-label="Terminal" aria-hidden={win.hidden || undefined}
            data-testid="computer-window" data-pane={win.pane} data-hidden={win.hidden || undefined} data-snap={win.snap ?? undefined}>
            <TerminalTabs local={local} table={table} onLost={onLost} grab={grab} tools={tools} runner={runner} onEmpty={() => away("terminal", true)} />
            {!win.hidden && ["n", "s", "e", "w", "ne", "nw", "se", "sw"].map((edge) => (
              <div key={edge} className={`${styles.edge} ${styles[`edge_${edge}`]}`} onPointerDown={(e) => begin(e, win.pane, "size", edge)} aria-hidden="true" />
            ))}
          </section>
        );
      })}
    </>
  );
}
