import Link from "next/link";
import { Mark } from "@/components/mark";
import { HeroPreview } from "./hero-preview";
import styles from "./hero.module.css";

const i = (n: number) => ({ "--i": n }) as React.CSSProperties;

// The one opening screen: what it is in a sentence, Start or Start demo, and a small live look at the room.
export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[]>> }) {
  const deleted = (await searchParams).deleted === "1";
  return (
    <main className={styles.wrap}>
      <div className={styles.top}>
        {deleted && <div className="note rise" role="status">Your table and everything in it was deleted.</div>}
        <Mark size={76} live />
        <h1 className={`${styles.title} rise`} style={i(5)}>Longtable</h1>
        <p className={`${styles.sentence} rise`} style={i(6)}>One room where your team, their AIs and your client work together.</p>
        <div className={`${styles.buttons} rise`} style={i(7)}>
          <Link className={`btn ${styles.big}`} href="/start">Start</Link>
          <Link className={`btn btn-quiet ${styles.big}`} href="/demo">Start demo</Link>
        </div>
      </div>

      <div className="rise" style={{ ...i(9), width: "100%", display: "flex", justifyContent: "center" }}>
        <HeroPreview />
      </div>

      <div className={`${styles.points} rise`} style={i(11)}>
        <div className={styles.point}>
          <div className={styles.pointTitle}>Your own AI, on your own plan</div>
          <div className={styles.pointText}>Each person connects their own Claude or Codex with one button. No keys to hand over.</div>
        </div>
        <div className={styles.point}>
          <div className={styles.pointTitle}>One answer, with its sources</div>
          <div className={styles.pointText}>Every connected AI reads the code and gives a view. One writes the answer and shows how they got there.</div>
        </div>
        <div className={styles.point}>
          <div className={styles.pointTitle}>The client sees only their side</div>
          <div className={styles.pointText}>They ask in their own words and hear decisions in words written for them. Never the team&apos;s room.</div>
        </div>
      </div>

      <div className={`${styles.foot} rise`} style={i(12)}>
        <Link href="/privacy" className="note">Privacy</Link>
      </div>
    </main>
  );
}
