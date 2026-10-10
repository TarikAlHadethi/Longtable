// Icons are drawn, never typed. A "+" or a tick typed as text sits wherever its font puts it, which is never the
// middle of a circle; a drawn one is centred by its own box. Use these wherever a mark sits inside a shape.
type Props = { size?: number; stroke?: number };

function Svg({ size = 16, stroke = 2, children }: Props & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={{ display: "block", flexShrink: 0 }}>
      {children}
    </svg>
  );
}

export const Plus = (p: Props) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>;
export const Check = (p: Props) => <Svg {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>;
export const Arrow = (p: Props) => <Svg {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Svg>;
export const Gear = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
  </Svg>
);
export const Gauge = (p: Props) => <Svg {...p}><path d="M4 16a8 8 0 1 1 16 0" /><path d="M12 16l4-5" /></Svg>;
export const SignOut = (p: Props) => <Svg {...p}><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" /><path d="M10 8l-4 4 4 4M6 12h9" /></Svg>;
export const Sun = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M5.2 18.8l1.4-1.4M17.4 6.6l1.4-1.4" />
  </Svg>
);
export const Moon = (p: Props) => <Svg {...p}><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.500 10.500z" /></Svg>;

// The owner's crown: one plain gold shape. It is placed behind the picture it sits on, so the picture's own edge cuts
// across its base and the two always meet all the way round.
export const Crown = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 20" aria-hidden="true" focusable="false" style={{ display: "block", flexShrink: 0, overflow: "visible" }}>
    <path d="M3 20 1.800 5.600a.700.700 0 0 1 1.130-.640L7.400 8.400 11.380 2.300a.740.740 0 0 1 1.240 0L16.600 8.400l4.470-3.440a.700.700 0 0 1 1.130.640L21 20z" fill="OKLCH(0.8 0.15 85)" />
  </svg>
);
export const Plug = (p: Props) => <Svg {...p}><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0V8zM12 17v4" /></Svg>;
export const Dots = (p: Props) => <Svg {...p} stroke={3}><path d="M5 12h.01M12 12h.01M19 12h.01" /></Svg>;
export const Pencil = (p: Props) => <Svg {...p}><path d="M4 20l1-4.500L16.500 4a2 2 0 0 1 2.800 0l.700.700a2 2 0 0 1 0 2.800L8.500 19 4 20z" /><path d="M14.500 6l3.500 3.500" /></Svg>;
export const Trash = (p: Props) => <Svg {...p}><path d="M4 7h16M9 7V4.500h6V7M6.500 7l.800 12a1.500 1.500 0 0 0 1.500 1.400h6.400a1.500 1.500 0 0 0 1.500-1.400l.800-12M10 11v6M14 11v6" /></Svg>;
