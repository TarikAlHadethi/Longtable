"use client";

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
const prettyPlan = (plan?: string | null) => (plan ? `${plan.charAt(0).toUpperCase()}${plan.slice(1).replace(/_/g, " ")} plan` : null);

// The table's home: who is at the table, the AI each person brought and the model it is running, and how they all
// meet at the table. It moves when an AI is working.
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
  const cols = team.length + (onInvite ? 1 : 0);
  const connected = team.filter((m) => aiOf(m.id)).length;
  const anyBusy = team.some((m) => busy.has(m.id));
  const last = [...messages].reverse().find((m) => m.by_ai && (m.kind === "answer" || !m.kind));
  const lastBy = last ? members.find((m) => m.id === last.member_id) : undefined;
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
        <div className={s.tree} style={{ "--cols": cols, maxWidth: cols * 250 } as React.CSSProperties}>
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
                  <div className={`${s.stem} ${ai ? s.stemOn : ""} ${working ? s.stemBusy : ""}`} />
                  {ai ? (
                    <div className={`${s.ai} ${working ? s.aiBusy : ""}`} data-seat-ai={ai.kind}>
                      <div className={s.aiHead}>
                        <span className={`${s.aiIcon} ${ai.kind === "codex" ? s.codex : s.claude}`}>{ai.kind === "codex" ? "⌘" : "✳"}</span>
                        <span className={s.aiName}>{ai.kind === "codex" ? "Codex" : "Claude"}</span>
                        <span className={`${s.dot} ${working ? s.dotBusy : ""}`} />
                      </div>
                      <div className={s.model} key={model ?? "none"}>{model ?? "Model shows after its first answer"}</div>
                      <div className={s.aiMeta}>{working ? "Reading the code…" : plan ?? `On ${m.id === me.id ? "your" : "their"} own plan`}</div>
                    </div>
                  ) : m.id === me.id ? (
                    <button className={s.plus} onClick={onConnect}>
                      <span className={s.plusSign}>+</span>
                      <span className={s.plusTitle}>Connect your AI</span>
                      <span className={s.plusNote}>It joins the table on your own plan</span>
                    </button>
                  ) : (
                    <div className={s.none}>
                      <span className={s.plusSign}>·</span>
                      <span className={s.plusTitle}>No AI yet</span>
                      <span className={s.plusNote}>{m.display_name.split(" ")[0]} has not connected one</span>
                    </div>
                  )}
                </div>
              );
            })}
            {onInvite && (
              <div className={s.col} style={{ "--i": team.length } as React.CSSProperties}>
                <button className={s.inviteNode} onClick={onInvite}>
                  <span className={s.inviteAvatar}>+</span>
                  <div className={s.name}>Invite someone</div>
                  <div className={s.role}>A developer or your client</div>
                </button>
              </div>
            )}
          </div>

          <svg className={s.funnel} viewBox={`0 0 ${cols * 100} 100`} preserveAspectRatio="none" aria-hidden="true">
            {team.map((m, i) => {
              const x = i * 100 + 50;
              const cx = cols * 50;
              const d = `M ${x} 0 C ${x} 62, ${cx} 38, ${cx} 100`;
              const on = !!aiOf(m.id);
              return (
                <g key={m.id}>
                  <path d={d} className={on ? s.wire : s.wireOff} vectorEffect="non-scaling-stroke" />
                  {on && <path d={d} className={`${s.flow} ${busy.has(m.id) ? s.flowBusy : ""}`} vectorEffect="non-scaling-stroke" style={{ animationDelay: `${-i * 0.7}s` }} />}
                </g>
              );
            })}
          </svg>

          <div className={`${s.table} ${anyBusy ? s.tableBusy : ""}`}>
            <span className={s.tableMark}><Mark size={34} /></span>
            <div>
              <div className={s.tableTitle}>The table</div>
              <div className={s.tableSub}>
                {connected === 0 ? "No AI connected yet. Connect yours to ask the first question."
                  : anyBusy ? "Working on an answer…"
                  : `${connected} AI${connected === 1 ? "" : "s"} connected. Every question gets one answer.`}
              </div>
              {last && lastBy && (
                <div className={s.tableLast}>
                  Last answer written by {lastBy.display_name}&apos;s AI{lastModel ? <> · <b>{lastModel}</b></> : null}
                </div>
              )}
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
        {general && <button className="btn" onClick={() => onOpenChat(general.id)}>Open {general.name} <span>→</span></button>}
        {chats.filter((c) => c.id !== general?.id).slice(0, 4).map((c) => (
          <button key={c.id} className="btn btn-quiet" onClick={() => onOpenChat(c.id)}>{c.name}</button>
        ))}
      </div>
    </div>
  );
}
