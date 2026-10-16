"use client";

import { useEffect, useRef } from "react";

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

// While something is being worked out (the table thinking): the Longtable loader from his design file, the very same
// animation (the six seats ride round the table clockwise, keeping their spacing, 1.5 s moving, 1 s resting), only
// scaled so its 32 by 20 box fits `size` wide.
const SEAT_COLOURS = [HEATHER, SLATE, CLAY, HEATHER, SAGE, CLAY];
const X = 6, Y = 8;
const AR = Math.PI * Y, PER = 4 * X + 2 * AR;
const HOME = [0, X, 2 * X, PER / 2, PER / 2 + X, PER / 2 + 2 * X];
const MOVE = 1500, PAUSE = 1000;
function atLen(L: number): [number, number] {
  L = ((L % PER) + PER) % PER;
  if (L < 2 * X) return [X - L, -Y];
  L -= 2 * X;
  if (L < AR) { const a = L / Y; return [-X - Y * Math.sin(a), -Y * Math.cos(a)]; }
  L -= AR;
  if (L < 2 * X) return [-X + L, Y];
  L -= 2 * X;
  const a = L / Y;
  return [X + Y * Math.sin(a), Y * Math.cos(a)];
}
const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

export function WorkingMark({ size = 18 }: { size?: number }) {
  const z = size / 32;
  const seats = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const e = now - t0, beat = MOVE + PAUSE, n = Math.floor(e / beat), r = e % beat;
      const p = n + (r < MOVE ? ease(r / MOVE) : 1);
      seats.current.forEach((el, k) => {
        if (!el) return;
        const [x, y] = atLen(HOME[k] - (p * PER) / 2);
        el.style.transform = `translate(${x * z}px,${y * z}px)`;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [z]);
  const W = 32 * z, H = 20 * z, d = 4 * z;
  return (
    <span style={{ position: "relative", display: "inline-block", width: W, height: H, flex: "none" }} data-testid="working-mark">
      <span style={{ position: "absolute", left: W / 2 - 10 * z, top: H / 2 - 4 * z, width: 20 * z, height: 8 * z, borderRadius: 4 * z, background: "var(--table)" }} />
      {SEAT_COLOURS.map((c, k) => {
        const [x, y] = atLen(HOME[k]);
        return (
          <span key={k} ref={(el) => { seats.current[k] = el; }}
            style={{ position: "absolute", left: W / 2 - d / 2, top: H / 2 - d / 2, width: d, height: d, borderRadius: "50%", background: c, transform: `translate(${x * z}px,${y * z}px)`, willChange: "transform" }} />
        );
      })}
    </span>
  );
}
