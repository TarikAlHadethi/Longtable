import { Check } from "@/components/icons";
import Link from "next/link";
import { Mark } from "@/components/mark";
import s from "./auth.module.css";

// The frame around sign in, start and join: the form on the left, the table on the right.
export function AuthShell({ title, lead, children }: { title: string; lead?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={s.shell}>
      <main className={s.left}>
        <Link href="/" className={s.brand}><Mark size={26} /> Longtable</Link>
        <div className={s.form}>
          <h1 className={`${s.title} rise`}>{title}</h1>
          {lead && <p className={`${s.lead} rise`} style={{ "--i": 1 } as React.CSSProperties}>{lead}</p>}
          <div className={`${s.body} rise`} style={{ "--i": 2 } as React.CSSProperties}>{children}</div>
        </div>
        <div className={s.foot}><Link href="/privacy">Privacy</Link><Link href="/demo">See the demo</Link></div>
      </main>

      <aside className={s.right} aria-hidden="true">
        <div className={s.glow}><i /><i /><i /></div>
        <div className={s.scene}>
          <div className={`${s.float} ${s.f1}`}>
            <span className={s.face} style={{ background: "oklch(0.6 0.1 310)" }}>E</span>
            <div><b>Elena Ruiz</b><em>client</em><p>Can patients pick a specific hygienist when they book?</p></div>
          </div>
          <div className={`${s.float} ${s.f2}`}>
            <span className={`${s.face} ${s.ai}`}><Mark size={16} /></span>
            <div><b>The table</b><em>one answer from 3 AIs</em><p className={s.voice}>About a day and a half. It fits before launch.</p>
              <div className={s.chips}><span>StaffPicker.tsx</span><span>reminders.ts</span></div></div>
          </div>
          <div className={`${s.float} ${s.f3}`}><span className={s.tick}><Check size={12} stroke={3} /></span> Decided: ship it for launch</div>
        </div>
        <div className={s.quote}>
          <Mark size={44} ink="var(--on-night)" />
          <p>One room where your team, their AIs and your client work together.</p>
        </div>
      </aside>
    </div>
  );
}
