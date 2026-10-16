"use client";

import { useEffect, useState } from "react";
import { AI_NAME, AiLogo, type AiKind } from "@/components/ai-logo";
import { Face } from "@/components/face";
import { Arrow, Crown, Plus } from "@/components/icons";
import { Mark } from "@/components/mark";
import { ModelPick, prettyModel } from "./model-pick";
import type { Chat, Connection, Job, Member, Message } from "./types";
import s from "./table-view.module.css";

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
export { prettyModel };
const prettyPlan = (plan?: string | null) => (plan ? `${cap(plan).replace(/_/g, " ")}` : null);
// Which maker a model name belongs to, for answers written before the table knew.
export const kindOfModel = (model?: string | null): AiKind => (/gpt|codex|^o\d/i.test(model ?? "") ? "codex" : "claude");

// A connection counts as on while it keeps checking in. After this long without a word, its seat goes quiet.
const QUIET_MS = 75 * 1000;

// The table's home: who is at the table, the AI each person brought and the model it is running, and how they all
// meet at the table. Everything hangs from one centred column, so the people always sit squarely over the table.
export function TableView({ table, me, members, connections, jobs, online, messages, chats, onOpenChat, onConnect, onInvite, onModel, tableModel, onTableModel, onPerson, onAi, onTable, pickAny = false }: {
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
  onModel?: (conn: string, model: string) => void;
  tableModel: string | null;
  onTableModel: (model: string) => void;
  // Every card on the table opens its own window.
  onPerson: (id: string) => void;
  onAi: (member: string) => void;
  onTable: () => void;
  // The opening page's picture of a table: anyone's model can be changed there, for show.
  pickAny?: boolean;
}) {
  const keyOpen = (go: () => void) => (e: React.KeyboardEvent) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); go(); } };
  // A clock, so a seat goes quiet by itself when its computer is switched off.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  const team = members.filter((m) => m.role !== "client");
  const clients = members.filter((m) => m.role === "client");
  // Each person's seat: their live connection, else the last one they had, so the tree remembers what it was.
  const seatOf = (id: string) => {
    const all = connections.filter((c) => c.member_id === id);
    const conn = all.find((c) => !c.revoked_at) ?? [...all].sort((a, b) => (b.revoked_at ?? "").localeCompare(a.revoked_at ?? ""))[0];
    if (!conn) return null;
    const on = !conn.revoked_at && !!conn.last_seen && now - new Date(conn.last_seen).getTime() < QUIET_MS;
    return { conn, on, removed: !!conn.revoked_at };
  };
  const working = new Set(jobs.filter((j) => j.status === "running" || j.status === "queued" || j.status === "waiting").map((j) => j.member_id));
  const seats = team.map((m) => ({ m, seat: seatOf(m.id) }));
  const busy = (id: string) => working.has(id) && !!seats.find((x) => x.m.id === id)?.seat?.on;
  // The next seat is a real place in the row, so a table of one already looks like a table.
  const cols = team.length + (onInvite ? 1 : 0) || 1;
  const onSeats = seats.filter((x) => x.seat?.on);
  const anyBusy = team.some((m) => busy(m.id));
  // The table speaks through the owner's AI when it is on, else the first one that is.
  const writer = onSeats.find((x) => x.m.role === "owner") ?? onSeats[0];
  const last = [...messages].reverse().find((m) => m.by_ai && (m.kind === "answer" || !m.kind));
  const lastModel = prettyModel(last?.meta?.model);
  // A person's AI: what they picked, else what it last ran.
  // Automatic means a set model, not a mirror of anything else: Opus 5.5 for a person's Claude, Sonnet 5.5 for the
  // table. ChatGPT's automatic is whatever Codex itself defaults to.
  const modelText = (c: Connection) => prettyModel(c.model_choice) ?? (c.kind === "claude" ? "Opus 5.5" : prettyModel(c.limits?.model) ?? "Connected");
  const tableText = (c: Connection) => prettyModel(tableModel) ?? (c.kind === "claude" ? "Sonnet 5.5" : prettyModel(c.limits?.model) ?? "");
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
            {seats.map(({ m, seat }, i) => {
              const mine = m.id === me.id;
              const isBusy = busy(m.id);
              const plan = prettyPlan(seat?.conn.limits?.plan);
              return (
                <div className={s.col} key={m.id} style={{ "--i": i } as React.CSSProperties} data-person={m.display_name}>
                  <button type="button" className={`${s.person} ${s.open}`} onClick={() => onPerson(m.id)} aria-label={`${m.display_name}: open`}>
                    <span className={s.avatar} style={{ background: m.color }}>
                      <Face who={m} />
                      {m.role === "owner" && <span className={s.crown}><Crown size={26} /></span>}
                      <i className={online.has(m.id) ? s.here : s.away} />
                    </span>
                    <div className={s.name} style={{ color: m.name_color || undefined }}>{m.display_name}</div>
                  </button>
                  <div className={`${s.stem} ${seat?.on ? s.stemOn : ""}`} />
                  {seat ? (
                    <div className={`${s.ai} ${s.open} ${s[seat.conn.kind]} ${seat.on ? "" : s.aiOff} ${isBusy ? s.aiBusy : ""}`}
                      data-seat-ai={seat.conn.kind} data-seat-on={seat.on} role="button" tabIndex={0} onClick={() => onAi(m.id)} onKeyDown={keyOpen(() => onAi(m.id))}>
                      <div className={s.aiHead}>
                        <AiLogo kind={seat.conn.kind} size={26} />
                        <span className={`${s.dot} ${isBusy ? s.dotBusy : ""}`} title={!seat.on ? "Disconnected" : isBusy ? "Working" : "Connected"} />
                      </div>
                      <div className={s.aiName}>{AI_NAME[seat.conn.kind]}{plan ? ` ${plan}` : ""}{seat.on ? "" : " · disconnected"}</div>
                      {isBusy ? <div className={s.model}>Reading the code…</div>
                        : <span onClick={(e) => e.stopPropagation()}><ModelPick kind={seat.conn.kind} value={seat.conn.model_choice ?? ""} text={modelText(seat.conn)} reported={seat.conn.limits?.models}
                            className={s.model} canPick={(mine || pickAny) && seat.on && !!onModel} onPick={(model) => onModel?.(seat.conn.id, model)} /></span>}
                      {mine && seat.removed && <button className={s.again} onClick={(e) => { e.stopPropagation(); onConnect(); }}>Connect again</button>}
                    </div>
                  ) : mine ? (
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

          {/* The wires start a little above this strip, behind the boxes, so a box that lifts never shows a gap. */}
          <svg className={s.funnel} viewBox={`0 0 ${cols * 100} 100`} preserveAspectRatio="none" aria-hidden="true">
            {/* Quiet wires are drawn first, so a live one is never dulled where they meet. */}
            {seats.map((x, i) => ({ ...x, i })).sort((a, b) => Number(!!a.seat?.on) - Number(!!b.seat?.on)).map(({ m, seat, i }) => {
              const x = i * 100 + 50;
              const cx = cols * 50;
              const d = x === cx ? `M ${x} -14 L ${cx} 100` : `M ${x} -14 L ${x} 0 C ${x} 62, ${cx} 38, ${cx} 100`;
              return (
                <g key={m.id} className={seat?.on ? `${s[`wire_${seat.conn.kind}`]} ${busy(m.id) ? s.wireBusy : ""}` : undefined}>
                  <path d={d} vectorEffect="non-scaling-stroke" className={seat?.on ? s.wire : s.wireOff} />
                  {seat?.on && <path d={d} vectorEffect="non-scaling-stroke" className={s.pulse} style={{ animationDelay: `${-i * 0.9}s` }} />}
                </g>
              );
            })}
          </svg>

          <div className={`${s.table} ${s.open} ${anyBusy ? s.tableBusy : ""}`} role="button" tabIndex={0} onClick={onTable} onKeyDown={keyOpen(onTable)} data-testid="table-card">
            <div className={s.tableTitle}>The Table</div>
            <Mark size={64} />
            {anyBusy ? <div className={s.tableModel}>Working on an answer…</div>
              : writer ? <span onClick={(e) => e.stopPropagation()}><ModelPick kind={writer.seat!.conn.kind} value={tableModel ?? ""} reported={writer.seat!.conn.limits?.models} centre testid="table-model"
                  text={`${AI_NAME[writer.seat!.conn.kind]} ${tableText(writer.seat!.conn)}`.trim()}
                  className={s.tableModel} canPick onPick={onTableModel} /></span>
              : last ? <div className={`${s.tableModel} ${s.tableQuiet}`}>{AI_NAME[kindOfModel(last.meta?.model)]}{lastModel ? ` ${lastModel}` : ""}</div>
              : <div className={s.tableModel}>No AI connected yet</div>}
          </div>

          {clients.length > 0 && (
            <>
              <div className={s.clientStem} />
              <div className={s.clients}>
                {clients.map((c) => (
                  <button type="button" className={`${s.client} ${s.open}`} key={c.id} onClick={() => onPerson(c.id)}>
                    <span className={s.clientAvatar} style={{ background: c.color }}><Face who={c} /></span>
                    <div><b>{c.display_name}</b><span>{c.test ? "Not a real person" : connections.some((x) => x.member_id === c.id && !x.revoked_at) ? "Client · assistant on" : "Client"}</span></div>
                  </button>
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
