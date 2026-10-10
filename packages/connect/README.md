# longtable

Brings your own Claude Code or Codex to your team's table on [longtable.chat](https://longtable.chat), quietly, on
your own plan.

Nobody types these commands. In Longtable you press **Connect your AI**, pick Claude or ChatGPT, and your own AI
opens with a short message already written. You press Send and it runs this package for you.

What it does on your computer:

- Keeps its own clean copy of your project's committed code, in `~/.longtable`. It never touches your work folder.
- Waits for questions from your table and answers them with your own Claude Code or Codex, on your own plan.
- Sends only the answers to the table. Your code stays on your computer.
- Claude can only read and search that copy. Codex gets no tools at all.

```
longtable connect <code> [--ai claude|codex] [--repo <folder or git address>] [--app <url>]
longtable status
longtable disconnect
```

MIT licence.
