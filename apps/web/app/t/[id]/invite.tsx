"use client";

import { useState } from "react";
import { browserClient } from "@/lib/supabase/browser";
import styles from "./room.module.css";

// Add a person: their name and email (both optional), then developer or client, and a one-time link to send them.
// Their join page arrives with their name already filled in. Email sending comes once longtable.chat has a mailer.
export function Invite({ tableId }: { tableId: string }) {
  const [open, setOpen] = useState(false);
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

  function toggle() {
    setOpen(!open);
    setLink("");
    setError("");
    setName("");
    setEmail("");
  }

  return (
    <div className={styles.invite}>
      <button className="btn" onClick={toggle}>Invite</button>
      {open && (
        <div className={styles.popover}>
          <div className={styles.popoverTitle}>Add someone to this table</div>
          {!link && (
            <>
              <input className="field" maxLength={60} value={name} onChange={(e) => setName(e.target.value)}
                placeholder="Their name (optional)" aria-label="Their name" />
              <input className="field" maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="Their email (optional)" aria-label="Their email" />
              <div className={styles.roles}>
                <button className="btn btn-quiet" disabled={busy} onClick={() => make("developer")}>A developer</button>
                <button className="btn btn-quiet" disabled={busy} onClick={() => make("client")}>The client</button>
              </div>
            </>
          )}
          {link && (
            <>
              <div className={styles.linkBox} data-testid="invite-link">{link}</div>
              <button className="btn" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
              <div className="note">Works once, for 7 days. Send it any way you like.</div>
            </>
          )}
          {error && <div className="error">{error}</div>}
        </div>
      )}
    </div>
  );
}
