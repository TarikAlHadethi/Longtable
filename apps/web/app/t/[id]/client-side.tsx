"use client";

import { useEffect, useRef, useState } from "react";
import s from "./client-side.module.css";

// Draws its children as a page 1280 wide, shrunk or grown to fill whatever box this sits in. It is a picture of the
// page: nothing in it can be pointed at or pressed.
export function Scaled({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ k: number; h: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => { const k = el.clientWidth / 1280; if (k > 0) setBox({ k, h: el.clientHeight / k }); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className={`${s.scaled} ${className}`} aria-hidden="true" inert>
      {box && <div className={s.scaledPage} style={{ height: box.h, transform: `scale(${box.k})` }}>{children}</div>}
    </div>
  );
}

// The way through to the client's side: a small pane in the corner of the table, holding a real, very small picture of
// the client's own page. Resting the pointer on it shows that page across the middle of the room; a click goes there.
export function ClientPortal({ children, onPeek, onEnter }: { children: React.ReactNode; onPeek: (on: boolean) => void; onEnter: () => void }) {
  return (
    // Not a <button>: the picture inside holds the client page's own buttons, and a button cannot hold buttons.
    <div className={s.ball} role="button" tabIndex={0} aria-label="See the client's side" data-testid="client-portal"
      onMouseEnter={() => onPeek(true)} onMouseLeave={() => onPeek(false)} onFocus={() => onPeek(true)} onBlur={() => onPeek(false)}
      onClick={() => { onPeek(false); onEnter(); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPeek(false); onEnter(); } }}>
      <Scaled className={s.ballPage}>{children}</Scaled>
    </div>
  );
}
