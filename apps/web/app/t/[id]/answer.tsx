"use client";

import { useState } from "react";
import { Mark } from "@/components/mark";
import { Inline } from "@/lib/inline";
import { Time } from "@/components/time";
import { AI_NAME, AiLogo } from "@/components/ai-logo";
import { kindOfModel } from "./table-view";
import type { Member, Message } from "./types";
import styles from "./room.module.css";

// An answer from the table: one AI's, or one combined from several. Sources are the files it read; "How they got
// here" opens the back-room views and how they were settled.
export function Answer({ m, members, views }: { m: Message; members: Map<string, Member>; views: Message[] }) {
  const [open, setOpen] = useState(false);
  const who = members.get(m.member_id);
  const name = who?.display_name ?? "Someone";
  const parts = m.meta?.parts ?? [];
  const combined = !!m.meta?.round;
  const sources = m.meta?.sources ?? [];
  // Whose AI it is: Claude or ChatGPT, read from the model that wrote it.
  const ai = AI_NAME[kindOfModel(m.meta?.model)];
  const allSame = views.every((v) => kindOfModel(v.meta?.model) === kindOfModel(m.meta?.model));
  const many = allSame ? `${ai}s` : "AIs";

  if (m.kind === "intro") {
    return (
      <div className={styles.joined} data-mid={m.id} data-ai="intro">
        <button className={styles.joinedLine} onClick={() => setOpen(!open)} aria-expanded={open}>
          <AiLogo kind={kindOfModel(m.meta?.model)} size={15} />
          <span>{name}&apos;s {ai} joined the table</span>
          <span className={styles.joinedWhen}><Time iso={m.created_at} /></span>
          <span className={`${styles.joinedChevron} ${open ? styles.joinedOpen : ""}`} aria-hidden="true" />
        </button>
        {open && <div className={`${styles.messageText} ${styles.aiText} ${styles.joinedBody}`}><Inline text={m.body} /></div>}
      </div>
    );
  }

  return (
    <div className={`${styles.message} ${styles.aiMessage}`} data-mid={m.id} data-ai="true">
      <div className={styles.aiAvatar}>
        {combined ? <Mark size={22} /> : <AiLogo kind={kindOfModel(m.meta?.model)} size={22} />}
      </div>
      <div className={styles.messageBody}>
        <div className={styles.messageMeta}>
          <span className={styles.messageName}>{combined ? "The table" : `${name}'s ${ai}`}</span>
          {combined && <span>· one answer from {parts.length + 1} {many}, written by {name}&apos;s {ai}</span>}
          <span><Time iso={m.created_at} /></span>
          {m.meta?.read && <span className={styles.readTag}>{m.meta.read.startsWith("changed ") ? m.meta.read : `read ${m.meta.read}`}</span>}
        </div>
        <div className={`${styles.messageText} ${styles.aiText}`}><Inline text={m.body} /></div>
        {sources.length > 0 && (
          <div className={styles.sources} data-testid="sources">
            {sources.map((s) => <span key={s} className={styles.source}>{s}</span>)}
          </div>
        )}
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
