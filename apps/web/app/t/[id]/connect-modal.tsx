"use client";

import { useEffect, useState } from "react";
import { browserClient } from "@/lib/supabase/browser";
import styles from "./room.module.css";

// Connect my Claude: opens the person's own Claude with the setup message already written. They read it and press
// Send, and their Claude sets up the quiet connection. Nobody types a command.
export function ConnectModal({ tableId, tableName, connected, onClose }: {
  tableId: string;
  tableName: string;
  connected: boolean;
  onClose: () => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    browserClient().rpc("start_pairing", { t: tableId, ai_kind: "claude" }).then(({ data, error }: { data: unknown; error: { message: string } | null }) => {
      if (cancelled) return;
      if (error || !data) setError(error?.message ?? "Something went wrong. Close this and try again.");
      else setCode(data as string);
    });
    return () => { cancelled = true; };
  }, [tableId]);

  const command = process.env.NEXT_PUBLIC_CONNECT_COMMAND || "npx --yes longtable@latest";
  const app = typeof window === "undefined" ? "" : window.location.origin;
  const message = code
    ? [
        `Connect me to my team's Longtable table "${tableName}".`,
        "Please run this command in this folder, and leave it running in the background:",
        `${command} connect ${code} --app ${app}`,
        "It lets my Claude answer questions at the table on my own plan. It keeps its own copy of this project's committed code and never changes my files.",
      ].join("\n")
    : "";
  const q = encodeURIComponent(message);

  async function copy() {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={styles.modalBack} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Connect my Claude">
        <div className={styles.modalTitle}>{connected ? "Your Claude is connected" : "Connect my Claude"}</div>
        {connected ? (
          <p className="note" style={{ margin: 0 }}>It answers at this table in the background whenever your computer is on.</p>
        ) : (
          <>
            <p className="note" style={{ margin: 0 }}>
              Pick where you use Claude. It opens with a message already written; read it and press Send. Your Claude does the
              setup, and your browser asks you to approve once.
            </p>
            {error && <div className="error">{error}</div>}
            {code && (
              <>
                <div className={styles.connectButtons}>
                  <a className="btn" href={`claude://code/new?q=${q}`}>Claude app</a>
                  <a className="btn btn-quiet" href={`vscode://anthropic.claude-code/open?prompt=${q}`}>VS Code</a>
                  <a className="btn btn-quiet" href={`claude-cli://open?q=${q}`}>Terminal</a>
                </div>
                <details className={styles.connectDetails}>
                  <summary>What the message says</summary>
                  <pre className={styles.connectMessage} data-testid="connect-message">{message}</pre>
                  <button className="btn btn-quiet" onClick={copy}>{copied ? "Copied" : "Copy it instead"}</button>
                </details>
                <p className="note" style={{ margin: 0 }}>This code works once, for 15 minutes. This window turns green when your Claude is connected.</p>
              </>
            )}
          </>
        )}
        <div className={styles.modalActions}>
          <button className="btn btn-quiet" onClick={onClose}>{connected ? "Done" : "Close"}</button>
        </div>
      </div>
    </div>
  );
}
