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

Before changing code, read [ARCHITECTURE.md](ARCHITECTURE.md): where each part lives, how a message moves, and the
rules that are easy to break.

To try the connection against your local app, set `NEXT_PUBLIC_CONNECT_COMMAND` in `apps/web/.env.local` to
`node <path to this repo>/packages/connect/bin/longtable.mjs`, so the Connect window runs your copy instead of the one
on npm.

## Tests

| Kind | Files | Needs | Cost |
| --- | --- | --- | --- |
| Unit | `tests/e2e/unit-*.mjs`, `chaos-connect.mjs` | nothing | free, seconds |
| Database and browser | most `step*.mjs`, `sim-rounds.mjs`, `look-*.mjs` | the local stack, `npm run dev`, Chrome | free |
| Real model | `step3`, `step4`, `step12` to `step18`, `step21`, `step36`, `step42`, `probe-*.mjs` and others that connect an AI | Claude Code or Codex signed in | a little of your own plan |

- Run one with `node --experimental-websocket tests/e2e/<suite>.mjs` (the flag is needed on Node 20).
- The list CI runs against a database is in `.github/workflows/database.yml`; the unit list is in `checks.yml`.
- `node tools/house-rules.mjs` checks the repository's own rules.
- A real-model suite can miss now and then on the model's judgement or a slow reply: run it again before believing a
  failure.
- Two real-model suites at once can trip the local sign-in mail limit: run them one at a time.

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
