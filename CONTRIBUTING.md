# Contributing

Thanks for looking. Longtable is early, so bug reports, ideas and pull requests all help.

## Ways to help

- **Found a bug?** Open an issue with the bug template: what you did, what you expected, what happened.
- **Have an idea?** Open an issue with the idea template and say what problem it solves for a team or a client.
- **Security problem?** Do not open an issue: see [SECURITY.md](SECURITY.md).
- **Want to write code?** Open an issue first for anything bigger than a small fix, so we can agree on the shape.

## Running it locally

You need Node 22, Docker, and Chrome for the browser tests.

```bash
npm install
npm run db:start
npm run dev
```

The app is at http://localhost:3000; sign-in codes arrive in the local mail catcher at http://127.0.0.1:54324. Copy
`apps/web/.env.example` to `apps/web/.env.local` and fill it from `npx supabase status`.

## Tests

- **Unit suites** need no database and no AI: `node tests/e2e/unit-connection.mjs` and the other `unit-*.mjs` files,
  plus `node tests/e2e/chaos-connect.mjs`. They run in CI on Ubuntu, macOS and Windows.
- **Database and browser suites** (`tests/e2e/step*.mjs`, `sim-rounds.mjs`) need the local stack running.
- **Real-model suites** need Claude Code (or Codex) signed in on your computer; they cost a little of your own plan.
- `node tools/house-rules.mjs` checks the repository's own rules.

A change to who can see or do what needs a test that proves it, and a line in [THREAT-MODEL.md](THREAT-MODEL.md).

## House rules

- **Plain words on screen.** "Your Claude", "client page", "How they got here". Internal words (seat, runner) stay in
  the code.
- **No em dashes** anywhere, comments included (the house rules check fails on one).
- **No keys or `.env` files** in any commit. A pre-commit scan catches common key shapes; a made-up key in a test
  carries the words `scan:fake` on its line.
- **No real people's data** in code, tests or docs. Examples use the invented Fernhill Dental team.
- **Every dropdown** uses `apps/web/components/select.tsx`, never the browser's own.
- **Nothing static:** new things arrive, answer a press and ease between states, and respect reduced motion.
- **Database changes** are new migrations in `supabase/migrations`, never edits to old ones. A new column the screens
  read from `connections` or `requests` needs a column grant.
- **Comments say why**, in plain words.

## Commits and pull requests

- Commit subjects under about 72 characters, written as commands: "Add live cursors", "Fix the chat list flash".
- One pull request per change, with what it does, why, and how you tested it.
