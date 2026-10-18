import { DocPage, Section } from "@/components/doc-page";

export const metadata = { title: "Privacy · Longtable" };

// What Longtable keeps, what it never keeps, who sees what, and how to take it all away. Plain words, no promises the
// code does not keep.
export default function Privacy() {
  const p = { margin: 0 } as const;
  return (
    <DocPage title="Privacy" updated="18 October 2026" note="This page is written in plain words and will be reviewed by a lawyer before paid plans launch.">
      <Section title="Who is responsible">
        <p style={p}>
          Clarus LLC, a company licensed in the Sharjah Media City (Shams) free zone, United Arab Emirates, runs the hosted service
          at longtable.chat and is responsible for the personal data it handles. You can reach us at <a href="mailto:hello@longtable.chat">hello@longtable.chat</a>. If you run your own
          copy of the open-source code, you are responsible for the data in it.
        </p>
      </Section>

      <Section title="What Longtable keeps">
        <p style={p}>
          Your email address, so you can sign in with a code, and the email of anyone you invite, if you type one. The tables you are at, and what is said and decided in them: messages,
          decisions, a client&apos;s requests and what they were told, and a log of who did what. Files people attach to a message (pictures, documents,
          voice notes, video). Handouts: the pages the AIs make for the team, with their versions and comments. For each AI that is connected, when it
          was last on, the model it runs, and the usage numbers it reports about its own plan.
        </p>
        <p style={p}>
          The names of your own Claude Code commands and skills, with one line about each, so the &quot;/&quot; menu works on any device. Only you
          see them, and they go when your AI is disconnected. What a command says stays on your computer.
        </p>
        <p style={p}>
          When you point your own AI at a file or folder on your computer and sharing is on (it is a switch in your AI&apos;s window), the text of
          those files is kept for a week so the other AIs at your table can read it for the same request. Anything shaped like a key is hidden first,
          and private files (keys, settings, instructions for your own AI) are never sent.
        </p>
        <p style={p}>Where people&apos;s pointers are on a handout is sent live to the others looking at it and never stored.</p>
      </Section>

      <Section title="What it never keeps">
        <p style={p}>
          Your code. Each person&apos;s AI reads its own copy of the project on that person&apos;s own computer, and only its answers come
          back. When the team asks the AIs to change something, the change goes from that computer to a branch of the team&apos;s own
          repository (on GitHub or wherever it lives), never to Longtable. Your AI sign-in: Claude Code and Codex sign in on your computer and their keys stay there. Passwords:
          there are none. Anything shaped like a key is hidden before an answer is saved.
        </p>
      </Section>

      <Section title="Who sees what">
        <p style={p}>
          The team sees the team&apos;s chats, decisions, handouts and log. A client sees only their own requests, what they were told, the team&apos;s
          names, and their own conversation. When the team&apos;s assistant answers a client, the team can read that conversation; a client&apos;s private chat with an AI they connected
          themselves is theirs alone. A client never sees the team&apos;s side, and the database enforces it, not just the page. Your AI runs on
          your own plan and answers only from what its job hands it.
        </p>
      </Section>

      <Section title="Your own AI">
        <p style={p}>
          Your Claude or Codex runs on your account with Anthropic or OpenAI, under their terms and privacy policies. What your AI reads for a
          job is sent to that provider the same way it is when you use it yourself. Longtable never sees your sign-in to them.
        </p>
      </Section>

      <Section title="When something breaks">
        <p style={p}>
          When the website itself breaks, a short technical report goes to Sentry, an error-tracking service (stored in the EU): what
          kind of error, where in our code it happened, the browser, and the kind of page (never its full address). For a small share
          of visits it also notes how long the page took to load. A report never includes your messages, a client&apos;s chat, prompts,
          file names or contents, email addresses, names, IP addresses, cookies or sign-in details. We use it only to fix faults. The
          connection on your own computer reports nothing to anyone but your table.
        </p>
      </Section>

      <Section title="Counting visits">
        <p style={p}>
          To see how many people use the website and how fast its pages load, it counts visits with Vercel Web Analytics and
          Speed Insights. They use no cookies and keep no personal data. What is sent is the kind of page (for example
          /t/:id, never a table&apos;s or a chat&apos;s own address), how long it took to load, the site you came from, your
          country, and your browser and device type. It is used only to understand how the site is used and how fast it is.
        </p>
      </Section>

      <Section title="What Clarus LLC can see">
        <p style={p}>
          Our operator page shows counts only, never names, messages or table titles, plus any feedback you send us, as you wrote
          it. Like any hosted service, though, the database itself is not end-to-end encrypted, so we could read it. We do not
          sell your data or use it to train any model. Longtable is open source, so you can run your own.
        </p>
      </Section>

      <Section title="Why we use it">
        <p style={p}>
          To run the service you signed up for: your account, your tables and what happens in them. To keep it working and make it
          better: error reports and visit counts, which carry no personal data. To send an invite: the email address you typed.
        </p>
      </Section>

      <Section title="Where it is kept, and who helps">
        <p style={p}>
          Supabase keeps the database and attached files, in Frankfurt (EU). Vercel serves the website, from Frankfurt, and counts
          visits. Sentry receives error reports, stored in the EU. name.com forwards mail sent to our address. These companies may
          be based outside the UAE and the EU; where they handle data there, it is under their data protection terms.
        </p>
      </Section>

      <Section title="How long it is kept">
        <p style={p}>
          What is in a table is kept while the table exists. When its owner deletes it, everything in it goes, the log too, though
          copies can remain in our providers&apos; backups for a short time. Your account stays until you ask us to delete it. Error
          reports and visit counts are kept only for our providers&apos; standard periods.
        </p>
      </Section>

      <Section title="Your rights">
        <p style={p}>
          Under the UAE Personal Data Protection Law (Federal Decree-Law No. 45 of 2021) and, if you are in the EU, the GDPR, you
          can ask to see the personal data we hold about you, correct it, delete it, limit or object to how it is used, and get a
          copy to take elsewhere (Download everything does this for your tables). Write to us and we will answer within a month.
          You can also complain to a data protection authority: in the UAE, the UAE Data Office; in the EU, the authority in your
          country.
        </p>
        <p style={p}>Longtable is not meant for anyone under 16.</p>
      </Section>

      <Section title="Taking it with you, or away">
        <p style={p}>
          Anyone at a table can download what is theirs: in the room&apos;s sidebar, or at the bottom of a client&apos;s page. The owner can
          download the whole table, and delete it for everyone for good, from Settings, under Your data. Taking a person off a table
          ends their access at once.
        </p>
      </Section>

      <Section title="Questions">
        <p style={p}>Write to Clarus LLC at <a href="mailto:hello@longtable.chat">hello@longtable.chat</a> about your data or this page.</p>
      </Section>
    </DocPage>
  );
}
