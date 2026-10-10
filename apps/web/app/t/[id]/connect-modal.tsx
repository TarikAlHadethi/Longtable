"use client";

import { useEffect, useState } from "react";
import { AI_NAME, AI_TOOL, AiLogo, type AiKind } from "@/components/ai-logo";
import { browserClient } from "@/lib/supabase/browser";
import s from "./connect.module.css";

type Way = { title: string; note: string; href: string };

// Connect your AI: pick Claude or ChatGPT, and the window opens downward into the ways to hand that AI its setup
// message. The person reads the message there and presses Send; their own AI does the setup. Nobody types a command.
// A client's AI gets no copy of the code; a team member's reads its own clean copy.
export function ConnectModal({ tableId, tableName, audience = "team", connected, onClose }: {
  tableId: string;
  tableName: string;
  audience?: "team" | "client";
  connected: AiKind | null;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<AiKind | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!kind) return;
    let cancelled = false;
    setCode("");
    setError("");
    setCopied(false);
    browserClient().rpc("start_pairing", { t: tableId, ai_kind: kind }).then(({ data, error }: { data: unknown; error: { message: string } | null }) => {
      if (cancelled) return;
      if (error || !data) setError(error?.message ?? "Something went wrong. Close this and try again.");
      else setCode(data as string);
    });
    return () => { cancelled = true; };
  }, [tableId, kind]);

  const command = process.env.NEXT_PUBLIC_CONNECT_COMMAND || "npx --yes longtable@latest";
  const app = typeof window === "undefined" ? "" : window.location.origin;
  const name = kind ? AI_NAME[kind] : "AI";
  const message = code && kind
    ? [
        audience === "client"
          ? `Connect me to "${tableName}" on Longtable, as my own assistant there.`
          : `Connect me to my team's Longtable table "${tableName}".`,
        audience === "client"
          ? "Please run this command, and leave it running in the background:"
          : "Please run this command in this folder, and leave it running in the background:",
        `${command} connect ${code}${kind === "codex" ? " --ai codex" : ""} --app ${app}`,
        ...(kind === "codex" ? ["If Codex's command-line tool is missing, install it first with npm install -g @openai/codex."] : []),
        audience === "client"
          ? `It lets my ${name} answer me there on my own plan. It gets no code and changes no files.`
          : `It lets my ${name} answer questions at the table on my own plan. It keeps its own copy of this project's committed code and never changes my files.`,
      ].join("\n")
    : "";
  const q = encodeURIComponent(message);
  const ways: Way[] = kind === "codex"
    ? [{ title: "Codex app", note: "Opens a new thread with the message written", href: `codex://threads/new?prompt=${q}` }]
    : [
        { title: "Claude app", note: "Opens Claude Code in the desktop app", href: `claude://code/new?q=${q}` },
        { title: "VS Code", note: "Opens the Claude Code panel in your editor", href: `vscode://anthropic.claude-code/open?prompt=${q}` },
        { title: "Terminal", note: "Opens Claude Code in a terminal window", href: `claude-cli://open?q=${q}` },
      ];

  async function copy() {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={s.back} onClick={onClose}>
      <div className={s.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Connect your AI">
        {connected ? (
          <div className={s.done}>
            <span className={s.doneLogo}><AiLogo kind={connected} size={44} /><i>✓</i></span>
            <div className={s.title}>Your {AI_NAME[connected]} is connected</div>
            <p className={s.lead}>
              {audience === "client"
                ? "It answers you here whenever your computer is on. It sees only what you asked for and what you were told, and passes anything new to the team."
                : "It answers at this table in the background whenever your computer is on."}
            </p>
            <button className="btn" onClick={onClose}>Done</button>
          </div>
        ) : (
          <>
            <div className={s.title}>Connect your AI</div>
            <p className={s.lead}>
              {audience === "client"
                ? "Your own AI can answer you here, on your own plan: where things stand and what was decided. Anything new it passes to the team."
                : "It joins the table on your own plan and answers from its own copy of the code. Which one do you use?"}
            </p>
            <div className={s.picks}>
              {(["claude", "codex"] as const).map((k) => (
                <button key={k} className={`${s.pick} ${s[k]} ${kind === k ? s.pickOn : ""} ${kind && kind !== k ? s.pickDim : ""}`}
                  aria-pressed={kind === k} data-testid={`pick-${k}`} onClick={() => setKind(k)}>
                  <AiLogo kind={k} size={40} />
                  <span className={s.pickName}>{AI_NAME[k]}</span>
                  <span className={s.pickTool}>through {AI_TOOL[k]}</span>
                </button>
              ))}
            </div>

            {/* The rest opens downward once an AI is picked. Its height is set from the start, so nothing jumps
                when the one-use code arrives. */}
            <div className={`${s.more} ${kind ? s.moreOpen : ""}`}>
              <div className={s.moreInner}>
                {kind && (
                  <div className={s.steps} key={kind}>
                    <div className={s.stepsTitle}>Where do you use {name}?</div>
                    <p className={s.stepsNote}>It opens with a message already written. Read it and press Send; your {name} does the setup, and your browser asks you to approve once.</p>
                    {error && <div className="error">{error}</div>}
                    <div className={`${s.ways} ${code ? "" : s.waysWait}`}>
                      {ways.map((w, i) => (
                        <a key={w.title} className={s.way} href={code ? w.href : undefined} aria-disabled={!code} style={{ "--i": i } as React.CSSProperties}>
                          <span className={s.wayIcon}><AiLogo kind={kind} size={20} /></span>
                          <span className={s.wayText}><b>{w.title}</b><em>{w.note}</em></span>
                          <span className={s.wayGo}>{code ? "→" : <i className={s.spin} />}</span>
                        </a>
                      ))}
                    </div>
                    <details className={s.details}>
                      <summary>What the message says</summary>
                      <pre className={s.message} data-testid={code ? "connect-message" : undefined}>{message}</pre>
                      <button className="btn btn-quiet" onClick={copy} disabled={!code}>{copied ? "Copied" : "Copy it instead"}</button>
                    </details>
                    <p className={s.foot}>The code inside works once, for 15 minutes. This window changes when your {name} is connected.</p>
                  </div>
                )}
              </div>
            </div>
            <div className={s.actions}><button className="btn btn-quiet" onClick={onClose}>Close</button></div>
          </>
        )}
      </div>
    </div>
  );
}
