// The client rulebook's hard rules, checked in code on every client answer (client-rules.mjs), and the guard that
// keeps every client rule in that one file. No model, no database.
import { readFileSync } from "node:fs";
import { PASS_REASONS, checkClientReply, clientFields, passReasons } from "../../packages/connect/src/client-rules.mjs";
import { clientLookPrompt, clientPrompt, systemFor } from "../../packages/connect/src/run.mjs";

let failed = 0;
const check = (name, ok, got) => { console.log(`${ok ? "pass" : "FAIL"}  ${name}`); if (!ok) { failed++; if (got !== undefined) console.log("      got:", JSON.stringify(got).slice(0, 400)); } };

const copyJob = { kind: "client", for_team: true, has_copy: true, can_look: true, table_name: "Kit Room", me: "Daniel", question: "x", requests: [], told: [], history: [] };
const plainJob = { ...copyJob, has_copy: false };
const ownJob = { kind: "client", for_team: false, table_name: "Kit Room", me: "Daniel", question: "x", requests: [], told: [], history: [] };
const ok = (over) => ({ reply: "Sure.", pass_on: false, title: "", reason: "none", look: false, ask: "", copy: false, change: "", ...over });
const none = (job, s, o) => checkClientReply(job, s, o).length === 0;
const breaks = (job, s, re, o) => checkClientReply(job, s, o).some((p) => re.test(p));

// What may go to the team
check("with a copy, a change is never a reason to pass on", !passReasons(copyJob).includes("change"));
check("with a copy, what a copy cannot try may be passed on", ["payments", "messages", "accounts", "outside", "app", "date", "price", "contract", "meeting"].every((r) => passReasons(copyJob).includes(r)));
check("without a copy, a change goes to the team", passReasons(plainJob).includes("change"));
check("able to look, 'could not answer' is never a reason", !passReasons(copyJob).includes("unknown") && passReasons(ownJob).includes("unknown"));
check("every reason has words", Object.keys(PASS_REASONS).every((r) => PASS_REASONS[r].length > 5));
check("the schema allows only this job's reasons", JSON.stringify(clientFields(copyJob).properties.reason.enum) === JSON.stringify([...passReasons(copyJob), "none"]));
check("the schema has every field required and nothing extra (Codex's strict schemas)", ((f) => f.additionalProperties === false && Object.keys(f.properties).every((k) => f.required.includes(k)))(clientFields(copyJob)));
check("the look's schema has no look or copy fields", ((f) => !f.properties.look && !f.properties.copy)(clientFields(copyJob, { look: true })));

// The checks
check("a plain answer passes", none(copyJob, ok()));
check("a change passed on for 'change' with a copy is refused", breaks(copyJob, ok({ pass_on: true, reason: "change", title: "New look" }), /not a reason to pass on/));
check("and the refusal says where a change goes instead", breaks(copyJob, ok({ pass_on: true, reason: "change", title: "New look" }), /goes to their copy/));
check("a pass with no reason is refused", breaks(copyJob, ok({ pass_on: true, reason: undefined, title: "x" }), /not a reason/));
check("payments passed on with a copy is fine", none(copyJob, ok({ pass_on: true, reason: "payments", title: "Late fees online" })));
check("a change passed on without a copy is fine", none(plainJob, ok({ pass_on: true, reason: "change", title: "Dark mode" })));
check("a pass needs a title", breaks(copyJob, ok({ pass_on: true, reason: "date", title: "" }), /no title/));
check("two routes at once are refused", breaks(copyJob, ok({ copy: true, change: "x", pass_on: true, reason: "date", title: "t" }), /more than one/));
check("a copy with nothing to build is refused", breaks(copyJob, ok({ copy: true, change: " " }), /nothing in change/));
check("a copy without a copy is refused", breaks(plainJob, ok({ copy: true, change: "x" }), /no copy/));
check("a look with no question is refused", breaks(copyJob, ok({ look: true, ask: "", reply: "" }), /no question/));
check("a look with a question and no reply is fine", none(copyJob, ok({ look: true, ask: "Is there a staff dashboard?", reply: "" })));
check("a look where it cannot look is refused", breaks(ownJob, { reply: "x", pass_on: false, title: "", reason: "none", look: true }, /cannot look/));
check("an empty reply is refused", breaks(copyJob, ok({ reply: "  " }), /empty/));
check("saying it was passed on while not passing it is refused", breaks(copyJob, ok({ reply: "I've passed this on to the team." }), /says it was passed/));
check("'I've let the team know' while not passing is refused", breaks(copyJob, ok({ reply: "I've let the team know, they will follow up." }), /says it was passed/));
check("saying an earlier request was passed on is true and allowed", none(copyJob, ok({ reply: "Your bigger photos request was passed on to the team, and it is built now." })));
check("offering to pass a real request on later is fine", none(copyJob, ok({ reply: "I cannot help with that here. Tell me a real request and I'll pass it along." })));
check("an offer of the copy is fine", none(copyJob, ok({ reply: "Yes, that could work for staff only. Want me to try it in your copy?" })));
check("a message that already reached the team may say so", none({ ...copyJob, already_passed: true }, ok({ reply: "The team has it already." })));
check("a long block is refused", breaks(copyJob, ok({ reply: "word ".repeat(130) }), /words/));
check("a heading is refused", breaks(copyJob, ok({ reply: "# Status\nGood." }), /heading/));
check("no reply at all is refused", breaks(copyJob, null, /no reply/));
check("the look: a change with a copy is not passed on", breaks(copyJob, { reply: "x", pass_on: true, reason: "change", title: "t" }, /not a reason/, { look: true }));
check("the look: 'could not find it' is not passed on", breaks(ownJob, { reply: "x", pass_on: true, reason: "unknown", title: "t" }, /not a reason/, { look: true }));

// The prompts say what the code checks
const deskCopy = clientPrompt(copyJob), deskPlain = clientPrompt(plainJob), own = clientPrompt(ownJob);
const look = clientLookPrompt({ ...copyJob, stage: 1, brief: "q" });
check("the desk with a copy lists only its reasons", passReasons(copyJob).every((r) => deskCopy.includes(PASS_REASONS[r])) && !deskCopy.includes(PASS_REASONS.change));
check("the desk without a copy may pass changes on", deskPlain.includes(PASS_REASONS.change));
check("a client's own assistant is told its reasons", passReasons(ownJob).every((r) => own.includes(PASS_REASONS[r])));
check("the look with a copy offers it and never passes a change on", /offering to try it in their copy/.test(look) && !look.includes(PASS_REASONS.change));
check("no prompt tells anyone to pass on any change", ![deskCopy, deskPlain, own, look, systemFor(copyJob)].some((p) => /anything new or a change|new feature.{0,40}team has the question/i.test(p)));
check("with a copy, nothing says a feature will not be tried", !/Never say a new feature/.test(systemFor(copyJob)) && /try in their copy/.test(systemFor(copyJob)));

// One rulebook: no other source file words a client's routing
const run = readFileSync(new URL("../../packages/connect/src/run.mjs", import.meta.url), "utf8");
const clientPart = run.slice(run.indexOf("export function systemFor"), run.indexOf("if (job.packed)", run.indexOf("export function systemFor")))
  + run.slice(run.indexOf("export function clientLookPrompt"), run.indexOf("export const CLIENT_LOOK_SYSTEM"));
check("run.mjs words no client routing of its own", !/pass_on|pass it on|passed it on|team has/i.test(clientPart), clientPart.match(/.{40}(pass_on|pass it on|team has).{40}/i)?.[0]);

console.log(`\n${failed ? `${failed} failed` : "all passed"}`);
process.exit(failed ? 1 : 0);
