"use client";

import { useState } from "react";
import { Mark } from "@/components/mark";
import { Inline, Prose } from "@/lib/inline";
import { Time } from "@/components/time";
import { AI_NAME, AiLogo } from "@/components/ai-logo";
import { kindOfModel } from "./table-view";
import type { Member, Message, Page } from "./types";
import { PageCard } from "./page-window";
import styles from "./room.module.css";

// An answer from the table: one AI's, or one combined from several. Every answer speaks as the table; whose AI wrote
// it is in the small print. Sources are the files it read; "How they got here" opens the back-room views.
export function Answer({ m, members, views, again, follows = false, pages = [], onOpenPage }: { m: Message; members: Map<string, Member>; views: Message[]; again?: boolean; follows?: boolean; pages?: Page[]; onOpenPage?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const who = members.get(m.member_id);
  const name = who?.display_name ?? "Someone";
  const parts = m.meta?.parts ?? [];
  const combined = !!m.meta?.round;
  // The table speaking for itself: its quick word, with no code read and nobody's own AI behind it.
  const quick = m.meta?.part === "reply";
  const byOne = !combined && !quick;
  const sources = m.meta?.sources ?? [];
  // Whose AI it is: Claude or ChatGPT, read from the model that wrote it.
  const ai = AI_NAME[kindOfModel(m.meta?.model)];
  const allSame = views.every((v) => kindOfModel(v.meta?.model) === kindOfModel(m.meta?.model));
  const many = allSame ? `${ai}s` : "AIs";

  // An AI arriving is one quiet line between two rules. What it learned of the project is kept for the AIs, not shown.
  if (m.kind === "intro") {
    // It arrived once. Connecting again later is not said again.
    if (again) return null;
    return (
      <div className={styles.joined} data-mid={m.id} data-ai="intro">
        <AiLogo kind={kindOfModel(m.meta?.model)} size={15} />
        <span>{name}&apos;s {ai} joined the table</span>
      </div>
    );
  }
  const read = m.meta?.read ?? "";
  const changed = read.startsWith("changed ");

  return (
    <div className={`${styles.message} ${styles.aiMessage} ${follows ? styles.follow : ""}`} data-mid={m.id} data-ai="true" data-follows={follows || undefined}>
      <div className={`${styles.aiAvatar} ${follows ? styles.unseen : ""}`} aria-hidden={follows || undefined}>
        <Mark size={22} />
      </div>
      <div className={styles.messageBody}>
        {!follows && (
          <div className={styles.messageMeta}>
            <span className={styles.messageName}>The table</span>
          </div>
        )}
        <div className={`${styles.messageText} ${styles.aiText}`}><Prose text={m.body} /></div>
        {pages.map((p) => <PageCard key={p.id} page={p} onOpen={() => onOpenPage?.(p.id)} />)}
        {/* The small print: when, what it read, where a change went. There when you point at the answer. */}
        <div className={styles.aiFoot} data-open={open || undefined}>
          <span><Time iso={m.created_at} /></span>
          {byOne && <span>by {name}&apos;s {ai}</span>}
          {combined && <span>one answer from {parts.length + 1} {many}, written by {name}&apos;s {ai}</span>}
          {changed && <span>{read}</span>}
          {sources.length > 0 && (
            <span className={styles.footSources} data-testid="sources">
              read {sources.slice(0, 4).map((src) => <span key={src}>{src}</span>)}{sources.length > 4 ? ` and ${sources.length - 4} more` : ""}
            </span>
          )}
          {read && !changed && <span>{read}</span>}
        </div>
        {combined && (
          <div className={styles.how}>
            <button className={styles.toolLink} onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? "Hide how they got here" : "How they got here"}
            </button>
            {open && (
              <div className={styles.howBody} data-testid="how">
                {m.meta?.how && <p className={styles.howText}><Inline text={m.meta.how} /></p>}
                {views.map((v) => {
                  const vw = members.get(v.member_id);
                  return (
                    <div key={v.id} className={styles.view}>
                      <div className={styles.viewHead}>
                        <span className={styles.viewDot} style={{ background: vw?.color ?? "var(--faint)" }} />
                        {vw?.display_name ?? "Someone"}&apos;s {AI_NAME[kindOfModel(v.meta?.model)]}
                        {v.meta?.part === "work" ? <span className={styles.viewConfidence}>{v.meta.changed ? "did the work" : "worked on it"}</span>
                          : v.meta?.part === "review" ? <span className={styles.viewConfidence}>{v.meta.ok === false ? "found a problem" : "looked it over"}</span>
                          : v.meta?.confidence && <span className={styles.viewConfidence}>{v.meta.confidence} confidence</span>}
                      </div>
                      <div className={styles.viewText}><Inline text={v.body} /></div>
                      {(v.meta?.sources ?? []).length > 0 && (
                        <div className={styles.sources}>{(v.meta?.sources ?? []).map((s) => <span key={s} className={styles.source}>{s}</span>)}</div>
                      )}
                    </div>
                  );
                })}
                {views.length === 0 && <div className="note">No views came in, so {name}&apos;s {ai} answered alone.</div>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
