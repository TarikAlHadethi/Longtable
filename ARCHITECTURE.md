# How Longtable works

A map for anyone about to change the code. The README says what Longtable is; this says where each part lives, how a
message moves, and the rules that keep it safe. Start here, then read the files it points to.

## The three parts

| Part | Where | Runs on |
| --- | --- | --- |
| The web app | `apps/web` | Vercel (Next.js 16, App Router) |
| The database | `supabase/migrations` | Supabase: Postgres, row level security, realtime, pg_cron, storage |
| The connection | `packages/connect` (npm: `longtable`) | Each person's own computer |

There is no application server of our own. The browser talks to Postgres directly with the person's own session, and
the connection talks to Postgres with a device token. **Every rule about who may see or do what is in the database**:
row level security on every table, and a `security definer` function for every change, which checks who is asking.
The web app is a view over that; a modified page gains nothing.

## The database

- **Migrations are the source of truth.** Each file in `supabase/migrations` is applied once, in name order. A
  function is changed by a new migration with `create or replace`, never by editing an old file. Before naming a new
  one, check `ls supabase/migrations` for a timestamp already taken.
- **Main tables:** `tables` (a team's table), `members` (owner, developer or client; `removed_at` for people taken
  off), `chats`, `messages`, `jobs` (the work queue), `tasks` (a piece of work on its own branch), `connections` (one
  per person's AI), `decisions` and `decision_options`, `requests` and `client_lines` (the client's side),
  `pages` (handouts), `approvals` (what a person's own Claude asks them), `activity` (the append-only log).
- **Helpers every policy uses:** `is_team(t)`, `is_owner(t)`, `may(t, what)` (a developer an owner gave a switch to),
  `can_see_chat(c)` and `member_sees_chat(c, m)` (private rooms), `client_seat(t)`.
- **Clocks:** one pg_cron job runs `tick()` every second; each part inside it has its own beat (hearing new messages,
  moving rounds on, delivering decisions, giving up on jobs whose computer is gone). A fault in one part never stops
  the others.
- **Live updates** go out with `realtime.broadcast_changes` on private channels: `team:<table>` for the team,
  `room:<chat>` for a private room's people, `client:<table>:<member>` for one client. Only the right people may
  listen; nobody may broadcast. Screens also re-read the database on a timer, because a live push can be lost.

## The connection

`packages/connect/src`, one Node program per computer, started with the computer (Task Scheduler, launchd, systemd:
`autostart.mjs`).

- `run.mjs`: the main loop. Two lanes claim jobs (`runner_claim(token, lane)`): heavy for work, light for everything
  else, so long work never blocks listening. Each job kind has its own `work*` function and prompt.
- `api.mjs`: every call to the database, all `runner_*` functions, proven with the device token (only its SHA-256 is
  stored).
- `claude.mjs`, `codex.mjs`: start the person's own Claude Code or Codex headless and read its output.
- `repo.mjs`: clean copies, worktrees and landing work as one commit on a `longtable/...` branch (`safeBranch` refuses
  any other name, whatever the server says).
- `fence.mjs`: everything from the table, a file or another AI goes inside a fence it cannot close (`inert`).
- `pointed.mjs`: opening a path a person pastes, and the never-open list (keys, `.env`, browser profiles, whole drives).
- `client-rules.mjs`: every word that decides a client's message. `unit-client-rules` fails if routing words appear
  anywhere else.
- `approve-server.mjs`: an MCP server that brings Claude Code's permission prompts to the person in Longtable.
- `update.mjs`: the connection updates itself to the version the database names (`connect_release`), checked against
  npm's own fingerprint.

**Two modes for a person's own requests.** Locked (the default for everyone else's requests): `--restricted`, read
and search only, or file edits in a work folder with no `.git` in it, no commands. Full Claude Code (a switch only the
person sets): their own settings, tools and commands in their own folder or a worktree, with every command their
settings do not already allow asked of them first. Teammates' and clients' requests are never full.

## How a message moves

1. A person sends a message in a chat. The `hear_message` trigger notes it.
2. After a moment of quiet, `listen_now` runs a free check in SQL (a question, an AI named, a request word...). Most
   chatter stops here and costs nothing.
3. Otherwise a `listen` job goes to the table's AI: a cheap model, no tools, that decides one of: stay silent, reply
   itself, `look` (the asker's own Claude reads the code and answers), or `work`.
4. **Work** is a round (`start_round`, moved on by `advance_round`): views from the other AIs, a `plan` that may hand
   parts to teammates' Claudes, `work` jobs that land on the task's branch, `review` jobs, another go if a review
   says no, then one `combine` answer from the table.
5. The answer is a `messages` row, keys hidden (`hide_secrets`), with the files it read and the commit it was based on.

**Job kinds:** `listen`, `look`, `answer`, `view`, `plan`, `work`, `review`, `combine`, `intro`, `notes`, `client`,
`sandbox`.

## The client's side

- A client sees only `client-page.tsx`, never the room. They read their own requests, lines and updates; the policies
  return nothing else (tested as every person after every random step in `chaos-db`).
- Their message goes to an assistant (`client` job): their own AI if they connected one, else the team's. It answers,
  looks at the code through a team AI with only its own question (never the client's raw words), builds a change in
  the client's own copy, or passes it to the team as a request. The client's assistant has no tools, ever.
- **A copy** is a `longtable/sandbox-*` branch the team's hosting builds as a preview. Changes are checked by the
  connection (`sandboxRefusal`, then a type check) before anything is pushed.

## Rules that are easy to break

- **Column grants.** `connections` and `requests` are read by column grant. A new column a screen selects must be
  granted to `authenticated`, or the whole list silently fails to load.
- **Old connections keep running** for about ten minutes after a release. A migration must keep old function
  signatures working: add, never rename.
- **A trigger shared by two tables** must not read a column only one of them has, even behind an `and`.
- **Postgres word edges are `\y`**, not `\b` (which is a backspace there).
- **Name the key** in any PostgREST embed between `members` and `tables` (`tables!members_table_id_fkey`): there are
  two relationships.
- **Never define a component inside another**: it remounts on every render and loses clicks and typing.
- A new "should never happen" case in the connection is logged with `trip()` as `tripwire: <fixed sentence>`, never
  thrown, never with a path, name or file contents.

## Where to look for...

| You want to change | Start in |
| --- | --- |
| The team's room | `apps/web/app/t/[id]/room.tsx`, `room.module.css` |
| The client's page | `apps/web/app/t/[id]/client-page.tsx` |
| Settings | `apps/web/app/t/[id]/settings` |
| What an AI is told | `packages/connect/src/run.mjs` (team), `client-rules.mjs` (client) |
| Who may see or do something | the newest migration that defines that function or policy (`grep -l "function name" supabase/migrations`, take the last) |
| The opening page and demo | `apps/web/app/page.tsx`, `stage.tsx`, `landing-table.tsx` |

[THREAT-MODEL.md](THREAT-MODEL.md) lists every threat, its control and the test that proves it.
