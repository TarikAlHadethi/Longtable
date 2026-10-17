"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

// Shows something designed for a wide screen exactly as it looks there, scaled down to fit a narrower one (his words,
// 17 Oct 2026: "a sized down version of the desktop to the phone"). Wide enough, it is left exactly as it is.
export function Fit({ width, children }: { width: number; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRoom(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = room > 0 && room < width * 0.98 ? room / width : 1;
  return (
    <div ref={box} style={{ width: "100%", display: "flex", justifyContent: "center" }}>
      <div style={scale < 1 ? { width, flexShrink: 0, zoom: scale, display: "flex", justifyContent: "center" } : { width: "100%", display: "flex", justifyContent: "center" }}>
        {children}
      </div>
    </div>
  );
}
