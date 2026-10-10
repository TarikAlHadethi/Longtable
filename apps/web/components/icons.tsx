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

// The owner's crown: three points with a pearl on each, a band with a stone, in shaded gold. It is worn a little
// crooked by whoever places it.
export const Crown = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 28" aria-hidden="true" focusable="false" style={{ display: "block", flexShrink: 0, overflow: "visible" }}>
    <defs>
      <linearGradient id="lt-crown-gold" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#FFE9A3" />
        <stop offset="0.45" stopColor="#F4C24B" />
        <stop offset="1" stopColor="#C98A1B" />
      </linearGradient>
      <linearGradient id="lt-crown-band" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#E9B13A" />
        <stop offset="1" stopColor="#A86E12" />
      </linearGradient>
    </defs>
    <path d="M4.2 21.5 2.6 8.9c-.1-.7.7-1.1 1.2-.7l6 4.8c.4.3 1 .2 1.200-.2l4.200-8.300c.3-.6 1.200-.6 1.500 0l4.200 8.300c.2.4.800.5 1.200.2l6-4.800c.5-.4 1.300 0 1.200.7l-1.600 12.600z"
      fill="url(#lt-crown-gold)" stroke="#9A640F" strokeWidth="1" strokeLinejoin="round" />
    <rect x="4" y="21" width="24" height="4.600" rx="1.600" fill="url(#lt-crown-band)" stroke="#9A640F" strokeWidth="1" />
    <circle cx="2.900" cy="7.600" r="1.900" fill="#FFF3C9" stroke="#9A640F" strokeWidth="0.900" />
    <circle cx="16" cy="3.300" r="2.100" fill="#FFF3C9" stroke="#9A640F" strokeWidth="0.900" />
    <circle cx="29.100" cy="7.600" r="1.900" fill="#FFF3C9" stroke="#9A640F" strokeWidth="0.900" />
    <circle cx="16" cy="23.300" r="1.300" fill="#D8524A" />
    <path d="M8 18.500c2.500-.9 5.200-1.300 8-1.300" fill="none" stroke="#FFF6D6" strokeWidth="0.900" strokeLinecap="round" opacity="0.700" />
  </svg>
);
export const Plug = (p: Props) => <Svg {...p}><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0V8zM12 17v4" /></Svg>;
