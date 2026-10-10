# Longtable

One live room where a small software team, their AIs and their client work together.

- **The team** talks in chats, asks the table, and decides things on cards with an undo window.
- **Each person's own AI** sits at the table on that person's own plan: Claude Code for the team, Claude Code or Codex
  for the client. When someone asks the table, the AIs that are connected each give a view, and one writes the answer,
  with the files it read and how the views were settled.
- **The client** gets their own page: what they asked for, where each request stands, and the team's decisions in
  words written for them. They never see the team's side, and the database enforces it, not just the page.

Try the demo at **longtable.chat/demo**: a made-up dental clinic's team and their client, with recorded answers.

## How the AIs join

Nobody types a command and nobody hands over an API key. **Connect my Claude** (or **Connect my assistant** for a
client) opens the person's own Claude or Codex with a setup message already written. They read it and press Send.
Their AI sets up a small background connection on their own computer, which signs in once in the browser and then
starts with the computer. When the table needs that person's AI, the connection runs it there, on their own plan:

- **Team members' AIs** read a clean, read-only copy of the project's latest main, kept on their own computer. They
  cannot run commands or change files.
- **A client's AI** gets no code and no tools at all, only that client's own requests and what they were told. It
  answers what it can and passes anything new to the team.

Longtable itself never stores code or anyone's AI sign-in. See [THREAT-MODEL.md](THREAT-MODEL.md) for what is
protected, how, and the test that proves each part.

## What is in it

- Sign-in by emailed code, tables, invite links, people taken off at once
- Chats, live updates and presence, an append-only activity log
- Decision cards with recommended options, an undo window, and the exact words the client will be told
- Ask the table: views from every connected AI, one combined answer with sources and "How they got here"
- The client's page, "ask the client first" questions with answers to tap, and the client's own AI
- Settings, a Usage page with each AI's real plan limits, GitHub events in the chat, a counts-only operator page
- A privacy page, Download everything and Delete the table

## Running it yourself

You need Node 22, Docker, and Chrome for the tests.

```bash
npm install
npm run db:start
npm run dev
```

The app is at http://localhost:3000. Sign-in codes arrive in the local mail catcher at http://127.0.0.1:54324.
Copy `apps/web/.env.example` to `apps/web/.env.local` and fill it from `npx supabase status`.

Tests: `npm run test:e2e` drives real Chrome through every step (the AI steps need Claude Code signed in on the
computer). `tests/evals` holds behaviour checks on the AIs themselves:
`python -m pytest tests/evals -q`.

To be an operator of your own Longtable, add your email in SQL:
`insert into public.operators (email) values ('you@example.com');`

## Stack

Next.js 16 and React 19, Supabase (Postgres with row level security, realtime, pg_cron), and a small Node program
for the background connection that runs Claude Code or Codex locked down.

## License

MIT. See [LICENSE](LICENSE).
