"use client";

import { useEffect, useRef, useState } from "react";
import type { AiKind } from "@/components/ai-logo";
import { Check } from "@/components/icons";
import s from "./model-pick.module.css";

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

// "claude-opus-5-5" reads as "Opus 5.5", "opus" as "Opus"; anything unfamiliar is shown as it came.
export function prettyModel(model?: string | null): string | null {
  if (!model || /default/i.test(model)) return null;
  const name = model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  const m = name.match(/^([a-z]+)-(\d+)(?:-(\d+))?$/);
  if (m) return `${cap(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
  return /^[a-z]+$/.test(name) ? cap(name) : model;
}

// Claude's models by family, newest first. Claude Code does not say which of them a person's plan may use, so this
// list is kept by hand; picking one a plan lacks makes that answer fail with a plain message.
const CLAUDE: { family: string; models: string[] }[] = [
  { family: "Fable", models: ["claude-fable-5-1", "claude-fable-5"] },
  { family: "Opus", models: ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"] },
  { family: "Sonnet", models: ["claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6"] },
  { family: "Haiku", models: ["claude-haiku-5-5", "claude-haiku-4-5"] },
];

type Family = { family: string; models: string[] };
// ChatGPT's models come from Codex itself, as that account sees them; each is its own line.
const familiesFor = (kind: AiKind, reported: string[]): Family[] =>
  kind === "claude" ? CLAUDE : reported.map((id) => ({ family: prettyModel(id) ?? id, models: [id] }));
// An older pick may be a family's short name ("opus"): it belongs to that family, newest model.
// Room the list and a side menu can need below the words.
const MENU_ROOM = 270;
const inFamily = (f: Family, value: string) => !!value && (f.models.includes(value) || f.family.toLowerCase() === value.toLowerCase());

// The model an AI runs, as words. For someone who may change it, the words gain a soft box the moment the pointer is
// over them; a click opens the families, and resting on a family opens its models beside it.
export function ModelPick({ kind, value, text, reported = [], className, canPick, centre = false, testid = "model-pick", onPick }: {
  kind: AiKind;
  value: string;
  text: string;
  reported?: string[];
  className: string;
  canPick: boolean;
  centre?: boolean;
  testid?: string;
  onPick: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [fam, setFam] = useState<string | null>(null);
  // The menu opens downward when there is room under the words, and upward when there is not, so it never makes
  // the page grow a scrollbar.
  const [up, setUp] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const rows = useRef<Record<string, HTMLDivElement | null>>({});
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  useEffect(() => { if (!open) setFam(null); }, [open]);

  const families = familiesFor(kind, reported);
  if (!canPick || families.length === 0) return <div className={className} key={text}>{text}</div>;
  const pick = (model: string) => { setOpen(false); if (model !== value) onPick(model); };

  const active = families.find((f) => f.family === fam && !(f.models.length === 1 && kind !== "claude"));
  const activeMine = !!active && inFamily(active, value);
  // One side menu for the whole list: it glides to the family the pointer is on and takes that family's height,
  // instead of closing and opening again.
  const ITEM = 37, GAP = 2, PAD = 6;
  const rowTop = active ? rows.current[active.family]?.offsetTop ?? 0 : 0;
  const sideHeight = active ? active.models.length * ITEM + (active.models.length - 1) * GAP + PAD * 2 + 2 : 0;

  // The side menu starts level with its family, but never hangs below the list it belongs to.
  const listHeight = (families.length + 1) * ITEM + families.length * GAP + PAD * 2 + 2;
  const sideTop = Math.max(-1, Math.min(rowTop - PAD - 1, listHeight - sideHeight - 1));

  return (
    <span className={`${s.wrap} ${centre ? s.centre : ""}`} ref={ref}>
      <button type="button" className={`${className} ${s.pick} ${open ? s.pickOpen : ""}`} aria-haspopup="menu" aria-expanded={open}
        data-testid={testid} onClick={() => {
          if (!open && ref.current) setUp(window.innerHeight - ref.current.getBoundingClientRect().bottom < MENU_ROOM);
          setOpen(!open);
        }}>
        <span key={text} className={s.pickText}>{text}</span>
      </button>
      {open && (
        <div className={`${s.menu} ${up ? s.menuUp : ""}`} role="menu" aria-label="Choose a model">
          <button type="button" role="menuitemradio" aria-checked={!value} data-model="auto" className={s.item} style={{ "--i": 0 } as React.CSSProperties}
            onMouseEnter={() => setFam(null)} onClick={() => pick("")}>
            <span>Automatic</span>
            <span className={`${s.tick} ${!value ? s.tickOn : ""}`}><Check size={15} stroke={2.6} /></span>
          </button>
          {families.map((f, i) => {
            const mine = inFamily(f, value);
            const single = f.models.length === 1 && kind !== "claude";
            const showing = active?.family === f.family;
            return (
              <div key={f.family} className={s.row} ref={(el) => { rows.current[f.family] = el; }} onMouseEnter={() => setFam(f.family)}>
                <button type="button" role="menuitemradio" aria-checked={mine} aria-haspopup={single ? undefined : "menu"} aria-expanded={single ? undefined : showing}
                  data-family={f.family} className={`${s.item} ${showing ? s.itemOn : ""}`} style={{ "--i": i + 1 } as React.CSSProperties}
                  onClick={() => (single ? pick(f.models[0]) : setFam(f.family))}>
                  <span>{f.family}</span>
                  {/* The tick sits on the family until its models are showing; then it has moved over there. */}
                  <span className={`${s.tick} ${mine && !showing ? s.tickOn : ""}`}><Check size={15} stroke={2.6} /></span>
                </button>
              </div>
            );
          })}
          {active && (
            <div className={s.side} style={{ "--top": `${sideTop}px` } as React.CSSProperties}>
              <div className={s.sideMenu} role="menu" aria-label={`${active.family} models`} style={{ height: sideHeight }}>
                <div className={s.sideList} key={active.family}>
                  {active.models.map((id, n) => {
                    const on = id === value || (n === 0 && activeMine && !active.models.includes(value));
                    return (
                      <button key={id} type="button" role="menuitemradio" aria-checked={on} data-model={id} className={s.item} onClick={() => pick(id)}>
                        <span>{prettyModel(id) ?? id}</span>
                        <span className={`${s.tick} ${on ? s.tickOn : ""}`}><Check size={15} stroke={2.6} /></span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </span>
  );
}
