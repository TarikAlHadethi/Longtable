import Link from "next/link";
import { Mark } from "@/components/mark";

// The one opening screen: what it is in a sentence, then Start or Start demo.
export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[]>> }) {
  const deleted = (await searchParams).deleted === "1";
  return (
    <main className="page-center">
      <div style={{ maxWidth: 560, display: "flex", flexDirection: "column", alignItems: "center", gap: 22, textAlign: "center" }}>
        {deleted && <div className="note" role="status">Your table and everything in it was deleted.</div>}
        <Mark size={72} />
        <div style={{ fontSize: 40, fontWeight: 600, letterSpacing: "-0.03em" }}>Longtable</div>
        <p style={{ fontFamily: "var(--font-voice)", fontSize: 24, lineHeight: 1.35, color: "var(--ink-2)", margin: 0, textWrap: "balance" }}>
          One room where your team, their AIs and your client work together.
        </p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
          <Link className="btn" href="/start">Start</Link>
          <Link className="btn btn-quiet" href="/demo">Start demo</Link>
        </div>
        <Link href="/privacy" className="note">Privacy</Link>
      </div>
    </main>
  );
}
