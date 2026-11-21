"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AiLogo } from "@/components/ai-logo";
import { firstName } from "@/lib/names";
import { elapsed } from "./work-panel";
import { isOnline, type Chat, type Connection, type Job, type Member, type Message } from "./types";
import styles from "./room.module.css";

const byTime = <T extends { created_at: string }>(a: T, b: T) => a.created_at.localeCompare(b.created_at);
// The words that name the table or an AI, as the server's own free check (listen_now) reads them.
const AI_NAMED = /\b(ai|ais|claude|chatgpt|gpt|codex|table|longtable)\b/i;

// The table thinking, from the moment someone says something it will hear until its reply or an AI's own work line
// takes over, so a reply on its way is never a blank. "Will hear" is the server's own free check (listen_now), mirrored:
// anything said straight after an AI spoke, or a message shaped like a question or a request. Like the server, only what
// was said since the table last listened counts. Shown at once only for a message plainly for the AIs (the server's
// early-answer rule: a "/" command, an AI named, or a question that names nobody else here). Anything else, a word to a
// teammate say, shows nothing while the table decides: if it answers, its reply or its work shows the moment it does.
export function useThinking({ messages, chat, working, connections, members, byId }: {
  messages: Message[]; chat: Chat | undefined; working: Job[]; connections: Connection[]; members: Member[]; byId: Map<string, Member>;
}) {
  // The newest message the table has finished listening to: nothing up to it is "thinking" any more.
  const [heard, setHeard] = useState<{ id: string; at: string } | null>(null);
  const [, setBeat] = useState(0);
  const said = useMemo(() => {
    const ms = messages.filter((m) => m.chat_id === chat?.id && (m.kind === "chat" || m.kind === "answer" || !m.kind) && m.state !== "failed").sort(byTime);
    let i = ms.length;
    while (i > 0 && !ms[i - 1].by_ai) i--;
    const run = ms.slice(i).filter((m) => !heard || m.created_at > heard.at);
    if (!run.length) return null;
    // As the chat is set up: never answered, nothing is "thinking"; answered only when an AI is named, only then.
    if (chat?.set_up === false || chat?.answers === "silent" || chat?.answers === "off") return null;
    // Only what was just said counts: something from before (said while the room only listened) was never heard.
    const lastAt = Date.parse(run[run.length - 1].created_at);
    if (chat?.answers === "named") return run.filter((m) => lastAt - Date.parse(m.created_at) < 15000).some((m) => /^\s*\/[A-Za-z]/.test(m.body) || m.body.includes("@") || AI_NAMED.test(m.body)) ? run[run.length - 1] : null;
    const prev = ms[i - 1];
    const afterAi = !!prev && Date.parse(run[0].created_at) - Date.parse(prev.created_at) < 15 * 60 * 1000;
    const strong = run.some((m) => m.body.length >= 40 || /[?@]/.test(m.body) || AI_NAMED.test(m.body)
      || /^\s*(can|could|would|will|please|pls|make|add|fix|change|update|remove|delete|build|write|check|look|why|how|what|where|when|which|who|should|is|are|does|do|did|implement|create|refactor|rename|move|review|explain|tell|show|find|lets|let's|try|use|set|put|run|test|ship|revert|undo)\b/i.test(m.body));
    return afterAi || strong ? run[run.length - 1] : null;
  }, [messages, chat?.id, chat?.answers, chat?.set_up, heard]);
  const listening = working.some((j) => j.kind === "listen" && (j.status === "queued" || j.status === "running"));
  // What the listener is hearing now; once it has finished, that is heard, so the same words never think again.
  const [hearing, setHearing] = useState<{ id: string; at: string } | null>(null);
  useEffect(() => {
    if (listening && said && hearing?.id !== said.id) setHearing({ id: said.id, at: said.created_at });
    else if (!listening && hearing && heard?.id !== hearing.id) setHeard(hearing);
  }, [listening, said, hearing, heard]);
  const aisOn = connections.some((c) => isOnline(c) && byId.get(c.member_id)?.role !== "client");
  const saidFresh = !!said && hearing?.id !== said.id && Date.now() - Date.parse(said.created_at) < 15000;
  const words = (t: string) => t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const forAi = !!said && (/^\s*\/[A-Za-z]/.test(said.body) || AI_NAMED.test(said.body)
    || (said.body.includes("?") && !members.some((o) => o.id !== said.member_id && firstName(o.display_name).length >= 2
      && words(said.body).includes(firstName(o.display_name).toLowerCase()))));
  useEffect(() => {
    if (!saidFresh || !said) return;
    const t = setTimeout(() => setBeat((b) => b + 1), Math.max(0, Date.parse(said.created_at) + 15000 - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [saidFresh, said]);
  return aisOn && forAi && !working.some((j) => j.kind !== "listen" && j.status !== "failed") && (listening || saidFresh);
}

type Entry = { j: Job; done: Message | true | null };

// The back room: the AIs on this chat's request, working or waiting, and those whose part is already in (with the
// first words of what they said) while the rest of their round goes on. A recent failure stays a while to be read.
export function useBackRoom(working: Job[], chatId: string | undefined, viewsByRound: Map<string, Message[]>): Entry[] {
  // Every job seen on a request, so one that has finished still shows its part while its round goes on. Only ever
  // added to, with what the server said, so drawing twice keeps the same.
  const seenJobs = useRef(new Map<string, Job>());
  const onRequest = working.filter((j) => j.kind !== "listen" && (j.status !== "failed" || Date.now() - new Date(j.created_at).getTime() < 15 * 60 * 1000));
  for (const j of onRequest) seenJobs.current.set(j.id, j);
  const liveRounds = new Set(onRequest.filter((j) => j.status !== "failed").map((j) => j.round).filter(Boolean));
  return [
    ...[...seenJobs.current.values()]
      .filter((j) => j.chat_id === chatId && j.round && liveRounds.has(j.round) && !onRequest.some((l) => l.id === j.id) && j.kind !== "combine" && j.kind !== "plan")
      .map((j) => ({ j, done: (viewsByRound.get(j.round as string) ?? []).find((v) => v.member_id === j.member_id && (v.meta?.part ?? "view") === (j.kind === "view" ? "view" : j.kind)) ?? (true as const) })),
    ...onRequest.map((j) => ({ j, done: null })),
  ].sort((a, b) => a.j.created_at.localeCompare(b.j.created_at));
}

// The back room: each AI on this request, what it is on right now, and a tick when its part is in.
export function BackRoom({ entries: backRoom, byId, connections, aiWord, onStop: stopJob }: {
  entries: Entry[]; byId: Map<string, Member>; connections: Connection[]; aiWord: (id: string) => string; onStop: (id: string) => void;
}) {
  return (
    <div className={styles.backRoom} data-testid="back-room">
      <div className={styles.backTitle}>The back room</div>
      {backRoom.map(({ j, done }, i) => {
        const ai = aiWord(j.member_id);
        const name = `${byId.get(j.member_id)?.display_name ?? "Someone"}'s ${ai}`;
        const kind = connections.find((c) => !c.revoked_at && c.member_id === j.member_id)?.kind ?? "claude";
        const mins = !done && j.status === "running" && j.started_at ? Math.floor((Date.now() - new Date(j.started_at).getTime()) / 60000) : 0;
        const stoppable = !done && j.status !== "failed" && (j.kind === "work" || j.kind === "answer" || j.kind === "look");
        // What it is on: the verb, then the file or search in a chip ("reading" src/booking/StaffPicker.tsx).
        const [verb, ...rest] = (j.progress ?? "").split(" ");
        const on = rest.join(" ");
        const said = done && done !== true ? (done.body.split(/(?<=[.!?])\s/)[0] ?? "").slice(0, 160) : "";
        const waiting = j.kind === "combine" ? (j.status === "waiting" ? "writes the answer once the others are in" : "writing the answer")
          : j.kind === "work" ? (j.status === "waiting" ? "starts once the others have had their say" : j.status === "queued" ? "has this next" : (j.stage ?? 0) > 0 ? "fixing what the others found" : "doing the work")
          : j.kind === "review" ? (j.status === "running" ? "looking it over" : "will look it over")
          : j.kind === "view" ? (j.status === "running" ? "giving its view" : "will give its view")
          : j.kind === "look" && j.status === "waiting" ? "answers once the others have had their say"
          : j.kind === "intro" ? "reading the project"
          : j.status === "running" ? "reading the code"
          // Queued behind its other work while its computer is on is "next", not "waiting for its computer".
          : connections.some((c) => isOnline(c) && c.member_id === j.member_id) ? "has this next"
          : "waiting for its computer";
        return (
          <div key={j.id} className={styles.brRow} style={{ "--i": i } as React.CSSProperties} data-testid="working" data-done={done ? true : undefined}>
            <span className={styles.brAi}><AiLogo kind={kind} size={16} /></span>
            <div className={styles.brBody}>
              <div className={styles.brWho}><b>{name}</b>{mins >= 1 && <span>{elapsed(mins)}</span>}
                {stoppable && <button type="button" className={styles.toolLink} data-testid="stop-job" onClick={() => stopJob(j.id)}>Stop</button>}
              </div>
              {done ? (said && <div className={styles.brText}>{said}</div>)
                : j.status === "failed" ? <div className={`${styles.brText} ${styles.workingFailed}`}>Couldn&apos;t finish: {j.error ?? "it gave up"}</div>
                : j.status === "running" ? (
                  <div className={styles.brReading} key={j.progress ?? ""}><span className={styles.brSpin} />
                    {/* What it said between steps, in its own words; otherwise what it is doing, with the file in a chip. */}
                    {j.progress?.startsWith("\"") ? <span className={styles.brSaid} data-testid="said-between">{j.progress.slice(1)}</span>
                      : j.progress && on ? <>{verb} <code>{on}</code></> : (j.progress || waiting)}
                  </div>
                )
                : <div className={styles.brWaiting}>{waiting}</div>}
            </div>
            {done && <span className={styles.brTick} aria-label="done">✓</span>}
          </div>
        );
      })}
    </div>
  );
}
