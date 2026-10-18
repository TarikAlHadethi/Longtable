import Link from "next/link";
import { Mark } from "@/components/mark";
import { Reveal } from "@/components/reveal";
import { Stage } from "./stage";
import { LandingTable } from "./landing-table";
import { Fit } from "@/components/fit";
import { AiLogo } from "@/components/ai-logo";
import { serverClient } from "@/lib/supabase/server";
import s from "./landing.module.css";

const i = (n: number) => ({ "--i": n }) as React.CSSProperties;

// The opening screen: what Longtable is, a live look at one request going all the way through, how it works, and Start.
export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[]>> }) {
  const deleted = (await searchParams).deleted === "1";
  // Someone already signed in is shown the way to their tables, not asked to sign in again.
  const supabase = await serverClient();
  const { data: { user } } = await supabase.auth.getUser();
  return (
    <div className={s.page}>
      <div className={s.glow} aria-hidden="true"><i /><i /><i /><i /></div>

      <header className={s.nav}>
        <Link href="/" className={s.brand}><Mark size={26} /> Longtable</Link>
        <nav className={s.links}>
          <a href="#how">How it works</a>
          <a href="#inside">What is inside</a>
          <Link href="/demo">Demo</Link>
          <a href="https://github.com/TarikAlHadethi/Longtable">GitHub</a>
        </nav>
        <span className={s.spacer} />
        {user ? <Link href="/start" className="btn" data-testid="my-tables">Your tables</Link> : (
          <>
            <Link href="/sign-in?next=/start" className={s.signIn}>Sign in</Link>
            <Link href="/start" className="btn">Start</Link>
          </>
        )}
      </header>

      <main className={s.main}>
        <section className={s.hero}>
          {deleted && <div className={`${s.notice} rise`} role="status">Your table and everything in it was deleted.</div>}
          <h1 className={`${s.title} rise`} style={i(1)}>
            Your team, their AIs and your client, <span className={s.accent}>at one table.</span>
          </h1>
          <p className={`${s.sub} rise`} style={i(2)}>
            Ask a question and every teammate&apos;s AI reads the code on its own computer. The table gives one answer.
            You pick what to tell your client, in your own words, and they hear it at once.
          </p>
          <div className={`${s.buttons} rise`} style={i(3)}>
            <Link className={`btn ${s.big}`} href="/start">Start a table <span className={s.arrow}>→</span></Link>
            <Link className={`btn btn-quiet ${s.big}`} href="/demo"><span className={s.play} />Start demo</Link>
          </div>
          <div className={`${s.small} rise`} style={i(4)}>Free during early access, and free for life for teams that join now. No passwords.</div>
        </section>

        <div className={`${s.stage} rise`} style={i(6)}><Fit width={1120}><Stage /></Fit></div>
        {/* The table as a team sees it, right under the live picture. */}
        <div id="table" className={s.tableShow}><Fit width={1120}><LandingTable /></Fit></div>

        <section id="how" className={s.section}>
          <Reveal><div className={s.eyebrow}>How it works</div><h2 className={s.h2}>Three steps, no setup guide.</h2></Reveal>
          <div className={s.steps}>
            <Reveal className={s.step}>
              <div className={s.stepNo}>1</div>
              <h3>Start a table</h3>
              <p>Name what you are working on. Invite your team and your client with a link.</p>
              <div className={s.mini}>
                <div className={s.inviteMini}><span>longtable.chat/join/fernhill</span><b>Copy link</b></div>
              </div>
            </Reveal>
            <Reveal className={s.step} delay={110}>
              <div className={s.stepNo}>2</div>
              <h3>Everyone connects their own AI</h3>
              <p>One button. It runs on your computer, on your own plan, reading your copy of the code.</p>
              <div className={s.mini}>
                <div className={s.logosMini}><AiLogo kind="claude" size={58} /><AiLogo kind="codex" size={58} /></div>
              </div>
            </Reveal>
            <Reveal className={s.step} delay={220}>
              <div className={s.stepNo}>3</div>
              <h3>Ask, decide, tell the client</h3>
              <p>The table answers with its sources. Pick a decision, check the words the client would be told, and send.</p>
              <div className={s.mini}>
                <div className={s.toldMini}>Good news: you can pick your hygienist at launch.</div>
                <div className={s.toldNote}>Sent to Elena</div>
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
                <span><AiLogo kind="claude" size={16} />Sam&apos;s Claude</span>
                <span><AiLogo kind="codex" size={16} />Priya&apos;s Codex</span>
                <span><AiLogo kind="claude" size={16} />Maya&apos;s Claude</span>
                <i />
                <b><Mark size={16} ink="var(--on-table)" /> One answer</b>
              </div>
            </Reveal>
            <Reveal className={s.tile} delay={100}>
              <h3>The AIs do the work</h3>
              <p>Ask for a change in the chat. Your AIs make it on a branch of its own, look over each other&apos;s work, and tell you what to check.</p>
              <div className={s.files}><span>longtable/hygienist-choice</span><em>3 files changed · looked over by 2 AIs</em></div>
            </Reveal>
            <Reveal className={s.tile}>
              <h3>Handouts</h3>
              <p>Plans, mockups and charts the AIs make for the team, with versions, comments and everyone&apos;s cursor on the page.</p>
              <div className={s.handout}><b>Launch plan</b><span>Version 3 · 2 comments</span><i>Sam</i></div>
            </Reveal>
            <Reveal className={`${s.tile} ${s.wide}`} delay={100}>
              <h3>The client is always answered</h3>
              <p>A client&apos;s question gets a reply in moments. When it needs the code, the table checks it first; anything new goes to the team.</p>
              <div className={s.chatMini}><span>Where are we on reminders?</span><b>They are built and with the team to check.</b></div>
            </Reveal>
            <Reveal className={`${s.tile} ${s.full} ${s.dark}`}>
              <h3>Your code stays on your computers</h3>
              <p>Each AI reads its own person&apos;s copy of the project. Only its answers come to the table, and anything shaped like a key is hidden before an answer is saved. Download everything or delete the table whenever you like.</p>
              <Link href="/privacy" className={s.tileLink}>Read the privacy page →</Link>
            </Reveal>
          </div>
        </section>

        <section id="faq" className={s.section}>
          <Reveal><div className={s.eyebrow}>Questions</div><h2 className={s.h2}>Before you pull up a chair.</h2></Reveal>
          <Reveal className={s.faq}>
            <details className={s.faqItem}>
              <summary>What does it cost?</summary>
              <p>Nothing during early access, and every table started during early access stays free for life. Later there will be a paid plan per table, still free for one person and one client, and the open-source code is always free to run yourself. The <Link href="/terms">terms</Link> say exactly what is covered.</p>
            </details>
            <details className={s.faqItem}>
              <summary>Which AIs does it work with?</summary>
              <p>Claude Code on a Claude Pro or Max plan, or Codex on a ChatGPT plan, each on your own plan: no API keys. Press Connect, your Claude or ChatGPT app opens with a message ready, press Send, then approve once in your browser. On Linux it connects through Claude Code in VS Code or the terminal.</p>
            </details>
            <details className={s.faqItem}>
              <summary>What leaves my computer?</summary>
              <p>Your code never does. Each AI reads its own copy of the project on its own computer, and only its answers come to the table, with anything shaped like a key hidden. Your AI sign-in stays on your computer. The <Link href="/privacy">privacy page</Link> has the details.</p>
            </details>
            <details className={s.faqItem}>
              <summary>What can my client see?</summary>
              <p>Only their own requests, what they were told, and who is on the team. Never the team&apos;s chats, the code, or other clients. The assistant that answers them never promises a date, a price or a new feature: anything new goes to the team first. When the team&apos;s assistant answers, the team can read every word of it.</p>
            </details>
            <details className={s.faqItem}>
              <summary>What if everyone&apos;s computer is off?</summary>
              <p>Nothing is lost. A client&apos;s message reaches the team straight away, and it is answered the moment a teammate&apos;s AI is back.</p>
            </details>
            <details className={s.faqItem}>
              <summary>Is it just for teams?</summary>
              <p>No. One developer and one client works from day one: one connected AI runs the table and answers your client.</p>
            </details>
            <details className={s.faqItem}>
              <summary>Why not Slack and Claude?</summary>
              <p>Here everyone&apos;s AI gives one answer, with the files it read; your client sits at the same table but only ever sees their side; and nobody pastes code or keys anywhere.</p>
            </details>
            <details className={s.faqItem}>
              <summary>How do I delete everything?</summary>
              <p>Anyone can download what is theirs. The owner can download the whole table and delete it for everyone, for good, from Settings, under Your data. Disconnecting your AI removes the connection from your computer.</p>
            </details>
          </Reveal>
        </section>

        <Reveal className={s.cta}>
          <Mark size={56} ink="var(--on-night)" />
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
        <a href="https://github.com/TarikAlHadethi/Longtable">Open source, MIT</a>
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/security">Security</Link>
        <Link href="/sign-in?next=/start">Sign in</Link>
      </footer>
    </div>
  );
}
