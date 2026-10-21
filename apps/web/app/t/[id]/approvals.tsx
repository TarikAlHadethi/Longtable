"use client";

import { useState } from "react";
import type { Approval } from "./types";
import styles from "./room.module.css";

// What a person's own full Claude Code wants to do that their own rules do not already allow: Claude Code's
// permission prompt, brought to them here. Only they see it, wherever they are in the room, and only they answer.
// Allow once, always allow (that command never asks again on their computer), or deny. A question it asks them shows
// the same way, with a button for each choice and room for their own words.
export function ApprovalCards({ items, ai, onAnswer, onReply }: {
  items: Approval[];
  ai: string;
  onAnswer: (a: Approval, allow: boolean, always: boolean) => void;
  onReply: (a: Approval, words: string) => void;
}) {
  if (!items.length) return null;
  return (
    <div className={styles.asks} role="region" aria-label={`Your ${ai} is asking`} data-testid="approvals">
      {items.map((a) => a.kind === "question"
        ? <Question key={a.id} a={a} ai={ai} onReply={onReply} />
        : (
          <div key={a.id} className={`${styles.card} ${styles.ask}`} data-approval={a.id}>
            <div className={styles.cardTitle}>Your {ai} wants to {a.tool === "Bash" ? "run" : a.tool === "Edit" || a.tool === "Write" ? "change" : "use"}</div>
            {/* Why, in the words Claude wrote for it, so it can be answered without reading the command. Marked as
                Claude's own words, quieter than the command itself: the command is what would run. */}
            {a.why && <div className={styles.askWhy} data-testid="approval-why">Claude says: {a.why}</div>}
            <div className={styles.askWhat}>{a.tool === "Bash" ? a.summary : `${a.tool}${a.summary ? `: ${a.summary}` : ""}`}</div>
            <div className={styles.askRow}>
              <button className="btn" onClick={() => onAnswer(a, true, false)} data-testid="allow">Allow once</button>
              {/* Always only for one plain command, exactly as asked: never a whole tool or a pattern. */}
              {a.tool === "Bash" && /^[^*()\r\n;&|`$<>]{1,500}$/.test(a.summary.trim()) && (
                <button className="btn btn-quiet" onClick={() => onAnswer(a, true, true)} data-testid="always">Always allow</button>
              )}
              <button className="btn btn-quiet" onClick={() => onAnswer(a, false, false)} data-testid="deny">Deny</button>
            </div>
          </div>
        ))}
    </div>
  );
}

function Question({ a, ai, onReply }: { a: Approval; ai: string; onReply: (a: Approval, words: string) => void }) {
  const [own, setOwn] = useState("");
  return (
    <div className={`${styles.card} ${styles.ask}`} data-approval={a.id} data-kind="question">
      <div className={styles.cardTitle}>Your {ai} asks</div>
      <div className={styles.askQuestion}>{a.summary}</div>
      <div className={styles.askChoices}>
        {(a.options || []).map((o, i) => (
          <button key={i} className={`btn btn-quiet ${styles.askChoice}`} onClick={() => onReply(a, o.label)} data-testid="choice">
            <b>{o.label}</b>{o.about && <span>{o.about}</span>}
          </button>
        ))}
      </div>
      <form className={styles.askRow} onSubmit={(e) => { e.preventDefault(); if (own.trim()) onReply(a, own.trim()); }}>
        <input className="field" value={own} onChange={(e) => setOwn(e.target.value)} placeholder="Or say it in your own words" maxLength={2000} aria-label="Your own answer" data-testid="answer-own" />
        <button className="btn" disabled={!own.trim()}>Send</button>
      </form>
    </div>
  );
}
