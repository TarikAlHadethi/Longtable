"use client";

import { Time } from "@/components/time";
import type { Job, Member, Task } from "./types";
import styles from "./room.module.css";
import s from "./work-panel.module.css";

// How long something has been going, in words: 47 min, 3 h 12 min.
export const elapsed = (mins: number) => (mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ""}`);

// What the AIs are working on, and what they finished: one entry for each piece of work, its title first. It is only
// in the room while there is something in it. Clear takes away what is finished, for you alone; when that leaves
// nothing, the panel goes too.
export function WorkPanel({ review = [], onReview, tasks, jobs, members, aiWord, open, onOpenChat, onClear, onStop }: {
  // Clients whose own copies have changes waiting for the team's answer.
  review?: { id: string; name: string; n: number }[];
  onReview?: (memberId: string) => void;
  tasks: Task[];
  jobs: Job[];
  members: Map<string, Member>;
  aiWord: (id: string) => string;
  open: boolean;
  onOpenChat: (chatId: string) => void;
  onClear: () => void;
  onStop: (jobId: string) => void;
}) {
  const running = tasks.filter((t) => t.status === "working");
  const past = tasks.filter((t) => t.status !== "working");
  const name = (id: string) => `${members.get(id)?.display_name ?? "Someone"}'s ${aiWord(id)}`;
  // What each AI on a task is doing right now, in a few words.
  const doing = (j: Job) => {
    const mins = j.status === "running" && j.started_at ? Math.floor((Date.now() - new Date(j.started_at).getTime()) / 60000) : 0;
    const what = j.status === "waiting" ? "waiting for the others"
      : j.status === "queued" ? "up next"
      : j.kind === "plan" ? "deciding who does what"
      : j.kind === "view" ? "giving its view"
      : j.kind === "review" ? "looking it over"
      : j.kind === "combine" ? "writing it up"
      : j.progress || "working";
    return `${what}${mins >= 1 ? ` · ${elapsed(mins)}` : ""}`;
  };
  return (
    <aside className={`${styles.inbox} ${open ? styles.inboxOpen : ""}`} aria-label="Work" data-testid="work-panel">
      <div className={styles.inboxHead}>
        <div className={styles.inboxTitle}>Work</div>
        {past.length > 0 && <button type="button" className={s.clear} onClick={onClear} data-testid="work-clear">Clear</button>}
      </div>
      <div className={styles.inboxList}>
        {review.length === 0 && tasks.length === 0 && <div className={s.quiet} data-testid="work-quiet">Nothing is being worked on. Ask for something in the chat and it shows here.</div>}
        {review.map((r) => (
          <button key={r.id} type="button" className={`${s.task} ${s.review}`} onClick={() => onReview?.(r.id)} data-testid="work-review">
            <span className={s.title}>{r.name} changed {r.n === 1 ? "something" : `${r.n} things`} in their copy</span>
            <span className={s.result}>Have a look, and decide what to take.</span>
          </button>
        ))}
        {running.map((t) => {
          const mine = jobs.filter((j) => j.task_id === t.id && j.kind !== "listen" && ["queued", "running", "waiting"].includes(j.status))
            .sort((a, b) => a.created_at.localeCompare(b.created_at));
          // Between two steps of a round there may be no job in flight for a moment; the task is still being worked
          // on, and any job of it stops the whole of it.
          const stop = mine.find((j) => j.kind === "work" || j.kind === "answer") ?? mine[0] ?? jobs.find((j) => j.task_id === t.id && j.kind !== "listen");
          const fresh = Date.now() - new Date(t.created_at).getTime() < 60000;
          return (
            <div key={t.id} className={`${s.task} ${s.taskOn}`} data-testid="work-task">
              <button type="button" className={s.title} onClick={() => onOpenChat(t.chat_id)}>{t.title}</button>
              {mine.map((j) => (
                <div key={j.id} className={s.line}>
                  <span className={j.status === "running" ? s.dot : s.dotIdle} />
                  <span className={s.who}>{name(j.member_id)}</span>
                  <span className={s.what} title={doing(j)}>{doing(j)}</span>
                </div>
              ))}
              {mine.length === 0 && <div className={s.line}><span className={s.dotIdle} /><span className={s.what}>{fresh ? "Starting" : "Working"}</span></div>}
              {stop && <button type="button" className={s.stop} onClick={() => onStop(stop.id)}>Stop</button>}
            </div>
          );
        })}
        {past.map((t) => (
          <div key={t.id} className={s.task} data-testid="work-task">
            <button type="button" className={s.title} onClick={() => onOpenChat(t.chat_id)}>{t.title}</button>
            <div className={s.result}>
              {t.status === "stopped" ? "Stopped" : t.result && t.result.startsWith("changed ") ? `On ${t.branch}` : "Done, nothing changed"}
            </div>
            <div className={s.when}><Time iso={t.finished_at ?? t.created_at} style="stamp" /></div>
          </div>
        ))}
      </div>
    </aside>
  );
}
