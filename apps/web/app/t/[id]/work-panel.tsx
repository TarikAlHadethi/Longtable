"use client";

import { Time } from "@/components/time";
import type { Job, Member, Task } from "./types";
import styles from "./room.module.css";
import s from "./work-panel.module.css";

// What the AIs are working on, and what they finished: one entry for each piece of work, its title first. It is only
// in the room while there is something in it. Clear takes away what is finished, for you alone; when that leaves
// nothing, the panel goes too.
export function WorkPanel({ tasks, jobs, members, aiWord, open, onOpenChat, onClear, onStop }: {
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
    return `${what}${mins >= 1 ? ` · ${mins} min` : ""}`;
  };
  return (
    <aside className={`${styles.inbox} ${open ? styles.inboxOpen : ""}`} aria-label="Work" data-testid="work-panel">
      <div className={styles.inboxHead}>
        <div className={styles.inboxTitle}>Work</div>
        {past.length > 0 && <button type="button" className={s.clear} onClick={onClear} data-testid="work-clear">Clear</button>}
      </div>
      <div className={styles.inboxList}>
        {running.map((t) => {
          const mine = jobs.filter((j) => j.task_id === t.id && j.kind !== "listen" && ["queued", "running", "waiting"].includes(j.status))
            .sort((a, b) => a.created_at.localeCompare(b.created_at));
          const stop = mine.find((j) => j.kind === "work" || j.kind === "answer") ?? mine[0];
          return (
            <div key={t.id} className={`${s.task} ${s.taskOn}`} data-testid="work-task">
              <button type="button" className={s.title} onClick={() => onOpenChat(t.chat_id)}>{t.title}</button>
              {mine.map((j) => (
                <div key={j.id} className={s.line}>
                  <span className={j.status === "running" ? s.dot : s.dotIdle} />
                  <span className={s.who}>{name(j.member_id)}</span>
                  <span className={s.what}>{doing(j)}</span>
                </div>
              ))}
              {mine.length === 0 && <div className={s.line}><span className={s.dotIdle} /><span className={s.what}>Starting</span></div>}
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
