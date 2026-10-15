import Link from "next/link";
import { Mark } from "@/components/mark";

export const metadata = { title: "Privacy · Longtable" };

// What Longtable keeps, what it never keeps, who sees what, and how to take it all away. Plain words, no promises the
// code does not keep.
export default function Privacy() {
  const h2 = { fontSize: 18, margin: "8px 0 0" } as const;
  return (
    <main style={{ maxWidth: 680, margin: "0 auto", padding: "32px 20px 56px", display: "flex", flexDirection: "column", gap: 14, lineHeight: 1.6 }}>
      <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 600, color: "var(--ink)", textDecoration: "none" }}>
        <Mark size={24} /> Longtable
      </Link>
      <h1 style={{ margin: "8px 0 0", fontSize: 30 }}>Privacy</h1>

      <h2 style={h2}>What Longtable keeps</h2>
      <p style={{ margin: 0 }}>
        Your email address, so you can sign in with a code, and the email of anyone you invite, if you type one. The tables you are at, and what is said and decided in them: messages,
        decisions, a client&apos;s requests and what they were told, and a log of who did what. For each AI that is connected, when it
        was last on and the usage numbers it reports about its own plan.
      </p>

      <h2 style={h2}>What it never keeps</h2>
      <p style={{ margin: 0 }}>
        Your code. Each person&apos;s AI reads its own copy of the project on that person&apos;s own computer, and only its answers come
        back. Your AI sign-in: Claude Code and Codex sign in on your computer and their keys stay there. Passwords:
        there are none. Anything shaped like a key is hidden before an answer is saved.
      </p>

      <h2 style={h2}>Who sees what</h2>
      <p style={{ margin: 0 }}>
        The team sees the team&apos;s chats, decisions and log. A client sees only their own requests, what they were told, and their
        private chat with their own AI, which nobody else sees. A client never sees the team&apos;s side, and the database enforces it,
        not just the page. Your AI runs on your own plan and answers only from what its job hands it.
      </p>

      <h2 style={h2}>When something breaks</h2>
      <p style={{ margin: 0 }}>
        When the website itself breaks, a short technical report goes to Sentry, an error-tracking service (stored in the EU): what
        kind of error, where in our code it happened, the browser, and the kind of page (never its full address). For a small share
        of visits it also notes how long the page took to load. A report never includes your messages, a client&apos;s chat, prompts,
        file names or contents, email addresses, names, IP addresses, cookies or sign-in details. We use it only to fix faults. The
        connection on your own computer reports nothing to anyone but your table.
      </p>

      <h2 style={h2}>Whoever runs this Longtable</h2>
      <p style={{ margin: 0 }}>
        Their page shows counts only, never names, messages or table titles. Like any hosted service, though, the database itself
        is not end-to-end encrypted, so the person who runs the server could read it. Longtable is open source, so you can run your own.
      </p>

      <h2 style={h2}>Taking it with you, or away</h2>
      <p style={{ margin: 0 }}>
        Anyone at a table can download what is theirs: in the room&apos;s sidebar, or at the bottom of a client&apos;s page. The owner can
        download the whole table, and delete it for everyone for good, from Settings, under Your data. Taking a person off a table
        ends their access at once.
      </p>
    </main>
  );
}
