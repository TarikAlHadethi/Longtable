"use client";

import { useClosing, useEscape } from "@/components/use-escape";
import { useState } from "react";
import { browserClient } from "@/lib/supabase/browser";
import { Grow } from "@/components/grow";
import styles from "./room.module.css";

// Add a person: their name and email (both optional), then developer or client, and a one-time link to send them.
// Their join page arrives with their name already filled in. Email sending comes once longtable.chat has a mailer.
export function Invite({ tableId, onClose }: { tableId: string; onClose: () => void }) {
  const [shut, close] = useClosing(onClose);
  useEscape(close);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  async function make(role: "developer" | "client") {
    setBusy(true);
    setError("");
    setCopied(false);
    const { data, error } = await browserClient().rpc("create_invite", {
      t: tableId, invite_role: role, invite_name: name.trim(), invite_email: email.trim(),
    });
    setBusy(false);
    if (error || !data) return setError(error?.message ?? "Something went wrong. Try again.");
    setLink(`${window.location.origin}/join/${data}`);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={`${styles.modalBack} ${shut ? styles.closing : ""}`} onClick={close}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Invite people">
        <div className={styles.modalTitle}>Add someone to this table</div>
        <Grow>
        {!link && (
          <>
            <input className="field" maxLength={60} value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Their name (optional)" aria-label="Their name" />
            <input className="field" maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="Their email (optional)" aria-label="Their email" />
            {/* Two equal choices: who they are decides what they see. */}
            <div className={styles.roleTiles}>
              <button className={styles.roleTile} disabled={busy} onClick={() => make("developer")}><b>A developer</b><span>Brings their own AI to the table</span></button>
              <button className={styles.roleTile} disabled={busy} onClick={() => make("client")}><b>The client</b><span>Gets the client page, never the team side</span></button>
            </div>
          </>
        )}
        {link && (
          <div className={styles.linkReady}>
            <div className={styles.linkBox} data-testid="invite-link">{link}</div>
            <button className="btn" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
            <div className="note">Works once, for 7 days. Send it any way you like.</div>
          </div>
        )}
        </Grow>
        {error && <div className="error">{error}</div>}
        <div className={styles.modalActions}><button className="btn btn-quiet" onClick={close} data-testid="invite-close">{link ? "Done" : "Close"}</button></div>
      </div>
    </div>
  );
}
