"use client";

import { AI_NAME } from "@/components/ai-logo";
import { Face } from "@/components/face";
import { useInBrowser } from "@/components/time";
import { prettyModel } from "./model-pick";
import type { Connection, Member } from "./types";
import styles from "./room.module.css";

// "in 1 h 05 min", or the day when it is more than a day away. Drawn in the reader's own time zone.
function resets(iso: string, now: number) {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return "resets now";
  if (ms < 24 * 3600 * 1000) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return `resets in ${h ? `${h} h ` : ""}${String(m).padStart(h ? 2 : 1, "0")} min`;
  }
  return `resets ${new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}`;
}

// The windows by the names people know them by: the session, the week across all models, and a week for one model.
function windowName(name: string) {
  if (name === "5-hour") return "Session limit";
  if (name === "weekly") return "Weekly · all models";
  const one = name.match(/^weekly (.+)$/);
  return one ? `Weekly · ${one[1].charAt(0).toUpperCase()}${one[1].slice(1)}` : name.charAt(0).toUpperCase() + name.slice(1);
}

// Usage, beside the table: each person's AI on their own plan, with its limits as it last reported them.
export function UsagePanel({ members, connections, bare = false }: { members: Member[]; connections: Connection[]; bare?: boolean }) {
  const here = useInBrowser();
  const now = Date.now();
  const team = members.filter((m) => m.role !== "client");
  return (
    <>
      {team.map((m, i) => {
        const conn = connections.find((c) => c.member_id === m.id && !c.revoked_at);
        const windows = conn?.limits?.windows ?? [];
        const model = prettyModel(conn?.model_choice) ?? (conn?.kind === "claude" ? "Opus 5.5" : prettyModel(conn?.limits?.model));
        return (
          <section key={m.id} className={`${styles.use} ${conn ? "" : styles.useOff}`} style={{ animationDelay: `${i * 60}ms` }} data-usage={m.display_name}>
            {!bare && <div className={styles.useHead}>
              <span className={styles.useFace} style={{ background: m.color }}><Face who={m} /></span>
              <div>
                <div className={styles.useName}>{m.display_name}</div>
                <div className={styles.useAi}>{conn ? [AI_NAME[conn.kind], conn.limits?.plan, model].filter(Boolean).join(" · ") : "No AI"}</div>
              </div>
            </div>}
            {bare && windows.length === 0 && <div className={styles.useAi}>Its limits show after its next answer.</div>}
            {windows.map((w) => (
              <div key={w.name} className={styles.meter}>
                <div className={styles.meterTop}>
                  <b>{windowName(w.name)}</b>
                  <span>{Math.round(w.used)}%{here && w.resets ? ` · ${resets(w.resets, now)}` : ""}</span>
                </div>
                <div className={styles.meterBar}>
                  <div className={`${styles.meterFill} ${w.used >= 100 ? styles.meterFull : w.used >= 80 ? styles.meterWarn : ""}`} style={{ width: `${Math.min(100, Math.max(2, w.used))}%` }} />
                </div>
              </div>
            ))}
          </section>
        );
      })}
    </>
  );
}
