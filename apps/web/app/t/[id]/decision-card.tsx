"use client";

import { useState } from "react";
import { browserClient } from "@/lib/supabase/browser";
import type { Decision, Member } from "./types";
import styles from "./room.module.css";

// A decision card: the question, its options, the exact words the client will be told, one tap to decide,
// and Undo until the window closes. The window itself is enforced in the database, not here.
export function DecisionCard({ decision, chatName, members, clientName, now, onOpenChat, onChange }: {
  decision: Decision;
  chatName: string;
  members: Map<string, Member>;
  clientName: string;
  now: number;
  onOpenChat?: () => void;
  onChange: (patch: Partial<Decision>) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const d = decision;
  const open = d.status === "open";
  const options = [...d.options].sort((a, b) => a.position - b.position);
  const shown = options.find((o) => o.position === (hover ?? d.chosen ?? -1)) ?? options.find((o) => o.recommended) ?? options[0];
  const left = d.deliver_after ? Math.ceil((new Date(d.deliver_after).getTime() - now) / 1000) : 0;
  const canUndo = d.status === "decided" && !d.delivered_at && left > 0;
  const decider = d.decided_by ? members.get(d.decided_by)?.display_name ?? "Someone" : "";

  async function pick(position: number) {
    if (!open || busy) return;
    setBusy(true);
    setError("");
    const { data, error } = await browserClient().rpc("decide", { d: d.id, choice: position });
    setBusy(false);
    if (error) return setError(error.message);
    onChange({ status: "decided", chosen: position, decided_at: new Date().toISOString(), deliver_after: data as string });
  }

  async function undo() {
    setBusy(true);
    setError("");
    const { error } = await browserClient().rpc("undo_decision", { d: d.id });
    setBusy(false);
    if (error) return setError(error.message === "too late to undo" ? "Too late to undo: it has gone out." : error.message);
    onChange({ status: "open", chosen: null, decided_by: null, decided_at: null, deliver_after: null });
  }

  let after = "";
  if (d.status === "decided") {
    after = `Decided by ${decider || "you"}`;
    if (d.affects_client) after += d.delivered_at ? ` · ${clientName} has been told` : left > 0 ? ` · ${clientName} is told in ${left} s` : ` · telling ${clientName}…`;
  }

  return (
    <div className={`${styles.card} ${open ? "" : styles.cardDecided}`} data-did={d.id}>
      <button className={styles.cardOrigin} onClick={onOpenChat} disabled={!onOpenChat}>
        <span className={styles.cardChat}># {chatName}</span>
        {d.origin && <span>· {d.origin}</span>}
      </button>
      <div className={styles.cardTitle}>{d.title}</div>
      {open && d.context && <div className={styles.cardContext}>{d.context}</div>}
      <div className={styles.options}>
        {options.map((o) => {
          const chosen = d.chosen === o.position;
          return (
            <button
              key={o.position}
              className={`${styles.option} ${chosen ? styles.optionChosen : ""} ${!open && !chosen ? styles.optionFaded : ""}`}
              disabled={!open || busy}
              onClick={() => pick(o.position)}
              onMouseEnter={() => setHover(o.position)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(o.position)}
              onBlur={() => setHover(null)}
            >
              <span>{o.label}</span>
              {o.recommended && <span className={styles.optionTag}>Recommended</span>}
            </button>
          );
        })}
      </div>
      {d.affects_client && shown?.client_words && d.status !== "withdrawn" && (
        <div className={styles.clientWords}>
          <div className={styles.clientWordsLabel}>{open ? `${clientName} will be told` : `${clientName} ${d.delivered_at ? "was" : "will be"} told`}</div>
          <div className={styles.clientWordsText}>{shown.client_words}</div>
        </div>
      )}
      {d.status === "decided" && (
        <div className={styles.after}>
          <div className={styles.afterText}>{after}</div>
          {canUndo && <button className={styles.undo} onClick={undo} disabled={busy}>Undo</button>}
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
