"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

// Shows something designed for a wide screen exactly as it looks there, scaled down to fit a narrower one (his words,
// 17 Oct 2026: "a sized down version of the desktop to the phone"). Wide enough, it is left exactly as it is.
// It is drawn at its full width and shrunk as a picture (a transform), never re-laid out, so every browser shows the
// same thing: iPhone Safari lays CSS zoom out differently and squeezed the text.
export function Fit({ width, children }: { width: number; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  const [tall, setTall] = useState(0);
  useEffect(() => {
    const el = box.current;
    const kid = inner.current;
    if (!el || !kid) return;
    const ro = new ResizeObserver(() => { setRoom(el.clientWidth); setTall(kid.offsetHeight); });
    ro.observe(el);
    ro.observe(kid);
    return () => ro.disconnect();
  }, []);
  const scale = room > 0 && room < width * 0.98 ? room / width : 1;
  // One tree whatever the size, so what is inside never starts over when the screen turns.
  const small = scale < 1;
  return (
    <div ref={box} style={small ? { width: "100%", height: tall * scale, position: "relative" } : { width: "100%", display: "flex", justifyContent: "center" }}>
      <div ref={inner} style={small
        ? { position: "absolute", left: 0, top: 0, width, transform: `scale(${scale})`, transformOrigin: "top left", display: "flex", justifyContent: "center" }
        : { width: "100%", display: "flex", justifyContent: "center" }}>
        {children}
      </div>
    </div>
  );
}
