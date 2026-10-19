"use client";

import type { Approval } from "./types";
import styles from "./room.module.css";

// What a person's own full Claude Code wants to do that their own rules do not already allow: Claude Code's
// permission prompt, brought to them here. Only they see it, wherever they are in the room, and only they answer.
// Allow once, always allow (that command never asks again on their computer), or deny.
export function ApprovalCards({ items, ai, onAnswer }: { items: Approval[]; ai: string; onAnswer: (a: Approval, allow: boolean, always: boolean) => void }) {
  if (!items.length) return null;
  return (
    <div className={styles.asks} role="region" aria-label={`Your ${ai} is asking`} data-testid="approvals">
      {items.map((a) => (
        <div key={a.id} className={`${styles.card} ${styles.ask}`} data-approval={a.id}>
          <div className={styles.cardTitle}>Your {ai} wants to {a.tool === "Bash" ? "run" : a.tool === "Edit" || a.tool === "Write" ? "change" : "use"}</div>
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
