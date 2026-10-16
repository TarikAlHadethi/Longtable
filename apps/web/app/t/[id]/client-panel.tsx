"use client";

import { Face } from "@/components/face";
import { firstName } from "@/lib/names";
import styles from "./client.module.css";

// What a client's page shows beside the conversation, from client_overview: their team, and the work under way they
// may hear of. No states anywhere (his word, 17 Oct 2026: no "What you asked", never "With the team").
export type Overview = {
  team: { name: string; color: string | null; avatar: string | null; role: string; ai_on: boolean }[];
  requests: { id: string; title: string; status: string; at: string }[];
  work: { title: string; status: "working" | "done" }[];
};


export function ClientPanel({ overview, tableName, open, onClose }: {
  overview: Overview;
  tableName: string;
  open: boolean;
  onClose: () => void;
}) {
  const aiOn = overview.team.some((p) => p.ai_on);
  return (
    <aside className={`${styles.panel} ${open ? styles.panelOpen : ""}`} aria-label="Your project" data-testid="client-panel">
      <div className={styles.panelHead}>
        <span>{tableName}</span>
        <button className={styles.panelClose} onClick={onClose} aria-label="Close">×</button>
      </div>

      <section className={styles.card} style={{ "--i": 0 } as React.CSSProperties}>
        <div className={styles.cardTitle}>Your team</div>
        <div className={styles.faces}>
          {overview.team.map((p) => (
            <div key={p.name} className={styles.person} title={p.name}>
              <span className={styles.face} style={{ background: p.color ?? "var(--faint)" }}><Face who={{ display_name: p.name, avatar: p.avatar }} />{p.ai_on && <i className={styles.on} />}</span>
              <span className={styles.personName}>{firstName(p.name)}</span>
            </div>
          ))}
        </div>
        <p className={styles.cardNote} data-testid="team-ai">{aiOn ? "The team's AIs are on: you hear back in moments." : "The team's AIs are off right now. Anything you ask is answered as soon as one is on."}</p>
      </section>

      {overview.work.length > 0 && (
        <section className={styles.card} style={{ "--i": 1 } as React.CSSProperties}>
          <div className={styles.cardTitle}>Being built</div>
          <ul className={styles.work}>
            {overview.work.map((w, i) => (
              // One line each: the heading already says it is being built. The dot tells the rest: it moves while the work
              // is under way, and is still and green once it is built and with the team to check.
              <li key={`${w.title}-${i}`} className={styles.workItem} style={{ "--i": i } as React.CSSProperties}
                title={w.status === "working" ? undefined : "Built, and the team is checking it"} data-status={w.status}>
                <i className={w.status === "working" ? styles.workOn : styles.workDone} />
                <span>{w.title}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

// The first thing a client sees with nothing said yet: the team behind the project, and a few things to ask.
export function ClientWelcome({ first, tableName, team, onAsk }: { first: string; tableName: string; team: Overview["team"]; onAsk: (words: string, send: boolean) => void }) {
  return (
    <div className={styles.welcome} data-testid="chat-head">
      <div className={styles.welcomeFaces}>
        {team.slice(0, 5).map((p, i) => (
          <span key={p.name} className={styles.face} style={{ background: p.color ?? "var(--faint)", "--i": i } as React.CSSProperties}><Face who={{ display_name: p.name, avatar: p.avatar }} /></span>
        ))}
      </div>
      <h1 className={styles.welcomeTitle}>Hi {first}</h1>
      <p className={styles.welcomeLead}>This is where you talk to the team building {tableName}. Ask where things stand, or for anything new, in your own words.</p>
      <Suggestions onAsk={onAsk} />
    </div>
  );
}

// Quick things a client can ask, one press away.
export function Suggestions({ onAsk, small = false }: { onAsk: (words: string, send: boolean) => void; small?: boolean }) {
  const list: [string, string, boolean][] = [
    ["What's done so far?", "What's done so far?", true],
    ["What's being worked on?", "What's being worked on right now?", true],
    ["I'd like a change", "I'd like ", false],
  ];
  return (
    <div className={`${styles.suggest} ${small ? styles.suggestSmall : ""}`} data-testid="suggestions">
      {list.map(([label, words, send], i) => (
        <button key={label} type="button" className={styles.chip} style={{ "--i": i } as React.CSSProperties} onClick={() => onAsk(words, send)}>{label}</button>
      ))}
    </div>
  );
}
