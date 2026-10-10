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
  { family: "Fable", models: ["claude-fable-5"] },
  { family: "Opus", models: ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"] },
  { family: "Sonnet", models: ["claude-sonnet-5", "claude-sonnet-4-6"] },
  { family: "Haiku", models: ["claude-haiku-4-5"] },
];

type Family = { family: string; models: string[] };
// ChatGPT's models come from Codex itself, as that account sees them; each is its own line.
const familiesFor = (kind: AiKind, reported: string[]): Family[] =>
  kind === "claude" ? CLAUDE : reported.map((id) => ({ family: prettyModel(id) ?? id, models: [id] }));
// An older pick may be a family's short name ("opus"): it belongs to that family, newest model.
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
  const ref = useRef<HTMLSpanElement>(null);
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

  return (
    <span className={`${s.wrap} ${centre ? s.centre : ""}`} ref={ref}>
      <button type="button" className={`${className} ${s.pick} ${open ? s.pickOpen : ""}`} aria-haspopup="menu" aria-expanded={open}
        data-testid={testid} onClick={() => setOpen(!open)}>
        <span key={text} className={s.pickText}>{text}</span>
      </button>
      {open && (
        <div className={s.menu} role="menu" aria-label="Choose a model">
          <button type="button" role="menuitemradio" aria-checked={!value} data-model="auto" className={s.item} style={{ "--i": 0 } as React.CSSProperties}
            onMouseEnter={() => setFam(null)} onClick={() => pick("")}>
            <span>Automatic</span>
            <span className={`${s.tick} ${!value ? s.tickOn : ""}`}><Check size={15} stroke={2.6} /></span>
          </button>
          {families.map((f, i) => {
            const mine = inFamily(f, value);
            const single = f.models.length === 1 && kind !== "claude";
            const showing = fam === f.family && !single;
            return (
              <div key={f.family} className={s.row} onMouseEnter={() => setFam(f.family)}>
                <button type="button" role="menuitemradio" aria-checked={mine} aria-haspopup={single ? undefined : "menu"} aria-expanded={single ? undefined : showing}
                  data-family={f.family} className={`${s.item} ${showing ? s.itemOn : ""}`} style={{ "--i": i + 1 } as React.CSSProperties}
                  onClick={() => (single ? pick(f.models[0]) : setFam(f.family))}>
                  <span>{f.family}</span>
                  {/* The tick sits on the family until its models are showing; then it has moved over there. */}
                  <span className={`${s.tick} ${mine && !showing ? s.tickOn : ""}`}><Check size={15} stroke={2.6} /></span>
                </button>
                {showing && (
                  <div className={s.side} role="menu" aria-label={`${f.family} models`}>
                    <div className={s.sideMenu}>
                      {f.models.map((id, n) => {
                        const on = id === value || (n === 0 && mine && !f.models.includes(value));
                        return (
                          <button key={id} type="button" role="menuitemradio" aria-checked={on} data-model={id} className={s.item}
                            style={{ "--i": n } as React.CSSProperties} onClick={() => pick(id)}>
                            <span>{prettyModel(id) ?? id}</span>
                            <span className={`${s.tick} ${s.tickLate} ${on ? s.tickOn : ""}`}><Check size={15} stroke={2.6} /></span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </span>
  );
}
