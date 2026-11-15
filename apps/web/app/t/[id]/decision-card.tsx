"use client";

import { useEffect, useRef, useState } from "react";
import { browserClient } from "@/lib/supabase/browser";
import { fitHeight } from "@/components/text-box";
import type { Decision, Member } from "./types";
import styles from "./room.module.css";

// A decision card: the question and its options. Picking one shows what the client would be told (or the question they
// would be asked, with the answers they can tap), in words the team can change, and Send sends it at once. Nothing is
// decided until Send. A decision that tells nobody has Decide in place of Send.
export function DecisionCard({ decision, members, clientName, onChange }: {
  decision: Decision;
  members: Map<string, Member>;
  clientName: string;
  onChange: (patch: Partial<Decision>) => void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const d = decision;
  const open = d.status === "open";
  const options = [...d.options].sort((a, b) => a.position - b.position);
  const chosen = options.find((o) => o.position === (open ? picked : d.chosen));
  const decider = d.decided_by ? members.get(d.decided_by)?.display_name ?? "Someone" : "";
  const asks = !!chosen?.asks_client;

  // The words box fits what is in it.
  useEffect(() => fitHeight(box.current), [draft, picked]);

  function choose(position: number) {
    if (!open || busy) return;
    setError("");
    if (picked === position) { setPicked(null); return; }
    setPicked(position);
    setDraft(options.find((o) => o.position === position)?.client_words ?? "");
  }

  async function send() {
    if (!open || busy || picked === null) return;
    if (d.affects_client && !draft.trim()) return setError(`Write what ${clientName} will be told.`);
    setBusy(true);
    setError("");
    const words = d.affects_client ? draft.trim() : null;
    const { error } = await browserClient().rpc("decide_and_send", { d: d.id, choice: picked, words });
    setBusy(false);
    if (error) return setError(error.message);
    const at = new Date().toISOString();
    onChange({
      status: "decided", chosen: picked, decided_at: at, deliver_after: at,
      options: d.options.map((o) => (o.position === picked && words ? { ...o, client_words: words } : o)),
    });
  }

  let after = "";
  if (d.status === "decided") {
    after = `Decided by ${decider || "you"}`;
    const verb = asks ? { done: "has been asked", doing: "asking" } : { done: "has been told", doing: "telling" };
    // Once it has gone out, the words above already say who was told; only a delivery still on its way is worth a word.
    if (d.affects_client && !d.delivered_at) after += ` · ${verb.doing} ${clientName}…`;
  }

  return (
    <div className={`${styles.card} ${open ? "" : styles.cardDecided}`} data-did={d.id}>
      {d.origin && <div className={styles.cardOrigin}>{d.origin}</div>}
      <div className={styles.cardTitle}>{d.title}</div>
      {open && d.context && <div className={styles.cardContext}>{d.context}</div>}
      <div className={styles.options}>
        {options.map((o) => {
          const on = (open ? picked : d.chosen) === o.position;
          return (
            <button
              key={o.position}
              className={`${styles.option} ${on ? styles.optionChosen : ""} ${!open && !on ? styles.optionFaded : ""}`}
              disabled={!open || busy}
              aria-pressed={open ? on : undefined}
              onClick={() => choose(o.position)}
            >
              <span>{o.label}</span>
              {o.recommended && <span className={styles.optionTag}>Recommended</span>}
            </button>
          );
        })}
      </div>

      {open && chosen && (d.affects_client ? (
        <div className={`${styles.clientWords} ${styles.clientWordsEdit}`} key={chosen.position} data-testid="would-be-told">
          <label className={styles.clientWordsLabel} htmlFor={`words-${d.id}`}>{`${clientName} would be ${asks ? "asked" : "told"}`}</label>
          <textarea id={`words-${d.id}`} ref={box} className={styles.clientWordsInput} value={draft} rows={2} maxLength={2000}
            onChange={(e) => setDraft(e.target.value)} disabled={busy}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} />
          {asks && chosen.replies.length > 0 && (
            <div className={styles.replyChips}>{chosen.replies.map((r) => <span key={r} className={styles.replyChip}>{r}</span>)}</div>
          )}
          <div className={styles.sendRow}>
            <button className="btn" onClick={send} disabled={busy || !draft.trim()} data-testid="send-decision">{busy ? "Sending" : "Send"}</button>
          </div>
        </div>
      ) : (
        <div className={styles.sendRow} key={chosen.position}>
          <button className="btn" onClick={send} disabled={busy} data-testid="send-decision">{busy ? "Deciding" : "Decide"}</button>
        </div>
      ))}

      {!open && d.affects_client && chosen?.client_words && d.status !== "withdrawn" && (
        <div className={styles.clientWords}>
          <div className={styles.clientWordsLabel}>{`${clientName} ${d.delivered_at ? "was" : "will be"} ${asks ? "asked" : "told"}`}</div>
          <div className={styles.clientWordsText}>{chosen.client_words}</div>
          {asks && chosen.replies.length > 0 && (
            <div className={styles.replyChips}>{chosen.replies.map((r) => <span key={r} className={styles.replyChip}>{r}</span>)}</div>
          )}
        </div>
      )}
      {d.status === "decided" && (
        <div className={styles.after}>
          <div className={styles.afterText}>{after}</div>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
