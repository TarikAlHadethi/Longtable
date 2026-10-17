"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Mark, WorkingMark } from "@/components/mark";
import { Fit } from "@/components/fit";
import room from "../t/[id]/room.module.css";
import client from "../t/[id]/client.module.css";
import styles from "./demo.module.css";

// A made-up dental clinic's booking project: the team (Maya, Sam, Priya) and their client, Elena. Every word is
// recorded here; nothing calls a database or an AI. Each step adds one thing to the team's room or Elena's page.
const PEOPLE = {
  maya: { name: "Maya", color: "oklch(0.62 0.12 30)" },
  sam: { name: "Sam", color: "oklch(0.6 0.1 250)" },
  priya: { name: "Priya", color: "oklch(0.62 0.1 150)" },
  elena: { name: "Elena Ruiz", color: "oklch(0.6 0.1 310)" },
};
const ASK = "Some patients only want to see Sofia. Can they pick a specific hygienist when they book?";
const QUESTION = "How long would hygienist choice take, and does it put the launch at risk?";
const ANSWER =
  "About a day and a half. The booking form already has a staff picker for dentists (StaffPicker.tsx); hygienists need a role filter and their own slots in the availability query. Sam's Claude flagged one risk: the reminder job assumes one provider per booking, so it needs a small change too. Fits in the launch slack, but uses most of it.";
const HOW = "Sam's and Priya's Claudes agreed on the size. Sam's found the reminder-job risk; Maya's checked it in the code before writing this.";
const TOLD = "Good news: patients will be able to pick their hygienist when they book, from launch on 30 October.";

const STEPS = [
  "Elena, the client, asks for something in her own words, from her own page.",
  "It lands in the team's chat as a client card. Maya asks the table how big it is.",
  "Each connected AI reads the code and gives a view in the back room.",
  "One answer comes back, with the files it read and how the views were settled.",
  "Maya turns it into a decision, with the exact words Elena would be told for each option.",
  "Maya picks an option, looks over what Elena would be told, changes it if she likes, and sends it.",
  "Elena hears the decision, in those words, on her page. She never sees the team's side.",
];

function Avatar({ who }: { who: keyof typeof PEOPLE }) {
  return <div className={room.messageAvatar} style={{ background: PEOPLE[who].color }}>{PEOPLE[who].name.charAt(0)}</div>;
}

export function Demo() {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [view, setView] = useState<"team" | "client">("team");
  const last = STEPS.length - 1;

  useEffect(() => {
    if (!playing || step >= last) return;
    const t = setTimeout(() => setStep((s) => s + 1), 4200);
    return () => clearTimeout(t);
  }, [playing, step, last]);
  // On a phone, follow the story: Elena's page when she asks and when she hears, the team's room in between.
  useEffect(() => { setView(step === 0 || step === last ? "client" : "team"); }, [step, last]);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand}><Mark size={24} /> Longtable</Link>
        <span className={styles.badge}>Demo: a made-up team, recorded answers</span>
        <span className={styles.spacer} />
        <Link className="btn" href="/start">Start your own</Link>
      </header>

      <div className={styles.caption} role="status" data-testid="demo-caption">
        <span className={styles.stepNo}>{step + 1} of {STEPS.length}</span> {STEPS[step]}
      </div>
      <div className={styles.controls}>
        <button className="btn btn-quiet" disabled={step === 0} onClick={() => { setPlaying(false); setStep((s) => s - 1); }}>Back</button>
        {step < last
          ? <button className="btn" onClick={() => { setPlaying(false); setStep((s) => s + 1); }}>Next</button>
          : <button className="btn" onClick={() => { setStep(0); setPlaying(true); }}>Watch again</button>}
        <button className="btn btn-quiet" onClick={() => setPlaying(!playing)} disabled={step === last}>{playing ? "Pause" : "Play"}</button>
      </div>
      <div className={styles.tabs}>
        <button className={view === "team" ? styles.tabOn : styles.tab} onClick={() => setView("team")}>The team&apos;s room</button>
        <button className={view === "client" ? styles.tabOn : styles.tab} onClick={() => setView("client")}>Elena&apos;s page</button>
      </div>

      <Fit width={1100}>
      <div className={styles.panes}>
        <section className={`${styles.pane} ${view === "team" ? styles.paneOn : ""}`} aria-label="The team's room">
          <div className={room.threadHead}>
            <div className={room.threadTitle}>General</div>
            <div className={room.threadSub}>Fernhill Dental booking · Maya, Sam, Priya and their Claudes</div>
          </div>
          <div className={`${room.list} ${styles.list}`}>
            {step >= 1 && (
              <div className={room.message}>
                <Avatar who="elena" />
                <div className={room.messageBody}>
                  <div className={room.messageMeta}><span className={room.messageName}>Elena Ruiz</span><span>client · 10:42 am</span></div>
                  <div className={`${room.messageText} ${room.clientBubble}`}>{ASK}</div>
                </div>
              </div>
            )}
            {step >= 1 && (
              // The demo is Maya's screen: her own words on the right, as yours are in the real room.
              <div className={`${room.say} ${room.sayMine}`}>
                <div className={room.bubble} data-bubble="rose">{QUESTION}</div>
              </div>
            )}
            {step === 2 && (
              <>
                <div className={room.working}><span className={room.workingDot} />Sam&apos;s Claude is giving its view…</div>
                <div className={room.working}><span className={room.workingDot} />Priya&apos;s Claude is giving its view…</div>
                <div className={room.working}><span className={room.workingDot} />Maya&apos;s Claude writes the answer once the views are in</div>
              </>
            )}
            {step >= 3 && (
              <div className={`${room.message} ${room.aiMessage}`}>
                <div className={room.aiAvatar}><Mark size={22} /></div>
                <div className={room.messageBody}>
                  <div className={room.messageMeta}>
                    <span className={room.messageName}>The table</span><span>· one answer from 3 Claudes, written by Maya&apos;s Claude</span>
                    <span>10:45 am</span><span className={room.readTag}>read main @ 4f2c9a1</span>
                  </div>
                  <div className={`${room.messageText} ${room.aiText}`}>{ANSWER}</div>
                  <div className={room.sources}>
                    {["src/booking/StaffPicker.tsx", "src/booking/availability.ts", "src/jobs/reminders.ts"].map((s) => <span key={s} className={room.source}>{s}</span>)}
                  </div>
                  <div className={styles.how}>{HOW}</div>
                </div>
              </div>
            )}
            {step >= 4 && (
              <div className={`${room.card} ${step >= 6 ? room.cardDecided : ""}`}>
                <div className={room.cardOrigin}><span className={room.cardChat}># General</span><span>· requested by Elena Ruiz</span></div>
                <div className={room.cardTitle}>Hygienist choice: launch or first update?</div>
                <div className={room.options}>
                  <div className={`${room.option} ${step >= 5 ? room.optionChosen : ""}`}><span>Ship it for launch</span><span className={room.optionTag}>Recommended</span></div>
                  <div className={`${room.option} ${step >= 6 ? room.optionFaded : ""}`}><span>First update after launch</span></div>
                  <div className={`${room.option} ${step >= 6 ? room.optionFaded : ""}`}><span>Ask Elena first</span></div>
                </div>
                {step === 5 && (
                  <div className={`${room.clientWords} ${room.clientWordsEdit}`}>
                    <div className={room.clientWordsLabel}>Elena Ruiz would be told</div>
                    <div className={room.clientWordsText}>{TOLD}</div>
                    <div className={room.sendRow}><span className="btn">Send</span></div>
                  </div>
                )}
                {step >= 6 && (
                  <>
                    <div className={room.clientWords}>
                      <div className={room.clientWordsLabel}>Elena Ruiz was told</div>
                      <div className={room.clientWordsText}>{TOLD}</div>
                    </div>
                    <div className={room.after}><div className={room.afterText}>Decided by Maya · Elena Ruiz has been told</div></div>
                  </>
                )}
              </div>
            )}
          </div>
        </section>

        {/* The client's page as it is now: one conversation, their words on the right, and under them who answers,
            one state, and what they were told. No greeting, no request cards: those were cut from the real page. */}
        <section className={`${styles.pane} ${view === "client" ? styles.paneOn : ""}`} aria-label="Elena's page">
          <div className={styles.clientHead}>Fernhill Dental booking</div>
          <div className={styles.clientChat}>
            <div className={client.turn}>
              <div className={client.mine}><div className={room.bubble} data-bubble="rose">{ASK}</div></div>
              <div className={client.back}>
                <div className={client.from}>
                  {step < 6 && <span className={client.forming} aria-hidden="true"><WorkingMark size={24} /></span>}
                  <span className={client.fromName}>The team</span>
                </div>
                {step >= 6
                  ? <div className={client.said} data-testid="demo-told">{TOLD}</div>
                  : <div className={client.formingLine}>Thinking<span className={client.formingDots}><i /><i /><i /></span></div>}
              </div>
            </div>
          </div>
        </section>
      </div>
      </Fit>
    </div>
  );
}
