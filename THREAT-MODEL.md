# Longtable threat model

What Longtable protects, from whom, how, and which test proves it. Gaps are listed as gaps, not hidden. Kept against
the code as it is (last brought up to date 17 Oct 2026); update it with every change to who can see or do what.

## What is worth protecting

1. **The team's back room**: chats, decisions before they are made, the AIs' views and work, handouts, the activity log.
2. **What a client asked and was told**, and each client's private chat with their own AI.
3. **Each person's own AI sign-in** (Claude Code or Codex) and the device token that ties their computer to a table.
4. **The code.** Longtable never stores it. Each connection keeps a clean copy on its owner's own computer.
5. **Each person's computer**, which runs a background connection on their behalf and updates it by itself.
6. **Files on a person's computer** that they point their own AI at, and the files people attach to messages.

## Who might attack

- A **client** trying to see the team side, or another client's requests.
- A **removed person** trying to keep access.
- A **team member** trying to act as the owner, as an AI, or as another person.
- **Anyone on the internet** with the public key (it ships in every page), or with a guessed link.
- **Text inside the table** (a message, a client's words, a file, a task title, a handout, another AI's answer) trying
  to steer someone's AI.
- **A forged GitHub delivery**, or a forged update for the connection.

## How each is handled

### The wall around clients and tables

| Threat | What stops it | Proven by |
|---|---|---|
| A client reads the back room | Row level security: chats, messages, decisions, options, activity, jobs, notes, tasks, handouts are team only; connections and requests are read by column grant | step 2 (0 rows from every back-room table), step 5 (8 tables, 0 rows), step 25 |
| A client reads another client's requests | Requests, timelines and updates about a request belong to the asker; each client has their own live channel; a question for a client must be about that client's own request | step 5 (refused on the wire, 0 rows), step 34 |
| One table reads another | Every policy and function checks membership of that table | step 2, step 25, sim-rounds |
| Someone hears a channel they should not | Private channels with policies on `realtime.messages`: the team channel and the cursor channel for the team only, `client:<table>:<member>` for that client only | steps 1, 5, 37 |
| A person writes as someone else, or as an AI | Insert policies require your own member id, `kind = 'chat'`, empty meta, not `by_ai`; everything else goes through checked functions; the server sets the time | steps 3, 5, 26 |
| A client changes decisions, requests or their AI's lines | No write policies; only `client_say` and `client_reply`, which act for the caller's own seat | step 5, step 27, client AI test |
| A team member acts as the owner | Every owner action checks `is_owner` in the database; one owner per table by a unique index | step 6 settings, step 29 |
| A removed person keeps access | `removed_at` checked by every access helper; their AI disconnected, its work skipped, their command list and copy closed | step 6 settings, step 25, step 33 |
| Signed-out callers use the database | Signed-in functions refuse the public key; only invite preview and the connection's own functions accept it | step 5, step 26 |
| Someone runs delivery early | `deliver_due` runs only from the scheduler or inside `decide_and_send` for a decision the caller may make | step 2, step 5 |

### The connection and the AIs

| Threat | What stops it | Proven by |
|---|---|---|
| A device token is stolen from the database | Only its SHA-256 is stored, in a column nobody can read; disconnecting revokes it | step 3 |
| A connect code is reused or guessed | 80 random bits, one use, 15 minutes, hashed; 10 codes an hour | step 3, step 31 |
| The connection does more than its seat allows | It has no login to Longtable; it calls only the `runner_*` functions with its device token, and each checks that the job is its own | step 3, sim-rounds |
| A planted instruction steers a team AI | Claude Code runs `--restricted`: no command tools, file tools confined to the work folder, no MCP, none of the person's settings; everything from the table, a file or another AI is fenced and marked as information | step 3, step 12, unit-prompts |
| A team AI's change escapes | It edits only a work folder with no `.git` in it; the connection itself commits and pushes, and only to a `longtable/<plain-name>` branch, never the default branch, whatever the server says | unit-land, step 12, step 14 |
| A planted instruction steers a client's AI | No tools at all, an empty folder, only that client's own rows in its prompt; Codex with every tool feature off and nothing saved | step 5-ai, step 21 (four attacks on the real model) |
| A client's words reach the AI that reads the code | The team's assistant writes its own question for a deeper look; the client's words never go to it, and its reply goes through the same rules | step 21 |
| A client's AI reads the code | Clients get no copy; only owners' and developers' AIs read code | client AI test, step 21 |
| A path a person points at exposes secrets | Opened only for the connection's own person, from their own message; keys, `.env`, password stores, browser profiles, whole drives and home folders refused (also by Windows stream and short names); a folder with a secret comes as a filtered copy | unit-pointed, step 22, chaos-connect |
| Shared file text leaks | Text only, small, private files never sent, keys hidden, kept a week, only while sharing is on and the sharer is still at the table, never to a client's job | step 24, step 34 |
| A person's commands are seen by others | Only names and one line each leave the computer; only their own AI is told what a command is for; the list is forgotten when the connection ends | step 33 |
| An AI repeats a secret | `hide_secrets` (server) and `hideSecrets` (connection) replace anything key-shaped before it is stored or shared | step 3, step 29, unit-prompts |
| A forged update reaches people's computers | The connection takes only the exact version the table names, newer than its own, from the npm registry at the registry's own path, checked against its sha512 integrity, unpacked to an allow-list of files | unit-update, step 40 |
| Full Claude Code mode (a person turns it on for their own AI) runs commands someone else wanted | Off until its person turns it on, and only they can; it applies only to their own requests, never a teammate's or a client's; every command their own Claude Code settings do not already allow becomes a request only they see and answer (ten minutes, then a no); git itself refuses every push from the commands it runs (every push address is rewritten to one git cannot reach, however the command is written) and its hooks point at an empty folder; the connection alone commits and pushes, to a `longtable/...` branch with hooks off, putting two parts together or side by side | step 41, step 42, unit-approve, unit-land |
| A request is approved without its person seeing it whole | Shown whole or refused (over 2,000 characters is a no); keys hidden; "always allow" only ever adds that one plain command, never a tool or a pattern, and rules written into its file by anything else are dropped | unit-approve, step 41 |
| The branch being worked on changes the person's settings | Their settings come from their own computer (user settings, and their project's settings read from their own folder, without its hooks or its switch for loading the folder's MCP servers), never from the branch other AIs push to; no hook in the branch runs | step 42 |
| Requests bury their person | Five waiting per job, twenty per connection, sixty an hour; a job's key asks only about that job and dies when it ends | step 41 |
| A client's own copy reaches past the front end | A guard on the person's computer refuses changes to build, server, sign-in, database and test files and reads every changed file whole; the owner ticks that previews hold no real data or keys before giving a copy | unit-prompts, sim-rounds, step 17 |

### Files, handouts and the browser

| Threat | What stops it | Proven by |
|---|---|---|
| An attachment is read by the wrong person | Private storage; you write only in your own folder; the team reads its table's files; links an AI fetches from last a day and are readable by nobody | step 23, step 26 |
| A handout attacks the page around it | Shown in a sandboxed frame with no same origin (no sign-in, storage or room access), a strict content policy, no network; its bridge answers only its own frame's key | unit-pages, step 35 |
| A handout is seen outside the team | Team-only policies on handouts, versions, comments and shared values | step 35 |
| A forged GitHub delivery | HMAC-SHA256 against the table's secret, checked before anything happens; repeated deliveries ignored; secret unreadable | step 6 GitHub, step 31 |
| A live push is lost and someone acts on stale state | Pages re-read the database on reconnect, on returning to the tab, and on a timer | step 5 (pushes dropped on purpose) |
| An error report leaks a message, a name, an email, a file name or a key | Web app only, real site only; every report rebuilt from a short safe list in `apps/web/lib/report.mjs` | unit-report |
| A key is committed to the repository | A pre-commit scan of everything staged; the whole history can be scanned | unit-scan |

### Limits

Client messages (30 an hour, 60 with a copy), new tables (10 a day), connect codes (10 an hour), uploads not yet sent
(10), attachments (25 MB each, 200 MB per person per table), changes to a client's copy (set by the owner).

## Known gaps

- **A removed person's open live channel** is closed by their own page, not the server. A modified page could keep
  receiving pushes until it reconnects. Fix: re-check channel access on a short interval, or rotate the table's
  channel names when someone is removed.
- **Presence and cursors can be faked by a team member** (display only: who is looking, and where a pointer is).
- **The GitHub signature check is not constant-time.** Across the network the timing difference is far below the
  noise, but a constant-time compare is the textbook answer.
- **Read-only is not secret-proof.** A team member's AI can read anything committed to their repo, including a secret
  committed by mistake. The key filters catch common key shapes, not all of them.
- **The copy guard is a filter, not a wall.** It is why the owner confirms that previews hold no real data or keys.
- **A handout can load scripts from three public code hosts**, and so could put words in such an address.
- **A different Claude account on the same computer** reuses the connection's saved sign-in until it signs in again.
- **Windows sign-in start.** The connection starts from Task Scheduler; a start at Windows sign-in has not been seen
  end to end.
- **Full Claude Code mode is the person's own Claude Code**, so an allowed command runs as them, on their computer,
  with what they can reach. On Mac and Linux it runs in Claude Code's sandbox; Windows has none, so there the
  person's own judgement on each request is the wall. A command they allow can read the job's own approval key and
  the connection's Claude sign-in from its environment: the key only asks that person about that job, and the
  sign-in only makes model requests on their own plan.
- **In full Claude Code mode, other people's words still reach a Claude that can run commands.** It is told that only
  its own person decides what it runs, and everything from others is fenced as information, but a teammate's message,
  a client's words in the history, another AI's view or a handout could still talk it into a command that the
  person's own rules allow, or that auto mode judges safe. On Mac and Linux the sandbox limits what such a command can
  reach; on Windows the person's own rules and answers are the only wall. Manual mode asks about every command their
  rules do not already allow.
- **Rate limits** do not yet cover team messages or asks of the table.
- **The server is trusted.** Whoever runs a Longtable can read every table's rows. The operator page shows counts only,
  but the database is not end-to-end encrypted, by design: the server reads messages to hide keys, route a client's
  words and search for the AIs.
