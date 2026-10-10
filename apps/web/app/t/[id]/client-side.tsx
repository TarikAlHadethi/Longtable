"use client";

import { useEffect, useState } from "react";
import { Face } from "@/components/face";
import { Mark } from "@/components/mark";
import { Time } from "@/components/time";
import { browserClient } from "@/lib/supabase/browser";
import type { Member, Request } from "./types";
import s from "./client-side.module.css";

// Leaves around the edge of the glass, placed once so they never jump: which side, how far along it, how big, how
// turned, and which green.
const LEAVES = Array.from({ length: 46 }, (_, i) => {
  const side = ["top", "right", "bottom", "left"][i % 4];
  const along = ((i * 37) % 97) + 1.5;
  const size = 34 + ((i * 29) % 46);
  const turn = ((i * 53) % 70) - 35;
  const shade = i % 5;
  return { side, along, size, turn, shade, i };
});

// The way through: a small square of hazy green glass in the corner of the team's side, with the client's side
// showing dimly in it.
export function ClientPortal({ onPeek, onEnter }: { onPeek: (on: boolean) => void; onEnter: () => void }) {
  return (
    <button className={s.ball} aria-label="See the client's side" data-testid="client-portal"
      onMouseEnter={() => onPeek(true)} onMouseLeave={() => onPeek(false)} onFocus={() => onPeek(true)} onBlur={() => onPeek(false)}
      onClick={() => { onPeek(false); onEnter(); }}>
      <span className={s.ballInside} aria-hidden="true">
        <i /><i /><i />
      </span>
      <span className={s.ballShine} aria-hidden="true" />
    </button>
  );
}

// And the way back, from the client's side: the same square, clear, with the table in it.
export function TablePortal({ onEnter }: { onEnter: () => void }) {
  return (
    <button className={`${s.ball} ${s.ballBack}`} aria-label="Back to the table" data-testid="table-portal" onClick={onEnter}>
      <Mark size={34} />
    </button>
  );
}

// Leaning in: while the pointer is on the glass, the middle of the room turns to the client's green from that corner
// outward, hazy, with leaves at its edges. Nothing here can be clicked; it is only a look.
export function PortalHaze({ on }: { on: boolean }) {
  return (
    <div className={`${s.haze} ${on ? s.hazeOn : ""}`} aria-hidden="true">
      {LEAVES.map((l) => (
        <span key={l.i} className={`${s.leaf} ${s[l.side]} ${s[`g${l.shade}`]}`}
          style={{ "--along": `${l.along}%`, "--size": `${l.size}px`, "--turn": `${l.turn}deg`, "--d": `${(l.i % 9) * 26}ms` } as React.CSSProperties} />
      ))}
    </div>
  );
}

type Update = { id: string; body: string; request_id: string | null; created_at: string; answer: string | null };
type Event = { id: number; request_id: string; label: string; created_at: string };
const WORDS: Record<string, string> = {
  asked: "With the team", "being decided": "Being decided", question: "Waiting on them", answered: "They answered",
  decided: "Decided", planned: "Planned", "ready to try": "Ready to try", done: "Done",
};

// The client's side, as the team may see it: what each client asked for, where each request stands, and the words
// they were told. Their private chat with their own AI is theirs alone and is not here.
export function ClientSide({ table, clients, requests, onInvite }: {
  table: { id: string; name: string };
  clients: Member[];
  requests: Request[];
  onInvite?: () => void;
}) {
  const [updates, setUpdates] = useState<Update[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  useEffect(() => {
    let cancelled = false;
    const supabase = browserClient();
    Promise.all([
      supabase.from("client_updates").select("id, body, request_id, created_at, answer").eq("table_id", table.id).order("created_at", { ascending: false }).limit(100),
      supabase.from("request_events").select("id, request_id, label, created_at").eq("table_id", table.id).order("id"),
    ]).then(([u, e]: [{ data: unknown }, { data: unknown }]) => {
      if (cancelled) return;
      setUpdates((u.data ?? []) as Update[]);
      setEvents((e.data ?? []) as Event[]);
    });
    return () => { cancelled = true; };
  }, [table.id, requests.length]);

  return (
    <div className={s.side} data-testid="client-side">
      <div className={s.inner}>
        <div className={s.head}>
          <h1 className={s.title}>The client&apos;s side</h1>
        </div>
        {clients.length === 0 && (
          <div className={s.empty}>
            <p>No client is at this table yet.</p>
            {onInvite && <button className="btn" onClick={onInvite}>Invite the client</button>}
          </div>
        )}
        {clients.map((c) => {
          const theirs = requests.filter((r) => r.member_id === c.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
          const ids = new Set(theirs.map((r) => r.id));
          const told = updates.filter((u) => !u.request_id || ids.has(u.request_id));
          return (
            <section key={c.id} className={s.client} data-client={c.display_name}>
              <div className={s.who}>
                <span className={s.face} style={{ background: c.color }}><Face who={c} /></span>
                <div><div className={s.name}>{c.display_name}</div>{c.status && <div className={s.sub}>{c.status}</div>}</div>
              </div>
              <div className={s.cols}>
                <div className={s.col}>
                  <h2 className={s.h2}>Asked for</h2>
                  {theirs.length === 0 && <p className={s.none}>Nothing yet.</p>}
                  {theirs.map((r, i) => (
                    <article key={r.id} className={s.card} style={{ animationDelay: `${i * 50}ms` }}>
                      <div className={s.cardTop}>
                        <span className={`${s.pill} ${["decided", "done", "ready to try"].includes(r.status) ? s.pillDone : ""}`}>{WORDS[r.status] ?? r.status}</span>
                        <span className={s.when}><Time iso={r.created_at} style="stamp" /></span>
                      </div>
                      <div className={s.body}>{r.body}</div>
                      <ol className={s.steps}>
                        {events.filter((e) => e.request_id === r.id).map((e) => <li key={e.id}>{e.label}</li>)}
                      </ol>
                    </article>
                  ))}
                </div>
                <div className={s.col}>
                  <h2 className={s.h2}>Was told</h2>
                  {told.length === 0 && <p className={s.none}>Nothing yet.</p>}
                  {told.map((u, i) => (
                    <article key={u.id} className={`${s.card} ${s.told}`} style={{ animationDelay: `${i * 50}ms` }}>
                      <div className={s.voice}>{u.body}</div>
                      {u.answer && <div className={s.answer}>They answered: {u.answer}</div>}
                      <div className={s.when}><Time iso={u.created_at} style="stamp" /></div>
                    </article>
                  ))}
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
