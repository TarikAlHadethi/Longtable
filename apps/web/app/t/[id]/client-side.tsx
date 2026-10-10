"use client";

import { useEffect, useRef, useState } from "react";
import { Mark } from "@/components/mark";
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

// The way through to the client's side: a small rounded square in the corner of the table, holding the client side's
// own tree in little: the client, a line, the table. Resting the pointer on it for a moment and a half shows their
// side across the middle of the room; a click goes there.
export function ClientPortal({ clients, onPeek, onEnter }: {
  clients: { id: string; display_name: string; color: string }[];
  onPeek: (on: boolean) => void;
  onEnter: () => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rest = () => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => onPeek(true), 1500); };
  const leave = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; onPeek(false); };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <button className={s.ball} aria-label="See the client's side" data-testid="client-portal"
      onMouseEnter={rest} onMouseLeave={leave} onFocus={rest} onBlur={leave} onClick={() => { leave(); onEnter(); }}>
      <span className={s.miniRow}>
        {clients.slice(0, 3).map((c) => <span key={c.id} className={s.miniFace} style={{ background: c.color }}>{c.display_name.trim().charAt(0).toUpperCase()}</span>)}
      </span>
      <span className={s.miniStem} />
      <span className={s.miniTable}><Mark size={20} /></span>
    </button>
  );
}
