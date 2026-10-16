"use client";

import { useEffect, useState } from "react";

// The Longtable mark: a table with three seats on each side, drawn to the brand's proportions.
const CLAY = "oklch(0.62 0.09 30)";
const SLATE = "oklch(0.62 0.09 250)";
const HEATHER = "oklch(0.62 0.09 310)";
const SAGE = "oklch(0.58 0.08 170)";

// live: the table lays down and the seats arrive one by one (the opening screen).
export function Mark({ size = 24, ink = "var(--table)", live = false }: { size?: number; ink?: string; live?: boolean }) {
  const s = size;
  const w = s * 0.78;
  const h = s * 0.3;
  const d = Math.max(2, s * 0.13);
  const xs = [0, 1, 2].map((i) => s * 0.28 + i * s * 0.22);
  const top = [CLAY, SLATE, HEATHER];
  const bottom = [HEATHER, SAGE, CLAY];
  const yTop = s / 2 - h / 2 - d * 1.05;
  const yBottom = s / 2 + h / 2 + d * 1.05;
  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} aria-hidden="true" focusable="false" className={live ? "mark-live" : undefined}>
      <rect x={(s - w) / 2} y={(s - h) / 2} width={w} height={h} rx={h / 2} fill={ink} />
      {xs.map((x, i) => (
        <circle key={`t${i}`} cx={x} cy={yTop} r={d / 2} fill={top[i]} style={{ "--i": i } as React.CSSProperties} />
      ))}
      {xs.map((x, i) => (
        <circle key={`b${i}`} cx={x} cy={yBottom} r={d / 2} fill={bottom[i]} style={{ "--i": i + 3 } as React.CSSProperties} />
      ))}
    </svg>
  );
}

export function Wordmark({ size = 16 }: { size?: number }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <Mark size={Math.round(size * 1.75)} />
      <span style={{ fontWeight: 600, fontSize: size, letterSpacing: "-0.01em" }}>Longtable</span>
    </span>
  );
}

// While something is being worked out (the table thinking): the mark's own opening animation, the very same one, at
// whatever size it is drawn, played again and again for as long as the work goes on.
export function WorkingMark({ size = 18 }: { size?: number }) {
  const [round, setRound] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setRound((r) => r + 1), 1800);
    return () => clearInterval(t);
  }, []);
  return <Mark key={round} size={size} live />;
}
