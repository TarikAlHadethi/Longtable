"use client";

import { useEffect, useRef, useState } from "react";
import { Check } from "@/components/icons";
import menu from "@/components/select.module.css";
import styles from "./room.module.css";

// How their own full Claude Code asks before acting, the same four ways as in Claude Code. The menu is the product's
// one menu; it opens upward, since it sits under the message box.
const MODES = [
  { value: "manual", label: "Manual", about: "Asks before anything your rules don't allow" },
  { value: "acceptEdits", label: "Accept edits", about: "Changes files, asks before commands" },
  { value: "auto", label: "Auto", about: "Claude decides what is safe, asks about the rest" },
  { value: "plan", label: "Plan", about: "Reads and proposes, changes nothing" },
];

export function ModePick({ value, onPick }: { value: string; onPick: (mode: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  const current = MODES.find((m) => m.value === value) ?? MODES[0];
  return (
    <span className={styles.modePick} ref={ref}>
      <button type="button" className={styles.toolLink} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="mode-pick">
        {current.label}<span className={`${styles.modeChevron} ${open ? styles.modeChevronOpen : ""}`} aria-hidden="true" />
      </button>
      {open && (
        <div className={`${menu.menu} ${menu.menuUp} ${styles.modeMenu}`} role="listbox">
          {MODES.map((m, i) => (
            <button key={m.value} type="button" role="option" aria-selected={m.value === value} className={`${menu.item} ${styles.modeItem}`}
              style={{ "--i": i } as React.CSSProperties} onClick={() => { setOpen(false); if (m.value !== value) onPick(m.value); }}>
              <span><b>{m.label}</b><small>{m.about}</small></span>
              {m.value === value && <Check size={15} stroke={2.6} />}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
