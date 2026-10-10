# Longtable threat model

What Longtable protects, from whom, how, and which test proves it. Gaps are listed as gaps, not hidden. Written
10 Oct 2026 against the code at that date; update it with every change to who can see or do what.

## What is worth protecting

1. **The team's back room**: chats, decisions before they are made, the AIs' views, the activity log.
2. **What a client asked and was told**, and each client's private chat with their own AI.
3. **Each person's own AI sign-in** (Claude Code or Codex) and the device token that ties their computer to a table.
4. **The code.** Longtable never stores it. Each connection keeps a clean copy on its owner's own computer.
5. **Each person's computer**, which runs a background connection on their behalf.

## Who might attack

- A **client** trying to see the team side, or another client's requests.
- A **removed person** trying to keep access.
- A **team member** trying to act as the owner, or as an AI.
- **Anyone on the internet** with the public key (it ships in every page), or with a guessed link.
- **Text inside the table** (a message, a client's words, a planted instruction) trying to steer someone's AI.
- **A forged GitHub delivery.**

## How each is handled

| Threat | What stops it | Proven by |
|---|---|---|
| A client reads the back room | Row level security: chats, messages, decisions, options, activity, jobs, notes are team only; connections expose only safe columns | step 2 (0 rows from every back-room table), step 5 (8 tables, 0 rows) |
| A client reads another client's requests | Requests, timelines and updates about a request belong to the asker; each client has their own live channel | step 5 (refused on the wire, 0 rows) |
| Someone hears a channel they should not | Private channels with policies on `realtime.messages`: team channel for the team, `client:<table>:<member>` for that client only | steps 1, 5 |
| A person writes as someone else, or as an AI | Insert policies require your own member id, `kind = 'chat'`, empty meta, not `by_ai`; everything else goes through checked functions | steps 3, 5 |
| A client changes decisions, requests or their AI's lines | No write policies; only `client_ask`, `client_say`, `client_reply` | step 5, client AI test |
| A team member acts as the owner | Every owner action checks `is_owner` in the database | step 6 settings |
| A removed person keeps access | `removed_at` checked by every access helper; their AI disconnected, its work skipped | step 6 settings |
| Signed-out callers use the database | Signed-in functions refuse the public key; only invite preview and the connection's own functions accept it | step 5 |
| Someone runs delivery early | `deliver_due` runs only from the scheduler | step 5 |
| A device token is stolen from the database | Only its SHA-256 is stored, in a column nobody can read | step 3 |
| A connect code is reused or guessed | 80 random bits, one use, 15 minutes, hashed | step 3 |
| A planted instruction steers a team AI | Claude Code runs read-only (Read, Grep, Glob), `--restricted` to the clean copy, no MCP, none of the person's settings; table text is fenced and marked as information | step 3 (no command ran, no file made) |
| A planted instruction steers a client's AI | No tools at all, an empty folder, only that client's own rows in its prompt; Codex with every tool feature off and nothing saved | client AI test (no team words, no command) |
| A client's AI reads the code | Clients get no copy; `ask_table` only routes to owners' and developers' Claude | client AI test |
| An AI repeats a secret | `hide_secrets` replaces anything key-shaped before it is stored | step 3 |
| A forged GitHub delivery | HMAC-SHA256 against the table's secret, checked in the database; secret unreadable | step 6 GitHub |
| A client floods the team | 30 asks an hour per client | code review |
| The background connection does more than answer | It only calls six functions with its device token; it has no login to Longtable | step 3 |
| A live push is lost and someone acts on stale state | Pages re-read the database on reconnect, on returning to the tab, and on a timer | step 5 (pushes dropped on purpose) |

## Known gaps

- **A removed person's open live channel** is closed by their own page, not the server. A modified page could keep
  receiving pushes until it reconnects. Fix: re-check channel access on a short interval, or rotate the table's
  channel names when someone is removed.
- **The GitHub signature check is not constant-time.** Across the network the timing difference is far below the
  noise, but a constant-time compare is the textbook answer.
- **Read-only is not secret-proof.** A team member's Claude can read anything committed to their repo, including a
  secret someone committed by mistake. `hide_secrets` catches common key shapes, not all of them.
- **Windows and Claude Desktop.** Claude Desktop keeps files written into AppData in its own private folder. The
  connection now lives in `~/.longtable` and starts from Task Scheduler. A start at Windows sign-in has not been seen
  end to end yet.
- **Two clients at one table** share what was told to every client, by design. Anything about one request goes only
  to the asker.
- **Rate limits** exist only on client asks. Team messages, asks of the table and invites are not limited yet.
- **The server is trusted.** Whoever runs a Longtable can read every table's rows in the database. The operator page
  shows counts only, but the database itself is not end-to-end encrypted.
