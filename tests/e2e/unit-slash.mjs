// Everything behind "/", with no database and no AI: every command Claude Code has means something at a table, the
// ones the table runs have words, and Claude Code's own list reaches the table by name only.
//
//   node tests/e2e/unit-slash.mjs

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "longtable-slash-"));
process.env.LONGTABLE_HOME = join(scratch, "home");
process.env.LONGTABLE_CLAUDE_HOME = join(scratch, "claude");
mkdirSync(process.env.LONGTABLE_CLAUDE_HOME, { recursive: true });
const { loadCommand, scanCommands } = await import("../../packages/connect/src/extras.mjs");
const { withClaudeCommands, toldCommands } = await import("../../packages/connect/src/run.mjs");
const { EFFORTS } = await import("../../packages/connect/src/claude.mjs");
const { SLASH, slashEntry, EFFORT_LEVELS, fastWhy } = await import("../../apps/web/lib/slash.mjs");

const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 400)}`; };

// What Claude Code 2.1.296 reported of itself on a Windows computer, 16 Oct 2026 (the init event's slash_commands).
const CLAUDE_CODE = ["deep-research", "design", "design-sync", "dataviz", "update-config", "verify", "debug", "code-review", "simplify", "batch",
  "fewer-permission-prompts", "doctor", "loop", "schedule", "claude-api", "workflow-authoring", "run", "run-skill-generator", "plugin-authoring",
  "advisor", "agents", "auto-mode-setup", "autocompact", "clear", "color", "compact", "config", "output-style", "context", "effort", "fast", "focus",
  "heapdump", "init", "mcp", "import", "model", "workflow-launch-exec", "reload-plugins", "reload-skills", "rename", "ultrareview",
  "security-review", "usage-credits", "extra-usage", "usage", "insights", "recap", "skill-doctor", "goal", "design-consent", "design-revoke",
  "list-agents", "team-onboarding"];

const seat = { kind: "claude", folder: scratch };
const builtIn = scanCommands(seat).filter((c) => c.kind === "builtin").map((c) => c.name);
const known = (n) => builtIn.includes(n) || !!SLASH[n];
check("every command Claude Code has means something at the table", CLAUDE_CODE.every(known), CLAUDE_CODE.filter((n) => !known(n)));
check("none is both run by the table and carried out by its screens", builtIn.every((n) => !SLASH[n]), builtIn.filter((n) => SLASH[n]));
check("the ones the table runs have their words", builtIn.every((n) => loadCommand(seat, `/${n} the login page`)?.body?.includes("the login page")), builtIn);
check("the new ones make what they say: design, charts and onboarding as handouts", ["design", "dataviz", "team-onboarding"].every((n) => /handout/.test(loadCommand(seat, `/${n}`).body)));
check("a name Claude Code has that the table does not run is never run", loadCommand(seat, "/compact everything") === null && loadCommand(seat, "/model opus") === null);
check("a command nobody here knows says so instead of nothing", slashEntry("brand-new-thing", false).act === "say");
check("a command the connection holds words for runs", slashEntry("compact", true).act === "run");
check("the screens' effort levels are Claude Code's", EFFORT_LEVELS.every((l) => EFFORTS.has(l)) && EFFORTS.size === EFFORT_LEVELS.length);
check("why fast mode is off is said in plain words", /usage credits|organization/.test(fastWhy("preference")) && fastWhy(null) === "");

// Claude Code's own list, by name only, after the person's own.
const mine = [{ name: "deploy", about: "Ship it", kind: "command" }, { name: "review", about: "Read code for bugs", kind: "builtin" }];
const merged = withClaudeCommands(mine, ["review", "compact", "__remote-workflow", "model"]);
check("Claude Code's names come after, by name only, with no doubles and no hidden ones", JSON.stringify(merged.map((c) => c.name)) === JSON.stringify(["deploy", "review", "compact", "model"])
  && merged.slice(2).every((c) => c.kind === "builtin" && c.about === ""), merged);
check("what leaves the computer is a name, a line and a kind", toldCommands(merged).every((c) => Object.keys(c).sort().join() === "about,kind,name"));

rmSync(scratch, { recursive: true, force: true });
const failed = Object.entries(results).filter(([, v]) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
