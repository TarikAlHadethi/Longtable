// What a person says while their own Claude works reaches it at its next step: the hook Claude Code runs hands over
// each new message once, after a step as added context, and as it is about to stop as a reason to carry on. No AI.
//
//   node tests/e2e/unit-inbox.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hook = resolve(fileURLToPath(new URL("../../packages/connect/src/inbox-hook.mjs", import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), "longtable-inbox-"));
const inbox = join(scratch, "job.json");
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 400)}`; };
const run = (event) => {
  const r = spawnSync(process.execPath, [hook, inbox], { input: JSON.stringify({ hook_event_name: event }), encoding: "utf8" });
  return r.stdout ? JSON.parse(r.stdout) : null;
};
try {
  writeFileSync(inbox, JSON.stringify({ who: "Maya", messages: [] }));
  check("with nothing new it says nothing", run("PostToolUse") === null);
  writeFileSync(inbox, JSON.stringify({ who: "Maya", messages: [{ id: "m1", body: "also make the button blue" }] }));
  const after = run("PostToolUse");
  check("a new message reaches it after its next step, as her own words", after?.hookSpecificOutput?.hookEventName === "PostToolUse"
    && /Maya said in the chat while you work/.test(after.hookSpecificOutput.additionalContext) && /make the button blue/.test(after.hookSpecificOutput.additionalContext), after);
  check("each message is handed over once", run("PostToolUse") === null);
  writeFileSync(inbox, JSON.stringify({ who: "Maya", messages: [{ id: "m1", body: "also make the button blue" }, { id: "m2", body: "and keep the old one too" }] }));
  const stop = run("Stop");
  check("one that comes as it is about to stop keeps it going, with only what is new", stop?.decision === "block" && /keep the old one/.test(stop.reason) && !/button blue/.test(stop.reason), stop);
  check("and then it may stop", run("Stop") === null);
  writeFileSync(inbox, "not json");
  check("a damaged file never breaks the run", run("PostToolUse") === null);
} catch (e) {
  check("the run did not crash", false, e.stack || String(e));
} finally {
  try { rmSync(scratch, { recursive: true, force: true }); } catch {}
}
const failed = Object.values(results).filter((v) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
