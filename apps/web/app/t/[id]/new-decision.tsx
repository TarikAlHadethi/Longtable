"use client";

import { useState } from "react";
import { browserClient } from "@/lib/supabase/browser";
import styles from "./room.module.css";

type Draft = { label: string; client_words: string };

// Ask the table for a decision: the question, two to four options, which one you recommend,
// and, when the client is affected, the exact words they will be told for each option.
// From a client's request, the client always hears the answer, and the request follows the decision.
export function NewDecision({ chatId, myName, clientName, hasClient, request, onClose }: {
  chatId: string;
  myName: string;
  clientName: string;
  hasClient: boolean;
  request?: { id: string; title: string; body: string; who: string } | null;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(request?.title ?? "");
  const [context, setContext] = useState("");
  const [affects, setAffects] = useState(hasClient || !!request);
  const told = request?.who ?? clientName;
  const [options, setOptions] = useState<Draft[]>([{ label: "", client_words: "" }, { label: "", client_words: "" }]);
  const [recommended, setRecommended] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const filled = options.filter((o) => o.label.trim());
  const ready = title.trim() && filled.length >= 2 && (!affects || filled.every((o) => o.client_words.trim()));

  function set(i: number, patch: Partial<Draft>) {
    setOptions((prev) => prev.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const payload = options
      .map((o, i) => ({ ...o, recommended: i === recommended }))
      .filter((o) => o.label.trim())
      .map((o) => ({ label: o.label.trim(), recommended: o.recommended, client_words: affects ? o.client_words.trim() : "" }));
    const { error } = await browserClient().rpc("create_decision", {
      c: chatId,
      title: title.trim(),
      context: context.trim(),
      origin: request ? `requested by ${request.who}` : `from ${myName}`,
      affects_client: affects,
      options: payload,
      request: request?.id ?? null,
    });
    setBusy(false);
    if (error) return setError(error.message);
    onClose();
  }

  return (
    <div className={styles.modalBack} onClick={onClose}>
      <form className={styles.modal} onSubmit={save} onClick={(e) => e.stopPropagation()} aria-label="Ask for a decision">
        <div className={styles.modalTitle}>Ask for a decision</div>
        {request && <blockquote className={styles.asked} data-testid="asked">{request.who} asked: {request.body}</blockquote>}
        <div>
          <label className="label" htmlFor="d-title">What needs deciding?</label>
          <input id="d-title" className="field" maxLength={140} value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="Reminder channel for launch" />
        </div>
        <div>
          <label className="label" htmlFor="d-context">Anything the team should know (optional)</label>
          <textarea id="d-context" className="field" rows={2} maxLength={1000} value={context} onChange={(e) => setContext(e.target.value)} />
        </div>
        <label className={styles.toggleRow}>
          <input type="checkbox" checked={affects} disabled={!!request} onChange={(e) => setAffects(e.target.checked)} />
          <span>{told.charAt(0).toUpperCase() + told.slice(1)} hears the answer</span>
        </label>
        <div className={styles.optionEditors}>
          {options.map((o, i) => (
            <div key={i} className={styles.optionEditor}>
              <div className={styles.optionEditorTop}>
                <input className="field" maxLength={80} value={o.label} onChange={(e) => set(i, { label: e.target.value })}
                  placeholder={`Option ${i + 1}`} aria-label={`Option ${i + 1}`} />
                <label className={styles.recommend} title="Recommend this one">
                  <input type="radio" name="recommended" checked={recommended === i} onChange={() => setRecommended(i)} />
                  Recommend
                </label>
              </div>
              {affects && (
                <textarea className="field" rows={2} maxLength={1000} value={o.client_words}
                  onChange={(e) => set(i, { client_words: e.target.value })}
                  placeholder={`What ${told} will be told if this is chosen`} aria-label={`What ${told} will be told for option ${i + 1}`} />
              )}
            </div>
          ))}
        </div>
        {options.length < 4 && (
          <button type="button" className="btn btn-quiet" onClick={() => setOptions((p) => [...p, { label: "", client_words: "" }])}>
            Add an option
          </button>
        )}
        {error && <div className="error">{error}</div>}
        <div className={styles.modalActions}>
          <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={!ready || busy}>{busy ? "Adding…" : "Put it in the inbox"}</button>
        </div>
      </form>
    </div>
  );
}
