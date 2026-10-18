# Security

Longtable holds a team's private conversations and runs AI agents on people's own computers, so security reports are
welcome and taken seriously.

## Reporting a problem

Please **do not open a public issue** for a security problem. Report it privately instead:

- On GitHub: the repository's **Security** tab, then **Report a vulnerability**. Only the maintainers see it.
- By email: hello@longtable.chat.

Include what you found, how to reproduce it, and what it lets someone do. You will get a reply as soon as possible,
and credit in the fix if you want it.

## What is in scope

- The wall between a team and its clients, between clients, and between tables (row level security, the realtime
  channels, the server functions in `supabase/migrations`).
- The background connection (`packages/connect`): how it runs Claude Code or Codex locked down, the files it opens,
  the branches it pushes, and how it updates itself.
- Handouts and the locked frame they are shown in.
- Anything that could leak a key, a sign-in, a client's words or a person's files.

[THREAT-MODEL.md](THREAT-MODEL.md) lists what is protected, how, the test that proves each part, and the gaps already
known. A report about a listed gap is still welcome if you have found a practical way to use it.

## Out of scope

- The AI providers themselves (Anthropic, OpenAI) and their apps.
- Attacks that need the person's own computer to be compromised first.
- Rate limits and denial of service against the hosted site.
