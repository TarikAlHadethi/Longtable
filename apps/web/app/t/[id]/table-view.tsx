"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AI_NAME, AiLogo, type AiKind } from "@/components/ai-logo";
import { Face } from "@/components/face";
import { Check, Crown, Plus } from "@/components/icons";
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
export function TableView({ table, me, members, connections, jobs, online, messages, chats, onOpenChat, onConnect, onInvite, onModel, tableModel, onTableModel, onPerson, onAi, onTable, showcase = false }: {
  table: { id: string; name: string; main_owner?: string | null };
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
  // The opening page's picture of a table: anyone's model can be changed there, for show, and it never scrolls inside
  // itself or changes its layout on a small screen (the page scales it down whole).
  showcase?: boolean;
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
  // What a busy AI is really on, short enough for its card: "Editing send.ts", else that it works or waits its turn.
  const doing = (id: string) => {
    const run = jobs.find((j) => j.member_id === id && j.status === "running");
    if (!run) return "Up next…";
    const note = run.progress ?? "";
    if (!note || note.startsWith("\"")) return "Working…";
    const [verb, ...rest] = note.split(" ");
    const on = rest.join(" ").split(/[\\/]/).pop() ?? "";
    return `${verb.charAt(0).toUpperCase()}${verb.slice(1)}${on ? ` ${on}` : "…"}`;
  };
  // The next seat is a real place in the row, so a table of one already looks like a table.
  const cols = team.length + (onInvite ? 1 : 0) || 1;
  const onSeats = seats.filter((x) => x.seat?.on);
  const anyBusy = team.some((m) => busy(m.id));
  // The table speaks through the main owner's AI when it is on, else another owner's, else the first one that is.
  const writer = onSeats.find((x) => x.m.id === table.main_owner) ?? onSeats.find((x) => x.m.role === "owner") ?? onSeats[0];
  const last = [...messages].reverse().find((m) => m.by_ai && (m.kind === "answer" || !m.kind));
  const lastModel = prettyModel(last?.meta?.model);
  // A person's AI: what they picked, else what it last ran.
  // Automatic means a set model, not a mirror of anything else: Opus 5.5 for a person's Claude, Sonnet 5.5 for the
  // table. ChatGPT's automatic is whatever Codex itself defaults to.
  const modelText = (c: Connection) => prettyModel(c.model_choice) ?? (c.kind === "claude" ? "Opus 5.5" : prettyModel(c.limits?.model) ?? "Connected");
  const tableText = (c: Connection) => prettyModel(tableModel) ?? (c.kind === "claude" ? "Sonnet 5.5" : prettyModel(c.limits?.model) ?? "");
  const general = [...chats].sort((a, b) => Number(b.is_general) - Number(a.is_general))[0];
  // A new table's first steps, for its owner: each ticks itself from what really happened, and the row goes once all
  // four are done.
  const mySeat = seatOf(me.id);
  const steps = [
    { label: "Connect your AI", done: !!mySeat && !mySeat.removed, go: onConnect },
    { label: "Invite your team", done: team.length > 1, go: onInvite },
    { label: "Invite a client", done: clients.some((c) => !c.test), go: onInvite },
    { label: "Ask a question", done: !!last, go: general ? () => onOpenChat(general.id) : undefined },
  ];
  const showSteps = !showcase && me.role === "owner" && steps.some((x) => !x.done);

  // The whole table fits the window: it scales itself down a little rather than scroll, and only a very large team
  // (past 68%) scrolls.
  const wrapRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  const fitNow = useRef(1);
  useLayoutEffect(() => {
    const w = wrapRef.current, inner = fitRef.current;
    if (showcase || !w || !inner || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const pad = parseFloat(getComputedStyle(w).paddingTop) + parseFloat(getComputedStyle(w).paddingBottom);
      const natural = inner.getBoundingClientRect().height / fitNow.current;
      // The row of people fits across too (a phone): it may go a little smaller for width than for height.
      // Its narrowest is 176px a seat plus the scroller's padding (table-view.module.css .tree, .scroller).
      const row = inner.querySelector<HTMLElement>("[data-fit-row]");
      const cols = row ? parseFloat(getComputedStyle(row).getPropertyValue("--cols")) || 0 : 0;
      const across = cols > 0 ? w.clientWidth / (cols * 176 + 48) : 1;
      const f = Math.min(Math.max(0.68, Math.min(1, (w.clientHeight - pad) / natural)), Math.max(0.62, Math.min(1, across)));
      if (Math.abs(f - fitNow.current) > 0.01) { fitNow.current = f; setFit(f); }
    };
    const ro = new ResizeObserver(measure);
    ro.observe(w);
    ro.observe(inner);

    measure();
    return () => ro.disconnect();
  }, [showcase]);

  return (
    <div className={`${s.wrap} ${showcase ? s.showcase : ""}`} data-testid="table-home" ref={wrapRef}>
      <div className={s.fit} ref={fitRef} style={showcase ? undefined : { zoom: fit }}>
      <div className={s.top}>
        <Mark size={40} live />
        <div className={s.word}>Longtable</div>
        <div className={s.project}>{table.name}</div>
      </div>

      {showSteps && (
        <div className={`${s.clients} ${s.steps}`} data-testid="first-steps" aria-label="First steps">
          {steps.map((x, n) => (
            <button type="button" key={x.label} className={`${s.client} ${s.open} ${x.done ? s.stepDone : ""}`} disabled={x.done || !x.go}
              onClick={x.go} data-done={x.done}>
              <span className={`${s.clientAvatar} ${x.done ? "" : s.stepTodo}`} style={x.done ? { background: "var(--online)" } : undefined}>{x.done ? <Check size={14} /> : n + 1}</span>
              <div><b>{x.label}</b></div>
            </button>
          ))}
        </div>
      )}

      <div className={s.scroller}>
        <div className={s.tree} style={{ "--cols": cols } as React.CSSProperties} data-fit-row="">
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
                      <div className={s.aiName}>{AI_NAME[seat.conn.kind]}{plan ? ` ${plan}` : ""}</div>
                      {isBusy ? <div className={`${s.model} ${s.doing}`} key={doing(m.id)} title={doing(m.id)}>{doing(m.id)}</div>
                        : <span onClick={(e) => e.stopPropagation()}><ModelPick kind={seat.conn.kind} value={seat.conn.model_choice ?? ""} text={modelText(seat.conn)} reported={seat.conn.limits?.models}
                            className={s.model} canPick={(mine || showcase) && seat.on && !!onModel} onPick={(model) => onModel?.(seat.conn.id, model)} /></span>}
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
            <Mark size={52} />
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

      </div>
    </div>
  );
}
