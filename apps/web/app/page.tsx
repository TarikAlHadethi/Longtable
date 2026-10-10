import Link from "next/link";
import { Mark } from "@/components/mark";
import { Reveal } from "@/components/reveal";
import { Stage } from "./stage";
import s from "./landing.module.css";

const i = (n: number) => ({ "--i": n }) as React.CSSProperties;

// The opening screen: what Longtable is, a live look at one request going all the way through, how it works, and Start.
export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[]>> }) {
  const deleted = (await searchParams).deleted === "1";
  return (
    <div className={s.page}>
      <div className={s.glow} aria-hidden="true"><i /><i /><i /><i /></div>

      <header className={s.nav}>
        <Link href="/" className={s.brand}><Mark size={26} /> Longtable</Link>
        <nav className={s.links}>
          <a href="#how">How it works</a>
          <a href="#inside">What is inside</a>
          <Link href="/demo">Demo</Link>
        </nav>
        <span className={s.spacer} />
        <Link href="/sign-in?next=/start" className={s.signIn}>Sign in</Link>
        <Link href="/start" className="btn">Start</Link>
      </header>

      <main className={s.main}>
        <section className={s.hero}>
          {deleted && <div className={`${s.notice} rise`} role="status">Your table and everything in it was deleted.</div>}
          <div className={`${s.badge} rise`} style={i(0)}><Mark size={18} live /> Works with your own Claude Code or Codex. No API keys.</div>
          <h1 className={`${s.title} rise`} style={i(1)}>
            Your team, their AIs and your client, <span className={s.accent}>at one table.</span>
          </h1>
          <p className={`${s.sub} rise`} style={i(2)}>
            Ask a question and every teammate&apos;s AI reads the code on its own computer. The table gives one answer.
            You decide in a tap, and your client hears it in plain words.
          </p>
          <div className={`${s.buttons} rise`} style={i(3)}>
            <Link className={`btn ${s.big}`} href="/start">Start a table <span className={s.arrow}>→</span></Link>
            <Link className={`btn btn-quiet ${s.big}`} href="/demo"><span className={s.play} />Start demo</Link>
          </div>
          <div className={`${s.small} rise`} style={i(4)}>No passwords. Sign in with a code sent to your email.</div>
        </section>

        <div className={`${s.stage} rise`} style={i(6)}><Stage /></div>

        <section id="how" className={s.section}>
          <Reveal><div className={s.eyebrow}>How it works</div><h2 className={s.h2}>Three steps, no setup guide.</h2></Reveal>
          <div className={s.steps}>
            <Reveal className={s.step}>
              <div className={s.stepNo}>1</div>
              <h3>Start a table</h3>
              <p>Name what you are working on. Invite your team and your client with a link.</p>
              <div className={s.mini}>
                <div className={s.miniRow}><span className={s.miniFace} style={{ background: "oklch(0.62 0.12 30)" }}>M</span>Maya<em>owner</em></div>
                <div className={s.miniRow}><span className={s.miniFace} style={{ background: "oklch(0.6 0.1 250)" }}>S</span>Sam<em>developer</em></div>
                <div className={s.miniRow}><span className={s.miniFace} style={{ background: "oklch(0.6 0.1 310)" }}>E</span>Elena<em>client</em></div>
              </div>
            </Reveal>
            <Reveal className={s.step} delay={110}>
              <div className={s.stepNo}>2</div>
              <h3>Everyone connects their own AI</h3>
              <p>One button. It runs on your computer, on your own plan, reading your copy of the code.</p>
              <div className={s.mini}>
                <div className={s.connect}><span className={s.connectDot} />Claude connected<em>on this computer</em></div>
                <div className={s.connect}><span className={s.connectDot} />Codex connected<em>on this computer</em></div>
              </div>
            </Reveal>
            <Reveal className={s.step} delay={220}>
              <div className={s.stepNo}>3</div>
              <h3>Ask, decide, tell the client</h3>
              <p>The table answers with its sources. A decision takes one tap, and the client hears the words you chose.</p>
              <div className={s.mini}>
                <div className={s.decide}><span>Ship it for launch</span><b>✓</b></div>
                <div className={s.bar}><i /></div>
              </div>
            </Reveal>
          </div>
        </section>

        <section id="inside" className={s.section}>
          <Reveal><div className={s.eyebrow}>What is inside</div><h2 className={s.h2}>Built for small teams with a client to answer to.</h2></Reveal>
          <div className={s.bento}>
            <Reveal className={`${s.tile} ${s.wide}`}>
              <h3>Every AI gives a view. One writes the answer.</h3>
              <p>Each connected AI answers on its own first. Then one reads all the views and writes a single answer, and you can open how they got there.</p>
              <div className={s.merge}>
                <span style={{ borderColor: "oklch(0.6 0.1 250)" }}>Sam&apos;s Claude</span>
                <span style={{ borderColor: "oklch(0.62 0.1 150)" }}>Priya&apos;s Codex</span>
                <span style={{ borderColor: "oklch(0.62 0.12 30)" }}>Maya&apos;s Claude</span>
                <i />
                <b><Mark size={16} ink="var(--on-table)" /> One answer</b>
              </div>
            </Reveal>
            <Reveal className={s.tile} delay={100}>
              <h3>It reads the real code</h3>
              <p>Answers name the files they read and the commit they read them at.</p>
              <div className={s.files}><span>StaffPicker.tsx</span><span>availability.ts</span><span>reminders.ts</span><em>read main @ 4f2c9a1</em></div>
            </Reveal>
            <Reveal className={s.tile}>
              <h3>Decisions with an undo</h3>
              <p>One tap decides. A short window lets you take it back before the client hears a word.</p>
              <div className={s.undo}><span>Decided</span><u>Undo</u><i /></div>
            </Reveal>
            <Reveal className={s.tile} delay={100}>
              <h3>A page just for the client</h3>
              <p>They ask in their own words and hear decisions in words written for them. They never see the team&apos;s room.</p>
              <div className={s.two}><span>needs a role filter in the availability query</span><b>You will be able to pick your hygienist.</b></div>
            </Reveal>
            <Reveal className={s.tile} delay={200}>
              <h3>Usage in the open</h3>
              <p>See how much of each person&apos;s own plan is left, so nobody is surprised mid-week.</p>
              <div className={s.meters}>
                <div><span>This session</span><i><b style={{ width: "42%" }} /></i><em>42%</em></div>
                <div><span>This week</span><i><b style={{ width: "18%" }} /></i><em>18%</em></div>
              </div>
            </Reveal>
            <Reveal className={`${s.tile} ${s.full} ${s.dark}`}>
              <h3>Your code stays on your computers</h3>
              <p>Each AI reads its own person&apos;s copy of the project. Only its answers come to the table, and anything shaped like a key is hidden before an answer is saved. Download everything or delete the table whenever you like.</p>
              <Link href="/privacy" className={s.tileLink}>Read the privacy page →</Link>
            </Reveal>
          </div>
        </section>

        <Reveal className={s.cta}>
          <Mark size={56} ink="var(--on-table)" />
          <h2>Pull up a chair.</h2>
          <p>Start a table, connect your AI, and ask the first question.</p>
          <div className={s.buttons}>
            <Link className={`btn ${s.big} ${s.light}`} href="/start">Start a table <span className={s.arrow}>→</span></Link>
            <Link className={`btn ${s.big} ${s.ghost}`} href="/demo">Start demo</Link>
          </div>
        </Reveal>
      </main>

      <footer className={s.foot}>
        <span className={s.brand}><Mark size={20} /> Longtable</span>
        <span className={s.spacer} />
        <Link href="/demo">Demo</Link>
        <Link href="/privacy">Privacy</Link>
        <Link href="/sign-in?next=/start">Sign in</Link>
      </footer>
    </div>
  );
}
