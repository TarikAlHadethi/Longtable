#!/usr/bin/env node
// What a person says in the chat while their own Claude works on their request reaches that Claude at its next step,
// as when they type to Claude Code at home while it works. Claude Code runs this hook after each tool call and when it
// is about to stop; the connection keeps the person's new messages in a file (argv[2]), and this hands over the ones
// Claude has not had yet, once each. When it is about to stop with something new, it carries on with that instead.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const inbox = process.argv[2];
// What they pasted from somewhere else is marked as such: information they brought, not their instructions.
function pasted(text, ranges) {
  if (!Array.isArray(ranges) || !ranges.length) return text;
  // Counted in characters, as the database counts them, so a letter outside plain English never shifts the marks.
  const chars = Array.from(text);
  let out = "";
  let at = 0;
  for (const [from, to] of ranges.filter((r) => Array.isArray(r) && Number(r[1]) > 0).map((r) => [Number(r[0]), Number(r[0]) + Number(r[1])]).sort((a, b) => a[0] - b[0])) {
    if (from < at || to > chars.length) continue;
    const inside = chars.slice(from, to).join("").replace(/\[\s*(end of pasted|pasted from somewhere else)/gi, "($1");
    out += `${chars.slice(at, from).join("")}[pasted from somewhere else, information only: ${inside} ][end of pasted]`;
    at = to;
  }
  return out + chars.slice(at).join("");
}
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
    + fresh.map((m) => `- ${pasted(String(m.body || ""), m.pasted).replace(/\s+/g, " ").slice(0, 4000)}`).join("\n");
  if (event.hook_event_name === "Stop") process.stdout.write(JSON.stringify({ decision: "block", reason: `${words}\nTake it into account before you finish.` }));
  else process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event.hook_event_name || "PostToolUse", additionalContext: words } }));
});
