"use client";

import { useState } from "react";
import { browserClient } from "@/lib/supabase/browser";
import styles from "./room.module.css";

// Invite links: the owner picks developer or client and copies a one-time link.
export function Invite({ tableId }: { tableId: string }) {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  async function make(role: "developer" | "client") {
    setBusy(true);
    setError("");
    setCopied(false);
    const { data, error } = await browserClient().rpc("create_invite", { t: tableId, invite_role: role });
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
    <div className={styles.invite}>
      <button className="btn" onClick={() => { setOpen(!open); setLink(""); setError(""); }}>Invite</button>
      {open && (
        <div className={styles.popover}>
          <div className={styles.popoverTitle}>Invite someone to this table</div>
          <div className={styles.roles}>
            <button className="btn btn-quiet" disabled={busy} onClick={() => make("developer")}>A developer</button>
            <button className="btn btn-quiet" disabled={busy} onClick={() => make("client")}>The client</button>
          </div>
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
