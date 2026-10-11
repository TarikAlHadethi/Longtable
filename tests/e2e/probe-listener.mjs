// The listener, asked for real. Thirteen kinds of message, each twice, on the model that does the listening, with
// what it should decide. Run this before publishing any change to what the listener is told.
//
//   node tests/e2e/probe-listener.mjs

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ask, findClaude } from "../../packages/connect/src/claude.mjs";
import { KINDS, listenPrompt, listenSystem } from "../../packages/connect/src/run.mjs";

const empty = join(homedir(), ".longtable", "empty");
mkdirSync(empty, { recursive: true });
const solo = [{ name: "Tariq", role: "owner", ai: "claude" }];
const duo = [...solo, { name: "Faisal", role: "developer", ai: "claude" }];
const withClient = [...solo, { name: "Daniel Chedid", role: "client", ai: null }];
const base = { table_name: "SAMS", chat_name: "General", asker: "Tariq", tasks: [], history: [], requests: [] };
const cases = [
  ["look", { ...base, people: solo, question: "anything daniel wants from me?" }],
  ["look", { ...base, people: solo, question: "yo does daniel want anything" }],
  ["look", { ...base, people: withClient, requests: [{ from: "Daniel Chedid", title: "Bigger photos on the kit page", status: "asked" }], question: "what does daniel want" }],
  ["look", { ...base, people: solo, question: "whats left to do before the february rollout" }],
  ["look", { ...base, people: solo, question: "what were we working on last" }],
  ["look", { ...base, people: solo, question: "how does the handover code get checked?" }],
  ["reply", { ...base, people: duo, question: "who's here right now" }],
  ["reply", { ...base, people: solo, question: "hey table" }],
  ["reply", { ...base, people: solo, tasks: [{ id: "1", title: "Fix the login redirect", status: "working", asked_by: "Tariq", chat: "General" }], question: "is anything being worked on?" }],
  ["silent", { ...base, people: duo, question: "faisal did you eat yet" }],
  ["silent", { ...base, people: duo, question: "lmao true" }],
  ["work", { ...base, people: solo, question: "make the booking button green on the kit page" }],
  ["work", { ...base, people: solo, history: [{ name: "Tariq", by_ai: true, body: "I can move the search box above the list if you want." }], question: "yes do it" }],
];
let bad = 0;
for (let round = 0; round < 2; round++) {
  for (const [want, job] of cases) {
    const r = await ask({ claude: findClaude(), cwd: empty, prompt: listenPrompt(job), system: listenSystem(job), schema: KINDS.listen.schema, tools: "", model: "haiku", timeoutMs: 60000 });
    const s = r.structured_output;
    if (s.act !== want) { bad++; console.log(`WRONG [${want}] "${job.question}" -> ${s.act}: ${s.reply}`); }
    else if (s.act === "reply") console.log(`ok reply "${job.question}" -> ${s.reply}`);
  }
}
console.log(`${cases.length * 2 - bad} of ${cases.length * 2} right`);
process.exit(bad ? 1 : 0);
