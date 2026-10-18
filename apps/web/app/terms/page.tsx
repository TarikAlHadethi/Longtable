import Link from "next/link";
import { DocPage, Section } from "@/components/doc-page";

export const metadata = { title: "Terms · Longtable" };

// The terms of use, in plain words. What people agree to by using a table, and what Longtable does and does not promise.
export default function Terms() {
  const p = { margin: 0 } as const;
  return (
    <DocPage title="Terms of use" updated="17 October 2026">
      <p style={p}>By starting a table, joining one, or connecting an AI to one, you agree to these terms. If you do not agree, do not use Longtable.</p>

      <Section title="What Longtable is">
        <p style={p}>
          A shared room where a software team, the AIs each of them brings, and their client talk, decide and work together. Each AI runs on
          its own person&apos;s computer and plan. Longtable carries the conversation; it does not run the AIs for you.
        </p>
      </Section>

      <Section title="Your account and your table">
        <p style={p}>
          Keep your email account safe: signing in uses a code sent to it. The owner of a table decides who is at it, what each person can
          do, and can take anyone off it. You are responsible for whom you invite and for what is shared at your tables.
        </p>
      </Section>

      <Section title="What you put in stays yours">
        <p style={p}>
          Messages, files, decisions and code are yours and your team&apos;s. You give Longtable only the permission it needs to store them,
          show them to the people at your table, and pass them to the AIs connected to it. We do not use your content to train any model
          and do not sell it. What we keep and why is on the <Link href="/privacy">privacy page</Link>.
        </p>
      </Section>

      <Section title="Your own AI">
        <p style={p}>
          When you connect Claude Code or Codex, it runs on your own account with Anthropic or OpenAI, and their terms apply to that use.
          You are responsible for staying within your plan and their rules. Longtable is not made by, or affiliated with, Anthropic or OpenAI.
        </p>
      </Section>

      <Section title="AI answers and changes">
        <p style={p}>
          AI answers can be wrong, and changes the AIs make can break things. They go to a branch of your repository for people to look over,
          never straight to your main branch. Check anything that matters before you rely on it, merge it, or tell a client.
        </p>
      </Section>

      <Section title="Using it fairly">
        <p style={p}>
          Do not use Longtable to break the law, to harm or harass anyone, to share what you have no right to share, to get into tables or
          accounts that are not yours, or to overload or attack the service. We may stop any use that does.
        </p>
      </Section>

      <Section title="No guarantees">
        <p style={p}>
          Longtable is provided as it is, without warranties of any kind. It may change, pause or stop, and while we work to keep it running
          and your data safe, we cannot promise it will always be available or free of faults. Keep your own copies of anything important:
          you can download everything from your table at any time.
        </p>
        <p style={p}>
          As far as the law allows, whoever runs Longtable is not liable for indirect or consequential losses, or for lost data, profits or
          work, arising from your use of it or of the AIs connected to it.
        </p>
      </Section>

      <Section title="Leaving">
        <p style={p}>
          You can leave a table, download what is yours, or (as an owner) delete a table for good whenever you like. If these terms are broken
          we may remove an account or a table.
        </p>
      </Section>

      <Section title="Changes">
        <p style={p}>We may update these terms. The date at the top says when; using Longtable after a change means you accept it.</p>
      </Section>

      <Section title="Questions">
        <p style={p}>Write to <a href="mailto:hello@longtable.chat">hello@longtable.chat</a>, or use the bug and feedback button inside any table.</p>
      </Section>
    </DocPage>
  );
}
