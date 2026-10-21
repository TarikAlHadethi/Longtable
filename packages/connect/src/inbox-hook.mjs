#!/usr/bin/env node
// What a person says in the chat while their own Claude works on their request reaches that Claude at its next step,
// as when they type to Claude Code at home while it works. Claude Code runs this hook after each tool call and when it
// is about to stop; the connection keeps the person's new messages in a file (argv[2]), and this hands over the ones
// Claude has not had yet, once each. When it is about to stop with something new, it carries on with that instead.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const inbox = process.argv[2];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let event = {};
  try { event = JSON.parse(input || "{}"); } catch {}
  let all = [];
  let who = "Your person";
  try {
    const box = JSON.parse(readFileSync(inbox, "utf8"));
    all = Array.isArray(box) ? box : box?.messages || [];
    if (box?.who) who = String(box.who).slice(0, 80);
  } catch {}
  let had = [];
  try { had = existsSync(`${inbox}.seen`) ? JSON.parse(readFileSync(`${inbox}.seen`, "utf8")) : []; } catch {}
  const fresh = (Array.isArray(all) ? all : []).filter((m) => m && m.id && !had.includes(m.id));
  if (!fresh.length) return;
  writeFileSync(`${inbox}.seen`, JSON.stringify([...had, ...fresh.map((m) => m.id)]));
  const words = `${who} said in the chat while you work (their own words, to you, like a message typed to you at home):\n`
    + fresh.map((m) => `- ${String(m.body || "").replace(/\s+/g, " ").slice(0, 4000)}`).join("\n");
  if (event.hook_event_name === "Stop") process.stdout.write(JSON.stringify({ decision: "block", reason: `${words}\nTake it into account before you finish.` }));
  else process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event.hook_event_name || "PostToolUse", additionalContext: words } }));
});
