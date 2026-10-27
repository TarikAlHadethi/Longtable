"use client";

import { useEffect, useState } from "react";
import { Select } from "@/components/select";
import { Time } from "@/components/time";
import { browserClient } from "@/lib/supabase/browser";
import { firstName } from "@/lib/names";
import { Switch } from "../seat-windows";
import panels from "../panels.module.css";
import styles from "./settings.module.css";

export type Join = { id: string; name: string; email: string; note: string; created_at: string };

// People who typed in the table's code and wait for an owner: who they say they are, the address they signed in
// with (a name can be anyone's, the address is theirs), and Let in as a developer or a client, or No.
export function AskingToJoin({ joins, onAnswered }: { joins: Join[]; onAnswered: (id: string) => void }) {
  const supabase = browserClient();
  const [roles, setRoles] = useState<Record<string, "developer" | "client">>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  if (joins.length === 0) return null;

  async function answer(j: Join, in_: boolean) {
    setBusy(j.id);
    setError("");
    const { error } = await supabase.rpc("answer_join", { r: j.id, let_in: in_, as_role: roles[j.id] ?? "developer" });
    setBusy(null);
    if (error) return setError(error.message);
    onAnswered(j.id);
  }

  return (
    <section className={`${styles.card} ${styles.asking}`} aria-label="Asking to join" data-testid="asking-to-join">
      <div className={styles.cardTitle}>Asking to join</div>
      {error && <div className="error" role="alert">{error}</div>}
      {joins.map((j) => (
        <div key={j.id} className={styles.joiner} data-joiner={j.name}>
          <div className={styles.joinerHead}>
            <span className={styles.joinerFace}>{j.name.trim().charAt(0).toUpperCase()}</span>
            <span className={styles.joinerWho}>
              <b>{j.name}</b>
              <span>{j.email || "No email"} · <Time iso={j.created_at} style="when" /></span>
            </span>
          </div>
          {j.note && <div className={styles.joinerNote}>&ldquo;{j.note}&rdquo;</div>}
          <div className={styles.rowActions}>
            <span className={styles.joinerAs}>
              <Select value={roles[j.id] ?? "developer"} onChange={(v) => setRoles((r) => ({ ...r, [j.id]: v as "developer" | "client" }))}
                options={[{ value: "developer", label: "As a developer" }, { value: "client", label: "As a client" }]} label={`What ${firstName(j.name)} joins as`} />
            </span>
            <button className="btn" disabled={busy === j.id} onClick={() => answer(j, true)} data-testid="let-in">Let {firstName(j.name)} in</button>
            <button className={styles.quietLink} disabled={busy === j.id} onClick={() => answer(j, false)} data-testid="say-no">No</button>
          </div>
        </div>
      ))}
    </section>
  );
}

// The table's code and the lock. The code is hidden until asked for, so it is not on screen whenever Settings is
// open; a new one makes the old one stop working at once.
export function Joining({ tableId }: { tableId: string }) {
  const supabase = browserClient();
  const [state, setState] = useState<{ code: string; locked: boolean } | null>(null);
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.rpc("joining", { t: tableId });
      if (cancelled) return;
      if (error || !data) return setError("The table code could not be read just now.");
      setState(data as { code: string; locked: boolean });
    })();
    return () => { cancelled = true; };
  }, [supabase, tableId]);

  async function lock(on: boolean) {
    if (!state) return;
    setError("");
    setState({ ...state, locked: on });
    const { error } = await supabase.rpc("set_table_locked", { t: tableId, on_: on });
    if (error) { setState({ ...state, locked: !on }); setError("That did not save. Try again."); }
  }
  async function renew() {
    setError("");
    const { data, error } = await supabase.rpc("new_join_code", { t: tableId });
    if (error || !data || !state) return setError(error?.message ?? "Something went wrong. Try again.");
    setState({ ...state, code: data as string });
    setShown(true);
    setFresh(true);
    setTimeout(() => setFresh(false), 2400);
  }
  async function copy() {
    if (!state) return;
    try {
      await navigator.clipboard.writeText(`${state.code.slice(0, 4)}-${state.code.slice(4)}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (e) {
      console.warn("[copy]", (e as Error).name);
    }
  }

  const code = state ? `${state.code.slice(0, 4)}-${state.code.slice(4)}` : "";
  return (
    <section className={styles.card} aria-label="Joining" data-testid="joining">
      <div className={styles.cardTitle}>Joining</div>
      {error && <div className="error" role="alert">{error}</div>}
      <div className={`${styles.codeBox} ${state?.locked ? styles.codeLocked : ""}`}>
        <div className={styles.codeLabel}>Table code</div>
        <div className={`${styles.codeValue} ${fresh ? styles.codeFresh : ""}`} data-testid="table-code" data-code={shown ? state?.code : undefined}>
          {state ? (shown ? code : "••••-••••") : " "}
        </div>
        <div className={styles.codeTools}>
          <button className={styles.codeTool} disabled={!state} onClick={() => setShown((v) => !v)} data-testid="show-code">{shown ? "Hide" : "Show"}</button>
          <button className={styles.codeTool} disabled={!state} onClick={copy}>{copied ? "Copied" : "Copy"}</button>
          <button className={styles.codeTool} disabled={!state} onClick={renew} data-testid="new-code">New code</button>
        </div>
      </div>
      <div className="note">{state?.locked
        ? "Locked: the code does nothing, and no invite links work, until you unlock the table."
        : "Anyone with the code can ask to join. Nobody comes in until an owner lets them. A new code stops the old one."}</div>
      <div className={panels.switches}>
        <Switch on={!!state?.locked} disabled={!state} onChange={lock} testid="lock-table" title="Lock the table" about="Nobody new can join or be invited." />
      </div>
    </section>
  );
}
