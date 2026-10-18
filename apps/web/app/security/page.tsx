import { DocPage, Section } from "@/components/doc-page";

export const metadata = { title: "Security · Longtable" };

// How Longtable keeps tables apart and AIs on a short leash, in plain words. Only what the code really does.
export default function Security() {
  const p = { margin: 0 } as const;
  return (
    <DocPage title="Security" updated="17 October 2026">
      <Section title="Tables are kept apart">
        <p style={p}>
          Who can read and change what is enforced in the database itself, not just hidden by the page. One table can never read another.
          A client can read only their own requests and what they were told, never the team&apos;s chats, decisions, handouts or log.
          These walls are tested on every change.
        </p>
      </Section>

      <Section title="The AIs run on your computers, locked down">
        <p style={p}>
          Each AI runs on its own person&apos;s computer, in a copy of the project kept apart from their own work folder. It can read and
          search that copy, and for work the team asks for, change files in it; it cannot run commands, reach outside that folder, or read
          keys and settings files. Changes go only to a branch of its own, never to the main branch. A client&apos;s assistant has no tools at
          all and never sees the code.
        </p>
      </Section>

      <Section title="Messages are information, not orders">
        <p style={p}>
          What a client, a file or another AI writes is passed to an AI fenced off as information, never as instructions, so a message cannot
          talk an AI into doing something it should not. A client&apos;s own words never reach the AI that reads the code.
        </p>
      </Section>

      <Section title="Keys and sign-ins">
        <p style={p}>
          There are no passwords: you sign in with a code sent to your email. Your AI&apos;s sign-in stays on your computer, encrypted for your
          user, and never reaches Longtable. Each connection proves itself with its own token, of which the server keeps only a fingerprint,
          and disconnecting ends it at once. Anything shaped like a key is hidden before an answer, a shared file or a handout is saved.
        </p>
      </Section>

      <Section title="Updates">
        <p style={p}>
          The connection on your computer updates itself only to the exact version the table asks for, only from the public npm registry,
          and only after checking its fingerprint. It never moves to an older version.
        </p>
      </Section>

      <Section title="What to know">
        <p style={p}>
          Longtable is a hosted service: the database is encrypted on disk by its host but not end-to-end, so whoever runs the server could
          read it. If that matters for your project, Longtable is open source and you can run your own.
        </p>
      </Section>

      <Section title="Found a problem?">
        <p style={p}>Please report it privately through the repository&apos;s Security tab on GitHub (Report a vulnerability) or to <a href="mailto:hello@longtable.chat">hello@longtable.chat</a>, and do not share the details publicly until it is fixed.</p>
      </Section>
    </DocPage>
  );
}
