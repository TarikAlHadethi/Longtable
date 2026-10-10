"use client";

import { Arrow, Check } from "@/components/icons";
import { useEffect, useState } from "react";
import { AI_NAME, AI_TOOL, AiLogo, type AiKind } from "@/components/ai-logo";
import { browserClient } from "@/lib/supabase/browser";
import s from "./connect.module.css";

type Way = { title: string; href: string };

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
  // Where the project's code is. With an address, the AI can be opened in any folder: the connection fetches its
  // own copy. Without one, it has to be opened in the project's own folder. undefined: still loading.
  const [repo, setRepo] = useState<string | null | undefined>(audience === "client" ? null : undefined);
  const [repoDraft, setRepoDraft] = useState("");
  const [fromFolder, setFromFolder] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (audience === "client") return;
    let cancelled = false;
    browserClient().from("table_code").select("repo_url").eq("table_id", tableId).maybeSingle()
      .then(({ data }: { data: { repo_url: string } | null }) => { if (!cancelled) setRepo(data?.repo_url ?? null); });
    return () => { cancelled = true; };
  }, [tableId, audience]);

  async function saveRepo(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    const url = repoDraft.trim();
    const { error } = await browserClient().rpc("set_table_repo", { t: tableId, url });
    setSaving(false);
    if (error) return setError(error.message);
    setRepo(url);
  }

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

  const app = typeof window === "undefined" ? "" : window.location.origin;
  // The connection comes from this site itself, not from a package registry: nobody else can publish under its name.
  const command = process.env.NEXT_PUBLIC_CONNECT_COMMAND || `npx --yes ${app}/longtable.tgz`;
  const name = kind ? AI_NAME[kind] : "AI";
  // The message is the person's own request to their own AI, in their voice: what they want, that they chose it,
  // exactly what it does, and leave to check the package first instead of stopping to ask.
  const message = code && kind
    ? [
        audience === "client"
          ? `Connect my ${name} to "${tableName}" on Longtable, as my own assistant there. Please run this and keep it running in the background:`
          : `Connect my ${name} to my team's Longtable table "${tableName}". Please run this${repo ? "" : " in this folder"} and keep it running in the background:`,
        `${command} connect ${code}${kind === "codex" ? " --ai codex" : ""}${repo ? ` --repo ${repo}` : ""} --app ${app}`,
        ...(kind === "codex" ? ["If Codex's command-line tool is missing, install it first with npm install -g @openai/codex."] : []),
        audience === "client"
          ? `It lets my ${name} answer me there on my own plan. It gets no code and changes no files.`
          : `It answers my team's questions on my own plan, from its own copy of the committed code. Only its answers leave this computer, and it never changes my files.`,
        'If you are unsure, just ask me "Are you sure?".',
      ].join("\n")
    : "";
  const q = encodeURIComponent(message);
  const ways: Way[] = kind === "codex"
    ? [{ title: "Codex app", href: `codex://threads/new?prompt=${q}` }]
    : [
        { title: "Claude app", href: `claude://code/new?q=${q}` },
        { title: "VS Code", href: `vscode://anthropic.claude-code/open?prompt=${q}` },
        { title: "Terminal", href: `claude-cli://open?q=${q}` },
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
            <span className={s.doneLogo}><AiLogo kind={connected} size={44} /><i><Check size={13} stroke={3} /></i></span>
            <div className={s.title}>Your {AI_NAME[connected]} is connected</div>
            <p className={s.lead}>
              It answers whenever your computer is on.
            </p>
            <button className="btn" onClick={onClose}>Done</button>
          </div>
        ) : (
          <>
            <div className={s.title}>Connect your AI</div>
            {audience === "client" && <p className={s.lead}>It answers you here on your own plan, and passes anything new to the team.</p>}
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
                    {audience === "team" && !repo && !fromFolder ? (
                      <form className={s.repo} onSubmit={saveRepo}>
                        <label className={s.stepsTitle} htmlFor="repo">Where is the project&apos;s code?</label>
                        <div className={s.repoRow}>
                          <input id="repo" className="field" value={repoDraft} onChange={(e) => setRepoDraft(e.target.value)} autoFocus
                            placeholder="https://github.com/you/project" disabled={repo === undefined} />
                          <button className="btn" disabled={saving || !repoDraft.trim()}>{saving ? "Saving…" : "Save"}</button>
                        </div>
                        <button type="button" className={s.link} onClick={() => setFromFolder(true)}>It is only on my computer</button>
                        {error && <div className="error">{error}</div>}
                      </form>
                    ) : (<>
                    <div className={s.stepsTitle}>{repo || audience === "client" ? `Open ${name} and press Send` : `Open ${name} in the project's folder and press Send`}</div>
                    {error && <div className="error">{error}</div>}
                    <div className={`${s.ways} ${code ? "" : s.waysWait}`}>
                      {ways.map((w, i) => (
                        <a key={w.title} className={s.way} href={code ? w.href : undefined} aria-disabled={!code} style={{ "--i": i } as React.CSSProperties}>
                          <span className={s.wayIcon}><AiLogo kind={kind} size={20} /></span>
                          <span className={s.wayText}><b>{w.title}</b></span>
                          <span className={s.wayGo}>{code ? <Arrow size={17} /> : <i className={s.spin} />}</span>
                        </a>
                      ))}
                    </div>
                    <details className={s.details}>
                      <summary>What the message says</summary>
                      <pre className={s.message} data-testid={code ? "connect-message" : undefined}>{message}</pre>
                      <button className="btn btn-quiet" onClick={copy} disabled={!code}>{copied ? "Copied" : "Copy it instead"}</button>
                    </details>
                    {audience === "team" && (
                      <div className={s.repoLine}>
                        <span>{repo ? repo.replace(/^https:\/\//, "").replace(/\.git$/, "") : "Reading the folder it is opened in"}</span>
                        <button type="button" className={s.link} onClick={() => { setRepoDraft(repo ?? ""); setRepo(null); setFromFolder(false); }}>Change</button>
                      </div>
                    )}
                    </>)}
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
