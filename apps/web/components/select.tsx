"use client";

import { useEffect, useRef, useState } from "react";
import { Check } from "@/components/icons";
import s from "./select.module.css";

export type Option = { value: string; label: string };

// One dropdown for the whole product: a box showing the choice, and a menu drawn the same way as every other menu
// here. The browser's own <select> stays in the page, unseen, holding the value: forms, labels and screen readers
// keep working, and it is what the list is built from.
export function Select({ id, value, options, onChange, label }: {
  id?: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  const current = options.find((o) => o.value === value) ?? options[0];

  return (
    <div className={s.wrap} ref={ref}>
      <select id={id} className={s.native} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} tabIndex={-1}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <button type="button" className={`${s.box} ${open ? s.boxOpen : ""}`} aria-haspopup="listbox" aria-expanded={open}
        onClick={() => {
          if (!open && ref.current) setUp(window.innerHeight - ref.current.getBoundingClientRect().bottom < Math.min(280, options.length * 39 + 30));
          setOpen(!open);
        }}>
        <span className={s.value}>{current?.label}</span>
        <span className={`${s.chevron} ${open ? s.chevronOpen : ""}`} aria-hidden="true" />
      </button>
      {open && (
        <div className={`${s.menu} ${up ? s.menuUp : ""}`} role="listbox">
          {options.map((o, i) => (
            <button key={o.value} type="button" role="option" aria-selected={o.value === value} className={s.item}
              style={{ "--i": i } as React.CSSProperties} onClick={() => { setOpen(false); if (o.value !== value) onChange(o.value); }}>
              <span>{o.label}</span>
              {o.value === value && <Check size={15} stroke={2.6} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
