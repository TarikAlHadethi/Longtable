"use client";

import { Arrow, Plus } from "@/components/icons";
import { AI_NAME, AiLogo, type AiKind } from "@/components/ai-logo";
import { Mark } from "@/components/mark";
import type { Chat, Connection, Job, Member, Message } from "./types";
import s from "./table-view.module.css";

const initial = (name: string) => name.trim().charAt(0).toUpperCase() || "?";
const ROLE = { owner: "Owner", developer: "Developer", client: "Client" } as const;

// "claude-opus-5-5" reads as "Opus 5.5"; anything unfamiliar is shown as it came.
export function prettyModel(model?: string | null): string | null {
  if (!model || /default/i.test(model)) return null;
  const name = model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  const m = name.match(/^([a-z]+)-(\d+)(?:-(\d+))?$/);
  return m ? `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : model;
}
const prettyPlan = (plan?: string | null) => (plan ? `${plan.charAt(0).toUpperCase()}${plan.slice(1).replace(/_/g, " ")}` : null);
// Which maker a model name belongs to, for answers written before the table knew.
export const kindOfModel = (model?: string | null): AiKind => (/gpt|codex|^o\d/i.test(model ?? "") ? "codex" : "claude");

// The table's home: who is at the table, the AI each person brought and the model it is running, and how they all
// meet at the table. Everything hangs from one centred column, so the people always sit squarely over the table.
export function TableView({ table, me, members, connections, jobs, online, messages, chats, onOpenChat, onConnect, onInvite }: {
  table: { id: string; name: string };
  me: Member;
  members: Member[];
  connections: Connection[];
  jobs: Job[];
  online: Set<string>;
  messages: Message[];
  chats: Chat[];
  onOpenChat: (id: string) => void;
  onConnect: () => void;
  onInvite?: () => void;
}) {
  const team = members.filter((m) => m.role !== "client");
  const clients = members.filter((m) => m.role === "client");
  const live = connections.filter((c) => !c.revoked_at);
  const aiOf = (id: string) => live.filter((c) => c.member_id === id).sort((a, b) => (b.last_seen ?? "").localeCompare(a.last_seen ?? ""))[0];
  const busy = new Set(jobs.filter((j) => j.status === "running" || j.status === "queued" || j.status === "waiting").map((j) => j.member_id));
  // The next seat is a real place in the row, so a table of one already looks like a table.
  const cols = team.length + (onInvite ? 1 : 0) || 1;
  const connected = team.filter((m) => aiOf(m.id)).length;
  const anyBusy = team.some((m) => busy.has(m.id));
  const last = [...messages].reverse().find((m) => m.by_ai && (m.kind === "answer" || !m.kind));
  const lastModel = prettyModel(last?.meta?.model);
  const general = [...chats].sort((a, b) => Number(b.is_general) - Number(a.is_general))[0];

  return (
    <div className={s.wrap} data-testid="table-home">
      <div className={s.top}>
        <Mark size={60} live />
        <div className={s.word}>Longtable</div>
        <div className={s.project}>{table.name}</div>
      </div>

      <div className={s.scroller}>
        <div className={s.tree} style={{ "--cols": cols } as React.CSSProperties}>
          <div className={s.row}>
            {team.map((m, i) => {
              const ai = aiOf(m.id);
              const working = busy.has(m.id);
              const model = prettyModel(ai?.limits?.model);
              const plan = prettyPlan(ai?.limits?.plan);
              return (
                <div className={s.col} key={m.id} style={{ "--i": i } as React.CSSProperties} data-person={m.display_name}>
                  <div className={s.person}>
                    <span className={s.avatar} style={{ background: m.color }}>
                      {initial(m.display_name)}
                      <i className={online.has(m.id) ? s.here : s.away} />
                    </span>
                    <div className={s.name}>{m.display_name}{m.id === me.id ? " (you)" : ""}</div>
                    <div className={s.role}>{ROLE[m.role]} · {online.has(m.id) ? "here" : "away"}</div>
                  </div>
                  <div className={`${s.stem} ${ai ? s.stemOn : ""}`} />
                  {ai ? (
                    <div className={`${s.ai} ${s[ai.kind]} ${working ? s.aiBusy : ""}`} data-seat-ai={ai.kind}>
                      <div className={s.aiHead}>
                        <AiLogo kind={ai.kind} size={26} />
                        <span className={`${s.dot} ${working ? s.dotBusy : ""}`} title={working ? "Working" : "Connected"} />
                      </div>
                      <div className={s.aiName}>{AI_NAME[ai.kind]}{plan ? ` ${plan}` : ""}</div>
                      <div className={s.model} key={model ?? "none"}>{working ? "Reading the code…" : model ?? "Connected"}</div>
                    </div>
                  ) : m.id === me.id ? (
                    <button className={s.plus} onClick={onConnect}>
                      <span className={s.plusSign}><Plus size={18} stroke={2.4} /></span>
                      <span className={s.plusTitle}>Connect your AI</span>
                    </button>
                  ) : (
                    <div className={s.none}>
                      <span className={s.plusTitle}>No AI yet</span>
                    </div>
                  )}
                </div>
              );
            })}
            {onInvite && (
              <div className={s.col} style={{ "--i": team.length } as React.CSSProperties}>
                <button className={s.inviteSeat} onClick={onInvite}>
                  <span className={s.inviteAvatar}><Plus size={22} /></span>
                  <span className={s.name}>Invite someone</span>
                </button>
              </div>
            )}
          </div>

          <svg className={s.funnel} viewBox={`0 0 ${cols * 100} 100`} preserveAspectRatio="none" aria-hidden="true">
            {/* Unconnected wires are drawn first, so a live one is never dulled where they meet. */}
            {team.map((m, i) => ({ m, i })).sort((a, b) => Number(!!aiOf(a.m.id)) - Number(!!aiOf(b.m.id))).map(({ m, i }) => {
              const x = i * 100 + 50;
              const cx = cols * 50;
              const d = x === cx ? `M ${x} 0 L ${cx} 100` : `M ${x} 0 C ${x} 62, ${cx} 38, ${cx} 100`;
              const ai = aiOf(m.id);
              return (
                <g key={m.id} className={ai ? `${s[`wire_${ai.kind}`]} ${busy.has(m.id) ? s.wireBusy : ""}` : undefined}>
                  <path d={d} vectorEffect="non-scaling-stroke" className={ai ? s.wire : s.wireOff} />
                  {ai && <path d={d} vectorEffect="non-scaling-stroke" className={s.pulse} style={{ animationDelay: `${-i * 0.9}s` }} />}
                </g>
              );
            })}
          </svg>

          <div className={`${s.table} ${anyBusy ? s.tableBusy : ""}`}>
            <div className={s.tableTitle}>The Table</div>
            <Mark size={64} />
            <div className={s.tableModel} key={lastModel ?? "none"}>
              {anyBusy ? "Working on an answer…"
                : last ? `${AI_NAME[kindOfModel(last.meta?.model)]}${lastModel ? ` ${lastModel}` : ""}`
                : connected === 0 ? "No AI connected yet" : `${connected} AI${connected === 1 ? "" : "s"} connected`}
            </div>
          </div>

          {clients.length > 0 && (
            <>
              <div className={s.clientStem} />
              <div className={s.clients}>
                {clients.map((c) => (
                  <div className={s.client} key={c.id}>
                    <span className={s.clientAvatar} style={{ background: c.color }}>{initial(c.display_name)}</span>
                    <div><b>{c.display_name}</b><span>Client · hears decisions on their own page</span></div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className={s.actions}>
        {general && <button className="btn" onClick={() => onOpenChat(general.id)}>Open {general.name} <Arrow size={16} /></button>}
        {chats.filter((c) => c.id !== general?.id).slice(0, 4).map((c) => (
          <button key={c.id} className="btn btn-quiet" onClick={() => onOpenChat(c.id)}>{c.name}</button>
        ))}
      </div>
    </div>
  );
}
