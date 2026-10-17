// The listener, asked for real. Sixteen kinds of message, each twice, on the model that does the listening, with
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
const solo = [{ name: "Maya", role: "owner", ai: "claude" }];
const duo = [...solo, { name: "Sam", role: "developer", ai: "claude" }];
const withClient = [...solo, { name: "Elena Ruiz", role: "client", ai: null }];
const base = { table_name: "Fernhill booking", chat_name: "General", asker: "Maya", tasks: [], history: [], requests: [] };
const cases = [
  ["look", { ...base, people: solo, question: "anything elena wants from me?" }],
  ["look", { ...base, people: solo, question: "yo does elena want anything" }],
  ["look", { ...base, people: withClient, requests: [{ from: "Elena Ruiz", title: "Bigger photos on the booking page", status: "asked" }], question: "what does elena want" }],
  ["look", { ...base, people: solo, question: "whats left to do before the march launch" }],
  ["look", { ...base, people: solo, question: "what were we working on last" }],
  ["look", { ...base, people: solo, question: "how does the reminder text get sent?" }],
  ["reply", { ...base, people: duo, question: "who's here right now" }],
  ["reply", { ...base, people: solo, question: "hey table" }],
  ["reply", { ...base, people: solo, tasks: [{ id: "1", title: "Fix the login redirect", status: "working", asked_by: "Maya", chat: "General" }], question: "is anything being worked on?" }],
  ["silent", { ...base, people: duo, question: "sam did you eat yet" }],
  ["silent", { ...base, people: duo, question: "lmao true" }],
  ["silent", { ...base, asker: "Sam", people: duo, question: "Maya can you send me the figma link later? I need it for the meeting tomorrow" }],
  ["silent", { ...base, people: duo, question: "sam can you review my PR when you get a sec" }],
  ["look", { ...base, people: duo, question: "what did sam change in the booking flow last week" }],
  ["work", { ...base, people: solo, question: "make the book button green on the booking page" }],
  ["work", { ...base, people: solo, history: [{ name: "Maya", by_ai: true, body: "I can move the search box above the list if you want." }], question: "yes do it" }],
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
