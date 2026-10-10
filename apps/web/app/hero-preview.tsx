"use client";

import { useEffect, useState } from "react";
import { Mark } from "@/components/mark";
import styles from "./hero.module.css";

// A small window onto the room for the opening screen: one short exchange from the made-up demo team, arriving
// line by line and starting over. Nothing real behind it.
const LINES = 5;

export function HeroPreview() {
  const [shown, setShown] = useState(0);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (shown < LINES) {
      const t = setTimeout(() => setShown((n) => n + 1), shown === 0 ? 700 : 1700);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => { setShown(0); setRound((r) => r + 1); }, 5200);
    return () => clearTimeout(t);
  }, [shown]);

  return (
    <div className={styles.preview} aria-hidden="true">
      <div className={styles.bar}>
        <span className={styles.barDot} /><span className={styles.barDot} /><span className={styles.barDot} />
        <span className={styles.barTitle}>General · Fernhill Dental booking</span>
      </div>
      <div className={styles.lines} key={round}>
        {shown >= 1 && (
          <div className={styles.line}>
            <span className={styles.avatar} style={{ background: "oklch(0.6 0.1 310)" }}>E</span>
            <div>
              <div className={styles.meta}><b>Elena Ruiz</b> client</div>
              <div className={`${styles.text} ${styles.client}`}>Can patients pick a specific hygienist when they book?</div>
            </div>
          </div>
        )}
        {shown >= 2 && (
          <div className={styles.line}>
            <span className={styles.avatar} style={{ background: "oklch(0.62 0.12 30)" }}>M</span>
            <div>
              <div className={styles.meta}><b>Maya</b></div>
              <div className={styles.text}>How long would that take, and does it put the launch at risk?</div>
            </div>
          </div>
        )}
        {shown === 3 && <div className={styles.working}><span className={styles.pulse} />Sam&apos;s and Priya&apos;s Claudes are reading the code…</div>}
        {shown >= 4 && (
          <div className={`${styles.line} ${styles.answer}`}>
            <span className={`${styles.avatar} ${styles.ai}`}><Mark size={16} /></span>
            <div>
              <div className={styles.meta}><b>The table</b> one answer from 3 Claudes</div>
              <div className={`${styles.text} ${styles.voice}`}>About a day and a half. The form already has a staff picker; the reminder job needs a small change too.</div>
              <div className={styles.chips}><span>StaffPicker.tsx</span><span>reminders.ts</span></div>
            </div>
          </div>
        )}
        {shown >= 5 && (
          <div className={styles.decided}>
            <span className={styles.tick}>✓</span> Decided: ship it for launch. <span className={styles.told}>Elena is told in her own words.</span>
          </div>
        )}
      </div>
    </div>
  );
}
