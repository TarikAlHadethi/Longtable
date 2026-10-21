"use client";

import { useState } from "react";
import { useClosing, useEscape } from "@/components/use-escape";
import { AI_NAME, AiLogo } from "@/components/ai-logo";
import { Mark } from "@/components/mark";
import { Time } from "@/components/time";
import { ModelPick, prettyModel } from "./model-pick";
import type { Command, Connection, Member } from "./types";
import room from "./room.module.css";
import s from "./panels.module.css";
import { firstName } from "@/lib/names";
import { EFFORT_LEVELS } from "@/lib/slash.mjs";
import { Select } from "@/components/select";

const prettyPlan = (plan?: string | null) => (plan ? `${plan.charAt(0).toUpperCase()}${plan.slice(1)}`.replace(/_/g, " ") : null);

// A switch with what it does said underneath, so nobody has to guess.
export function Switch({ on, disabled, onChange, title, about, testid }: { on: boolean; disabled?: boolean; onChange: (next: boolean) => void; title: string; about: string; testid?: string }) {
  return (
    <label className={`${s.switchRow} ${disabled ? s.switchOff : ""}`}>
      <span className={s.switchText}><b>{title}</b><span>{about}</span></span>
      <input type="checkbox" className={s.switch} checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} data-testid={testid} />
    </label>
  );
}

// A person's AI at the table: what it is, what it runs, what it may do. Its own person can change it; everyone else
// on the team can look.
export function AiWindow({ me, person, conn, commands, on, busy, onSpeed, onClose, onModel, onOptions, onConnect, onDisconnect }: {
  me: Member;
  person: Member;
  conn: Connection | null;
  // Only ever the viewer's own: someone else's commands are theirs.
  commands: Command[];
  on: boolean;
  onSpeed: (conn: string, patch: { effort?: string; fast?: boolean }) => void;
  busy: boolean;
  onClose: () => void;
  onModel: (conn: string, model: string) => void;
  onOptions: (conn: string, patch: { open_paths?: boolean; share_paths?: boolean; full_claude?: boolean; in_folder?: boolean }) => void;
  onConnect: () => void;
  onDisconnect: (conn: string) => void;
}) {
  const [shut, close] = useClosing(onClose);
  useEscape(close);
  const [asking, setAsking] = useState(false);
  const mine = person.id === me.id;
  const first = firstName(person.display_name);
  const live = conn && !conn.revoked_at ? conn : null;
  const ai = conn ? AI_NAME[conn.kind] : "AI";
  const plan = prettyPlan(conn?.limits?.plan);
  const model = conn ? prettyModel(conn.model_choice) ?? (conn.kind === "claude" ? "Opus 5.5" : prettyModel(conn.limits?.model) ?? "Its own default") : "";
  const open = live?.open_paths !== false;
  const share = live?.share_paths !== false;
  return (
    <div className={`${room.modalBack} ${shut ? room.closing : ""}`} onClick={close}>
      <div className={`${room.modal} ${s.window}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={mine ? `Your ${ai}` : `${person.display_name}'s ${ai}`} data-testid="ai-window">
        <div className={s.hero}>
          <span className={s.seatMark}>{conn ? <AiLogo kind={conn.kind} size={44} /> : <Mark size={44} />}</span>
          <h2 className={s.name}>{mine ? `Your ${ai}` : `${first}'s ${ai}`}</h2>
          <div className={s.sub}>{!conn ? "No AI connected yet" : !live ? "Disconnected" : busy ? "Working right now" : on ? "Connected, on this person's own computer" : "Connected, but its computer is off or asleep"}</div>
        </div>

        {conn && (
          <div className={s.facts}>
            <div className={s.fact}>
              <span>Model</span>
              <b>{mine && live && on
                ? <ModelPick kind={conn.kind} value={conn.model_choice ?? ""} text={model} reported={conn.limits?.models} className="" canPick onPick={(m) => onModel(conn.id, m)} />
                : model}</b>
            </div>
            {mine && live && (
              <div className={s.fact}>
                <span>Effort</span>
                <b>
                  {/* Medium unless they pick another; the menu wide enough for every level on one line. */}
                  <span className={s.effortPick}>
                    <Select id="opt-effort" label="Effort" value={live.effort ?? "medium"} onChange={(v) => onSpeed(live.id, { effort: v })}
                      options={EFFORT_LEVELS.map((l) => ({ value: l, label: l === "xhigh" ? "Extra high" : l.charAt(0).toUpperCase() + l.slice(1) }))} />
                  </span>
                </b>
              </div>
            )}
            {plan && <div className={s.fact}><span>Plan</span><b>{plan}</b></div>}
            {conn.last_seen && <div className={s.fact}><span>Last on</span><b><Time iso={conn.last_seen} style="stamp" /></b></div>}
            <div className={s.fact}><span>Runs on</span><b>{mine ? "Your computer, your own plan" : `${first}'s computer, their own plan`}</b></div>
            {conn.limits?.version && <div className={s.fact}><span>Connection</span><b>{conn.limits.version}</b></div>}
            {mine && live && <div className={s.fact}><span>Its own commands</span><b>{commands.length || "None"}</b></div>}
          </div>
        )}

        {mine && live && (
          <div className={s.block}>
            <h3 className={s.h2}>What it may do for you</h3>
            <div className={s.switches}>
              <Switch on={open} onChange={(v) => onOptions(live.id, { open_paths: v })} testid="opt-open"
                title="Open what I point at"
                about="Reads a file or folder you name. Never keys." />
              <Switch on={open && share} disabled={!open} onChange={(v) => onOptions(live.id, { share_paths: v })} testid="opt-share"
                title="Share it with the other AIs"
                about="Your teammates' AIs see what it opened." />
              {conn?.kind === "claude" && (
                <Switch on={!!live.full_claude} onChange={(v) => onOptions(live.id, { full_claude: v })} testid="opt-full"
                  title="Run as my full Claude Code"
                  about="Runs commands and tests. Asks you first." />
              )}
              {conn?.kind === "claude" && !!live.full_claude && (
                <Switch on={live.in_folder !== false} onChange={(v) => onOptions(live.id, { in_folder: v })} testid="opt-in-folder"
                  title="Work in my folder"
                  about="Your requests change your files, as at home. Off: a branch." />
              )}
              {/* Fast mode only where their account can use it: a switch that can never work is not offered. */}
              {conn?.kind === "claude" && !(live.limits?.fast_why && live.limits?.fast !== "on") && (
                <Switch on={!!live.fast} onChange={(v) => onSpeed(live.id, { fast: v })} testid="opt-fast"
                  title="Fast mode" about="Faster, costs more of your plan." />
              )}
            </div>
          </div>
        )}
        {!mine && live && (
          <p className={s.sub} style={{ margin: 0 }}>Only {first} can change what their AI runs and what it may open.</p>
        )}

        {asking && live && (
          <div className={s.ask}>
            <p>Your {ai} leaves this table. Work it is in the middle of is stopped. You can connect again whenever you like.</p>
            <div className={s.row}>
              <button className="btn" onClick={() => { onDisconnect(live.id); close(); }}>Disconnect</button>
              <button className="btn btn-quiet" onClick={() => setAsking(false)}>Keep it</button>
            </div>
          </div>
        )}
        <div className={room.modalActions}>
          {mine && !asking && (
            <div className={s.row} style={{ marginRight: "auto" }}>
              {live ? <button className="btn btn-quiet" onClick={() => setAsking(true)}>Disconnect</button>
                : <button className="btn" onClick={() => { close(); onConnect(); }}>{conn ? "Connect again" : "Connect your AI"}</button>}
            </div>
          )}
          <button className="btn btn-quiet" onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}

// The table itself: whose AI it speaks through, on which model, and how a request moves across it.
export function TableWindow({ me, tableName, writer, tableModel, onTableModel, people, aisOn, onSettings, onClose }: {
  me: Member;
  tableName: string;
  writer: { person: Member; conn: Connection } | null;
  tableModel: string | null;
  onTableModel: (model: string) => void;
  people: number;
  aisOn: number;
  onSettings?: () => void;
  onClose: () => void;
}) {
  const [shut, close] = useClosing(onClose);
  useEscape(close);
  const text = writer ? `${AI_NAME[writer.conn.kind]} ${prettyModel(tableModel) ?? (writer.conn.kind === "claude" ? "Sonnet 5.5" : prettyModel(writer.conn.limits?.model) ?? "")}`.trim() : "";
  return (
    <div className={`${room.modalBack} ${shut ? room.closing : ""}`} onClick={close}>
      <div className={`${room.modal} ${s.window}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="The table" data-testid="table-window">
        <div className={s.hero}>
          <span className={s.seatMark}><Mark size={48} /></span>
          <h2 className={s.name}>The table</h2>
          <div className={s.sub}>{tableName}</div>
        </div>
        <div className={s.facts}>
          <div className={s.fact}><span>Speaks through</span><b>{writer ? `${writer.person.id === me.id ? "Your" : `${firstName(writer.person.display_name)}'s`} ${AI_NAME[writer.conn.kind]}` : "Nobody's AI is on"}</b></div>
          {writer && (
            <div className={s.fact}>
              <span>Model for the table&apos;s own words</span>
              <b><ModelPick kind={writer.conn.kind} value={tableModel ?? ""} reported={writer.conn.limits?.models} text={text} className="" canPick onPick={onTableModel} /></b>
            </div>
          )}
          <div className={s.fact}><span>People working here</span><b>{people}</b></div>
          <div className={s.fact}><span>AIs on right now</span><b>{aisOn}</b></div>
        </div>
        <div className={s.block}>
          <h3 className={s.h2}>How a message moves</h3>
          <ol className={s.steps}>
            <li>The table listens. People talking to each other are left alone.</li>
            <li>A question goes to the asker&apos;s own AI, on their computer, with what it knows of them.</li>
            <li>Work is done by the asker&apos;s AI on a branch. The other AIs say what they think first and look it over after.</li>
            <li>With more than one AI, the table gives one answer.</li>
          </ol>
        </div>
        <div className={room.modalActions}>
          {onSettings && <button className="btn btn-quiet" style={{ marginRight: "auto" }} onClick={() => { close(); onSettings(); }}>Table settings</button>}
          <button className="btn btn-quiet" onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}
