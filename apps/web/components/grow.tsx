"use client";

import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

// A box that eases to its content's new height whenever the content changes (a step swapping for the next, a note
// appearing), instead of jumping. Nothing is static (his rule): use it wherever what is inside changes size.
export function Grow({ children, className }: { children: ReactNode; className?: string }) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const measure = () => setHeight(el.getBoundingClientRect().height);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className={className} style={{ height: height ?? undefined, overflow: "hidden", transition: "height 0.35s var(--ease-out)", margin: "0 -6px", padding: "0 6px" }}>
      <div ref={inner}>{children}</div>
    </div>
  );
}
