"use client";

import { useEffect, useState } from "react";
import { Mark } from "@/components/mark";
import { AiLogo } from "@/components/ai-logo";
import s from "./stage.module.css";

// The opening screen's live look at Longtable: the made-up demo team's room on the left, their client's page on
// the right, and one request travelling all the way through. Recorded words; nothing real behind it.
const ASK = "Can patients pick a specific hygienist when they book?";
const QUESTION = "How long would that take, and does it put the launch at risk?";
const TOLD = "Good news: patients will be able to pick their hygienist when they book, from launch on 30 October.";

const BEATS = [
  { tab: 0, ms: 3000 }, // 0 Elena types on her page
  { tab: 0, ms: 1800 }, // 1 it lands in the team's room
  { tab: 1, ms: 3200 }, // 2 Maya types the question
  { tab: 2, ms: 3000 }, // 3 each AI reads the code
  { tab: 2, ms: 3800 }, // 4 the views are in
  { tab: 3, ms: 5000 }, // 5 one answer
  { tab: 4, ms: 3200 }, // 6 the decision card
  { tab: 4, ms: 3400 }, // 7 picked: what Elena would be told, then Send
  { tab: 5, ms: 6500 }, // 8 Elena hears
];
const TABS = [
  { label: "The client asks", at: 0 },
  { label: "Send", at: 2 },
  { label: "Every AI weighs in", at: 3 },
  { label: "One answer", at: 5 },
  { label: "Decide", at: 6 },
  { label: "The client hears", at: 8 },
];
const tabMs = (tab: number) => BEATS.filter((b) => b.tab === tab).reduce((n, b) => n + b.ms, 0);

const VIEWS = [
  { who: "Sam's Claude", kind: "claude" as const, color: "oklch(0.6 0.1 250)", file: "src/booking/StaffPicker.tsx", view: "About a day. The staff picker already exists for dentists." },
  { who: "Priya's Codex", kind: "codex" as const, color: "oklch(0.62 0.1 150)", file: "src/booking/availability.ts", view: "A day and a half. The availability query needs a role filter." },
  { who: "Maya's Claude", kind: "claude" as const, color: "oklch(0.62 0.12 30)", file: "src/jobs/reminders.ts", view: "The reminder job assumes one provider per booking. Small change." },
];

function Typed({ text, ms }: { text: string; ms: number }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((v) => (v >= text.length ? v : v + 1)), Math.max(12, (ms * 0.8) / text.length));
    return () => clearInterval(t);
  }, [text, ms]);
  return <>{text.slice(0, n)}<span className={s.caret} /></>;
}

function Face({ letter, color, small }: { letter: string; color: string; small?: boolean }) {
  return <span className={small ? s.faceSmall : s.face} style={{ background: color }}>{letter}</span>;
}

export function Stage() {
  const [step, setStep] = useState(0);
  const [run, setRun] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => {
      if (step === BEATS.length - 1) setRun((r) => r + 1);
      setStep((n) => (n + 1) % BEATS.length);
    }, BEATS[step].ms);
    return () => clearTimeout(t);
  }, [step, run]);

  const tab = BEATS[step].tab;
  const reading = step === 3;

  return (
    <div className={s.wrap}>
      <div className={s.tabs} role="tablist" aria-label="What the preview shows">
        {TABS.map((t, i) => (
          <button key={t.label} role="tab" aria-selected={tab === i} className={`${s.tab} ${tab === i ? s.tabOn : ""} ${tab > i ? s.tabDone : ""}`}
            onClick={() => { setStep(t.at); setRun((r) => r + 1); }}>
            <span className={s.tabNo}>{i + 1}</span>{t.label}
            {tab === i && <span key={`${run}-${i}`} className={s.tabFill} style={{ animationDuration: `${tabMs(i)}ms` }} />}
          </button>
        ))}
      </div>

      <div className={s.window} aria-hidden="true">
        <div className={s.chrome}>
          <span className={s.chromeDot} /><span className={s.chromeDot} /><span className={s.chromeDot} />
          <span className={s.url}>longtable.chat</span>
        </div>

        <div className={s.grid} key={run}>
          {/* The team's side */}
          <aside className={s.side}>
            <div className={s.brand}><Mark size={20} /> Fernhill Dental</div>
            <div className={s.sideTitle}>Chats</div>
            <div className={`${s.chat} ${s.chatOn}`}># General</div>
            <div className={s.chat}># Booking flow</div>
            <div className={s.chat}># Launch</div>
            <div className={s.sideTitle}>At the table</div>
            {[["M", "Maya", "Claude", VIEWS[2].color], ["S", "Sam", "Claude", VIEWS[0].color], ["P", "Priya", "Codex", VIEWS[1].color]].map(([l, name, ai, color]) => (
              <div className={s.person} key={name}>
                <Face letter={l} color={color} small />
                <div>
                  <div className={s.personName}>{name}</div>
                  <div className={s.personMeta}><span className={`${s.on} ${reading ? s.onBusy : ""}`} />{reading ? `${ai} is reading` : `${ai} connected`}</div>
                </div>
              </div>
            ))}
            <div className={s.person}>
              <Face letter="E" color="oklch(0.6 0.1 310)" small />
              <div><div className={s.personName}>Elena Ruiz</div><div className={s.personMeta}>client</div></div>
            </div>
          </aside>

          <section className={s.room}>
            <div className={s.paneLabel}>The team&apos;s room</div>
            <div className={s.list}>
              <div className={s.msg}>
                <Face letter="S" color={VIEWS[0].color} />
                <div><div className={s.meta}><b>Sam</b> 10:31 am</div><div className={s.text}>Reminder texts are passing on staging.</div></div>
              </div>
              <div className={s.line}><span className={s.lineDot} />Sam pushed 2 commits to <code>main</code></div>

              {step >= 1 && (
                <div className={s.msg}>
                  <Face letter="E" color="oklch(0.6 0.1 310)" />
                  <div>
                    <div className={s.meta}><b>Elena Ruiz</b> client · 10:42 am</div>
                    <div className={`${s.text} ${s.clientBubble}`}>{ASK}</div>
                  </div>
                </div>
              )}
              {step >= 3 && (
                <div className={s.msg}>
                  <Face letter="M" color={VIEWS[2].color} />
                  <div><div className={s.meta}><b>Maya</b> asked the table · 10:44 am</div><div className={s.text}>{QUESTION}</div></div>
                </div>
              )}
              {(step === 3 || step === 4) && (
                <div className={s.back}>
                  <div className={s.backTitle}>The back room</div>
                  {VIEWS.map((v, i) => (
                    <div className={s.view} key={v.who} style={{ "--i": i } as React.CSSProperties}>
                      <span className={s.viewAi}><AiLogo kind={v.kind} size={16} /></span>
                      <div className={s.viewBody}>
                        <div className={s.viewWho}><b>{v.who}</b></div>
                        {step === 3
                          ? <div className={s.viewReading}><span className={s.spin} />reading <code>{v.file}</code></div>
                          : <div className={s.viewText} style={{ "--i": i } as React.CSSProperties}>{v.view}</div>}
                      </div>
                      {step === 4 && <span className={s.viewTick} style={{ "--i": i } as React.CSSProperties}>✓</span>}
                    </div>
                  ))}
                </div>
              )}
              {step >= 5 && (
                <div className={`${s.msg} ${s.answer}`}>
                  <span className={`${s.face} ${s.aiFace}`}><Mark size={20} /></span>
                  <div>
                    <div className={s.meta}><b>The table</b> one answer from 3 AIs · <span className={s.read}>read main @ 4f2c9a1</span></div>
                    <div className={`${s.text} ${s.voice}`}>About a day and a half. The form already has a staff picker; hygienists need a role filter, and the reminder job needs a small change. It fits before launch.</div>
                    <div className={s.sources}>{VIEWS.map((v) => <span key={v.file}>{v.file.split("/").pop()}</span>)}</div>
                    {step === 5 && <div className={s.how}>How they got here: Sam&apos;s and Priya&apos;s AIs agreed on the size. Maya&apos;s checked the risk in the code before writing this.</div>}
                  </div>
                </div>
              )}
              {step >= 6 && (
                <div className={`${s.card} ${step >= 7 ? s.cardDone : ""}`}>
                  <div className={s.cardTop}>Decision · requested by Elena Ruiz</div>
                  <div className={s.cardTitle}>Hygienist choice: launch or first update?</div>
                  <div className={s.options}>
                    <span className={`${s.option} ${step >= 7 ? s.optionOn : ""}`}>{step >= 7 && <i>✓</i>}Ship it for launch</span>
                    <span className={`${s.option} ${step >= 7 ? s.optionOff : ""}`}>First update</span>
                    <span className={`${s.option} ${step >= 7 ? s.optionOff : ""}`}>Ask Elena first</span>
                  </div>
                  {step === 7 && (
                    <div className={`${s.words} ${s.wordsEdit}`}><b>Elena would be told</b> {TOLD}<span className={s.caret} />
                      <span className={s.sendRow}><span className={s.send}>Send</span></span>
                    </div>
                  )}
                  {step >= 8 && <div className={s.words}><b>Elena was told</b> {TOLD}</div>}
                  {step >= 8 && <div className={s.decided}>Decided by Maya · Elena has been told</div>}
                </div>
              )}
            </div>
            <div className={`${s.composer} ${step === 2 ? s.composerOn : ""}`}>
              <span className={s.composerText}>{step === 2 ? <Typed text={QUESTION} ms={BEATS[2].ms} /> : <span className={s.placeholder}>Message # General</span>}</span>
              <span className={`${s.ask} ${step === 2 ? s.askOn : ""}`}>Send</span>
            </div>
          </section>

          {/* The client's side */}
          <section className={s.client}>
            <div className={s.paneLabel}>What the client sees</div>
            <div className={s.clientHead}>
              <Face letter="E" color="oklch(0.6 0.1 310)" />
              <div><div className={s.hello}>Good morning, Elena</div><div className={s.helloSub}>Fernhill Dental booking</div></div>
            </div>
            <div className={s.clientList}>
              <div className={s.update}><b>From your team</b>Reminder texts are ready for you to try.</div>
              {step >= 1 && (
                <div className={s.mine}>
                  <div className={s.mineBubble}>{ASK}</div>
                </div>
              )}
              {step >= 8 && <div className={`${s.update} ${s.told}`}><b>Decided</b>{TOLD}</div>}
            </div>
            <div className={`${s.composer} ${step === 0 ? s.composerOn : ""}`}>
              <span className={s.composerText}>{step === 0 ? <Typed text={ASK} ms={BEATS[0].ms} /> : <span className={s.placeholder}>Ask your team anything</span>}</span>
              <span className={`${s.ask} ${step === 0 ? s.askOn : ""}`}>Send</span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
