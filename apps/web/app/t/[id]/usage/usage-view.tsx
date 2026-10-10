"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Mark } from "@/components/mark";
import { useInBrowser } from "@/components/time";
import { formatTime } from "@/lib/time";
import styles from "./usage.module.css";

export type Card = {
  id: string;
  name: string;
  role: "owner" | "developer" | "client";
  color: string;
  ai: string[];
  lastSeen: string | null;
  limits: { ai?: string; plan?: string | null; status?: string; windows?: { name: string; used: number; resets: string | null }[] } | null;
  limitsAt: string | null;
  jobs: number;
  tokens: number;
};

const ROLE = { owner: "Owner", developer: "Developer", client: "Client" } as const;

// "Resets in 1 h 05 min", or the day and time when it is more than a day away. Drawn in the reader's time zone.
function resets(iso: string, now: number) {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return "Resets now";
  if (ms < 24 * 3600 * 1000) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return `Resets in ${h ? `${h} h ` : ""}${String(m).padStart(h ? 2 : 1, "0")} min`;
  }
  const d = new Date(iso);
  return `Resets ${d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}, ${formatTime(iso)}`;
}

export function UsageView({ table, cards }: { table: { id: string; name: string }; cards: Card[] }) {
  const router = useRouter();
  const here = useInBrowser();
  // Limits change as people's AIs work; refresh every half minute.
  useEffect(() => {
    const t = setInterval(() => router.refresh(), 30000);
    return () => clearInterval(t);
  }, [router]);
  const now = Date.now();

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href={`/t/${table.id}`} className={styles.back}><Mark size={24} /> Back to {table.name}</Link>
      </header>
      <main className={styles.main}>
        <h1 className={styles.title}>Usage</h1>
        <p className="note" style={{ margin: 0 }}>Each AI runs on its owner&apos;s own plan. Limits are what that AI last reported, after its last piece of work.</p>
        {cards.map((c) => {
          const on = !!c.lastSeen && here && now - new Date(c.lastSeen).getTime() < 60000;
          const windows = c.limits?.windows ?? [];
          const top = Math.max(0, ...windows.map((w) => w.used));
          const status = !c.ai.length ? ["Not connected", styles.pillOff]
            : c.limits?.status === "limited" || top >= 100 ? ["At a limit", styles.pillLimit]
            : top >= 80 ? ["Near a limit", styles.pillWarn]
            : ["Active", styles.pillOk];
          return (
            <section key={c.id} className={styles.card} data-person={c.name}>
              <div className={styles.cardHead}>
                <span className={styles.avatar} style={{ background: c.color }}>{c.name.charAt(0).toUpperCase()}</span>
                <div className={styles.who}>
                  <div><span className={styles.name}>{c.name}</span> <span className={styles.role}>{ROLE[c.role]}</span></div>
                  <div className={styles.sub}>
                    {c.ai.length ? `${c.ai.join(" and ")} · ${on ? "on now" : "computer off or asleep"}` : "No AI connected yet"}
                    {c.limits?.plan ? ` · ${c.limits.plan} plan` : ""}
                  </div>
                </div>
                <span className={`${styles.pill} ${status[1]}`} data-testid="usage-status">{status[0]}</span>
              </div>
              {windows.length > 0 && (
                <div className={styles.meters}>
                  {windows.map((w) => (
                    <div key={w.name} className={styles.meter} data-window={w.name}>
                      <div className={styles.meterTop}>
                        <span className={styles.meterLabel}>{w.name.charAt(0).toUpperCase() + w.name.slice(1)} limit</span>
                        <span className={styles.meterNote}>{here && w.resets ? resets(w.resets, now) : ""}</span>
                        <span className={styles.meterPct}>{Math.round(w.used)}%</span>
                      </div>
                      <div className={styles.bar}>
                        <div className={`${styles.fill} ${w.used >= 80 ? styles.fillWarn : ""}`} style={{ width: `${Math.min(100, w.used)}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {c.ai.length > 0 && windows.length === 0 && <div className="note">Limits show here after its first piece of work.</div>}
              {c.role !== "client" && (
                <div className={styles.work}>At this table, last 7 days: {c.jobs} {c.jobs === 1 ? "answer" : "answers"}{c.tokens ? `, ${c.tokens.toLocaleString("en-US")} tokens` : ""}</div>
              )}
            </section>
          );
        })}
      </main>
    </div>
  );
}
