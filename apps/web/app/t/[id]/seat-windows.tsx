"use client";

import { useState } from "react";
import { useEscape } from "@/components/use-escape";
import { AI_NAME, AiLogo } from "@/components/ai-logo";
import { Mark } from "@/components/mark";
import { Time } from "@/components/time";
import { ModelPick, prettyModel } from "./model-pick";
import type { Connection, Member } from "./types";
import room from "./room.module.css";
import s from "./panels.module.css";

const prettyPlan = (plan?: string | null) => (plan ? `${plan.charAt(0).toUpperCase()}${plan.slice(1)}`.replace(/_/g, " ") : null);

// A switch with what it does said underneath, so nobody has to guess.
function Switch({ on, disabled, onChange, title, about, testid }: { on: boolean; disabled?: boolean; onChange: (next: boolean) => void; title: string; about: string; testid?: string }) {
  return (
    <label className={`${s.switchRow} ${disabled ? s.switchOff : ""}`}>
      <span className={s.switchText}><b>{title}</b><span>{about}</span></span>
      <input type="checkbox" className={s.switch} checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} data-testid={testid} />
    </label>
  );
}

// A person's AI at the table: what it is, what it runs, what it may do. Its own person can change it; everyone else
// on the team can look.
export function AiWindow({ me, person, conn, on, busy, onClose, onModel, onOptions, onConnect, onDisconnect }: {
  me: Member;
  person: Member;
  conn: Connection | null;
  on: boolean;
  busy: boolean;
  onClose: () => void;
  onModel: (conn: string, model: string) => void;
  onOptions: (conn: string, patch: { open_paths?: boolean; share_paths?: boolean }) => void;
  onConnect: () => void;
  onDisconnect: (conn: string) => void;
}) {
  useEscape(onClose);
  const [asking, setAsking] = useState(false);
  const mine = person.id === me.id;
  const first = person.display_name.split(" ")[0];
  const live = conn && !conn.revoked_at ? conn : null;
  const ai = conn ? AI_NAME[conn.kind] : "AI";
  const plan = prettyPlan(conn?.limits?.plan);
  const model = conn ? prettyModel(conn.model_choice) ?? (conn.kind === "claude" ? "Opus 5.5" : prettyModel(conn.limits?.model) ?? "Its own default") : "";
  const commands = live?.commands ?? [];
  const open = live?.open_paths !== false;
  const share = live?.share_paths !== false;
  return (
    <div className={room.modalBack} onClick={onClose}>
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
            {plan && <div className={s.fact}><span>Plan</span><b>{plan}</b></div>}
            {conn.last_seen && <div className={s.fact}><span>Last on</span><b><Time iso={conn.last_seen} style="stamp" /></b></div>}
            <div className={s.fact}><span>Runs on</span><b>{mine ? "Your computer, your own plan" : `${first}'s computer, their own plan`}</b></div>
            {live && <div className={s.fact}><span>Its own commands</span><b>{commands.length ? `${commands.length}, by typing / in a chat` : "None found"}</b></div>}
          </div>
        )}

        {mine && live && (
          <div className={s.block}>
            <h3 className={s.h2}>What it may do for you</h3>
            <div className={s.switches}>
              <Switch on={open} onChange={(v) => onOptions(live.id, { open_paths: v })} testid="opt-open"
                title="Open what I point at on this computer"
                about="When your own message names a file or a folder on this computer, it may read it. Never keys, passwords, browser data or a whole drive, never to change anything, and never because someone else asked." />
              <Switch on={open && share} disabled={!open} onChange={(v) => onOptions(live.id, { share_paths: v })} testid="opt-share"
                title="Share it with the other AIs on the same request"
                about="So a teammate's AI working on the same thing is not left in the dark. Text files only, small ones, with anything shaped like a secret hidden. Kept for a week, never shown to a client." />
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
              <button className="btn" onClick={() => { onDisconnect(live.id); onClose(); }}>Disconnect</button>
              <button className="btn btn-quiet" onClick={() => setAsking(false)}>Keep it</button>
            </div>
          </div>
        )}
        <div className={room.modalActions}>
          {mine && !asking && (
            <div className={s.row} style={{ marginRight: "auto" }}>
              {live ? <button className="btn btn-quiet" onClick={() => setAsking(true)}>Disconnect</button>
                : <button className="btn" onClick={() => { onClose(); onConnect(); }}>{conn ? "Connect again" : "Connect your AI"}</button>}
            </div>
          )}
          <button className="btn btn-quiet" onClick={onClose}>Close</button>
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
  useEscape(onClose);
  const text = writer ? `${AI_NAME[writer.conn.kind]} ${prettyModel(tableModel) ?? (writer.conn.kind === "claude" ? "Sonnet 5.5" : prettyModel(writer.conn.limits?.model) ?? "")}`.trim() : "";
  return (
    <div className={room.modalBack} onClick={onClose}>
      <div className={`${room.modal} ${s.window}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="The table" data-testid="table-window">
        <div className={s.hero}>
          <span className={s.seatMark}><Mark size={48} /></span>
          <h2 className={s.name}>The table</h2>
          <div className={s.sub}>{tableName}</div>
        </div>
        <div className={s.facts}>
          <div className={s.fact}><span>Speaks through</span><b>{writer ? `${writer.person.id === me.id ? "Your" : `${writer.person.display_name.split(" ")[0]}'s`} ${AI_NAME[writer.conn.kind]}` : "Nobody's AI is on"}</b></div>
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
          {onSettings && <button className="btn btn-quiet" style={{ marginRight: "auto" }} onClick={() => { onClose(); onSettings(); }}>Table settings</button>}
          <button className="btn btn-quiet" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
