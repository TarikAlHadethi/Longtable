"use client";

import { useEffect, useState } from "react";
import { browserClient } from "@/lib/supabase/browser";
import styles from "./room.module.css";

type Kind = "codex" | "claude";

// Connect my assistant, for a client: their own Codex or Claude, on their own plan. It opens their AI with the
// setup message already written; they read it and press Send, and their AI does the setup. It never gets the code.
export function ClientConnect({ tableId, tableName, connected, onClose }: {
  tableId: string;
  tableName: string;
  connected: boolean;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!kind) return;
    let cancelled = false;
    setCode("");
    setError("");
    browserClient().rpc("start_pairing", { t: tableId, ai_kind: kind }).then(({ data, error }: { data: unknown; error: { message: string } | null }) => {
      if (cancelled) return;
      if (error || !data) setError(error?.message ?? "Something went wrong. Close this and try again.");
      else setCode(data as string);
    });
    return () => { cancelled = true; };
  }, [tableId, kind]);

  const command = process.env.NEXT_PUBLIC_CONNECT_COMMAND || "npx --yes longtable@latest";
  const app = typeof window === "undefined" ? "" : window.location.origin;
  const word = kind === "codex" ? "Codex" : "Claude";
  const message = code
    ? [
        `Connect me to "${tableName}" on Longtable, as my own assistant there.`,
        "Please run this command, and leave it running in the background:",
        `${command} connect ${code} --ai ${kind} --app ${app}`,
        ...(kind === "codex" ? ["If Codex's command-line tool is missing, install it first with npm install -g @openai/codex."] : []),
        `It lets my ${word} answer me there on my own plan. It gets no code and changes no files.`,
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
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Connect my assistant">
        <div className={styles.modalTitle}>{connected ? "Your assistant is connected" : "Connect my assistant"}</div>
        {connected ? (
          <p className="note" style={{ margin: 0 }}>
            It answers you here whenever your computer is on. It sees only what you asked for and what you were told, and
            passes anything new to the team.
          </p>
        ) : !kind ? (
          <>
            <p className="note" style={{ margin: 0 }}>
              Your own AI can answer you here, on your own plan: where things stand, what was decided. Anything new it passes
              to the team. Which one do you use?
            </p>
            <div className={styles.connectButtons}>
              <button className="btn" onClick={() => setKind("codex")}>Codex</button>
              <button className="btn btn-quiet" onClick={() => setKind("claude")}>Claude</button>
            </div>
          </>
        ) : (
          <>
            <p className="note" style={{ margin: 0 }}>
              It opens with a message already written; read it and press Send. Your {word} does the setup, and your browser asks
              you to approve once.
            </p>
            {error && <div className="error">{error}</div>}
            {code && (
              <>
                <div className={styles.connectButtons}>
                  {kind === "codex" ? (
                    <a className="btn" href={`codex://threads/new?prompt=${q}`}>Codex app</a>
                  ) : (
                    <>
                      <a className="btn" href={`claude://code/new?q=${q}`}>Claude app</a>
                      <a className="btn btn-quiet" href={`vscode://anthropic.claude-code/open?prompt=${q}`}>VS Code</a>
                      <a className="btn btn-quiet" href={`claude-cli://open?q=${q}`}>Terminal</a>
                    </>
                  )}
                </div>
                <details className={styles.connectDetails}>
                  <summary>What the message says</summary>
                  <pre className={styles.connectMessage} data-testid="connect-message">{message}</pre>
                  <button className="btn btn-quiet" onClick={copy}>{copied ? "Copied" : "Copy it instead"}</button>
                </details>
                <p className="note" style={{ margin: 0 }}>This code works once, for 15 minutes.</p>
              </>
            )}
          </>
        )}
        <div className={styles.modalActions}>
          {kind && !connected && <button className="btn btn-quiet" onClick={() => setKind(null)}>Back</button>}
          <button className="btn btn-quiet" onClick={onClose}>{connected ? "Done" : "Close"}</button>
        </div>
      </div>
    </div>
  );
}
