"use client";

import { memo } from "react";
import { Face } from "@/components/face";
import { Time } from "@/components/time";
import { Inline } from "@/lib/inline";
import { firstName } from "@/lib/names";
import type { browserClient } from "@/lib/supabase/browser";
import { Answer } from "./answer";
import { Files } from "./attach";
import type { Member, Message, Page } from "./types";
import styles from "./room.module.css";

// One message in the chat. Kept apart and memoised so typing in the box, which redraws the room, does not redraw
// every message: in a long chat that cost tens of milliseconds a key.
export const NONE: never[] = [];
// The first names a message can ping with @: the team's people, never a client.
const pingNames = (members: Map<string, Member>) => [...members.values()].filter((p) => p.role !== "client" && !p.test).map((p) => firstName(p.display_name));

export const MessageRow = memo(function MessageRow({ m, who, mine, follows, held, supabase, members, views, pages, onOpenPage, repo, again }: {
  m: Message; who: Member | undefined; mine: boolean; follows: boolean; held: boolean; supabase: ReturnType<typeof browserClient>;
  members: Map<string, Member>; views: Message[]; pages: Page[]; onOpenPage: (id: string) => void; repo: string | null; again: boolean;
}) {
  const name = who?.display_name ?? "Someone";
  if (m.kind === "github") {
    return (
      <div className={styles.githubLine} data-mid={m.id} data-github="true">
        <span className={styles.githubTag}>GitHub</span>
        <span className={styles.githubText}>{m.body}</span>
        <span className={styles.githubWhen}><Time iso={m.created_at} /></span>
      </div>
    );
  }
  if (m.kind === "client") {
    return (
      <div className={`${styles.clientSay} ${follows ? styles.follow : ""} ${held ? styles.held : ""}`} data-mid={m.id} data-request={m.meta?.request ?? ""} data-follows={follows || undefined}>
        {!follows && <div className={styles.sayName} style={{ color: who?.name_color || undefined }}>{name} <span className={styles.clientTag}>client</span></div>}
        {m.meta?.answers && m.meta.question && <div className={styles.questionQuote}>Answering: {m.meta.question}</div>}
        <div className={styles.clientRow}>
          <div className={`${styles.messageAvatar} ${follows ? styles.unseen : ""}`} style={{ background: who?.color ?? "var(--faint)" }} aria-hidden={follows || undefined}><Face who={who} name={name} /></div>
          <div className={styles.bubble} data-bubble={who?.bubble ?? "stone"}>{m.body}</div>
        </div>
        {m.meta?.files?.length ? <div className={styles.clientFiles}><Files supabase={supabase} files={m.meta.files} /></div> : null}
        <div className={styles.clientTools}>
          <span className={styles.sayWhen}><Time iso={m.created_at} /></span>
        </div>
      </div>
    );
  }
  if (m.by_ai) {
    return <Answer m={m} members={members} views={views} follows={follows} pages={pages} onOpenPage={onOpenPage}
      files={m.meta?.files?.length ? <div className={styles.sayFiles}><Files supabase={supabase} files={m.meta.files} /></div> : null}
      repo={repo} again={again} />;
  }
  return (
    <div className={`${styles.say} ${mine ? styles.sayMine : ""} ${m.state === "sending" ? styles.pending : ""} ${follows ? styles.follow : ""} ${held ? styles.held : ""}`} data-mid={m.id} data-follows={follows || undefined}>
      {!mine && (
        <div className={`${styles.messageAvatar} ${follows ? styles.unseen : ""}`} style={{ background: who?.color ?? "var(--faint)" }} aria-hidden={follows || undefined}><Face who={who} name={name} /></div>
      )}
      <div className={styles.sayCol}>
        {!mine && !follows && <div className={styles.sayName} style={{ color: who?.name_color || undefined }}>{name}</div>}
        <div className={styles.bubble} data-bubble={who?.bubble ?? "stone"}><Inline text={m.body} pings={pingNames(members)} /></div>
        {m.meta?.files?.length ? <div className={styles.sayFiles}><Files supabase={supabase} files={m.meta.files} /></div> : null}
        <div className={styles.sayWhen}>
          {m.state === "failed" ? <span className={styles.failed}>Not sent</span> : <Time iso={m.created_at} />}
        </div>
      </div>
    </div>
  );
});

// A message of one's own often arrives live before its send has finished: it takes the place of the stand-in shown while
// sending, never sits beside it, so nothing is ever shown twice.
export function arrived(prev: Message[], fresh: Message[]): Message[] {
  let out = prev;
  for (const m of fresh) {
    const stand = out.findIndex((x) => x.state === "sending" && x.chat_id === m.chat_id && x.member_id === m.member_id && x.body === m.body);
    out = stand >= 0 ? [...out.slice(0, stand), ...out.slice(stand + 1), m] : [...out, m];
  }
  return out;
}
