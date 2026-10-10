"use client";

import { useEffect, useRef, useState } from "react";

// Children rise into place the first time they scroll into view. `delay` staggers siblings.
export function Reveal({ children, delay = 0, className = "" }: { children: React.ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  // Once it has arrived, drop the reveal classes so the element's own hover motion is not slowed or delayed.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!seen) return;
    const t = setTimeout(() => setSettled(true), delay + 800);
    return () => clearTimeout(t);
  }, [seen, delay]);
  return (
    <div ref={ref} className={settled ? className : `reveal ${seen ? "reveal-in" : ""} ${className}`} style={settled ? undefined : { transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}
