// Runs every suite in a folder of tests/, one after another, and says which failed. The folder is the list: a suite
// put in tests/unit runs before every push and in CI, one put in tests/db runs in CI's database job, so a new suite is
// never left out of a list kept by hand.
//
//   node tools/suites.mjs unit      no database, no AI (seconds)
//   node tools/suites.mjs db        the local stack, the app on :3000 and Chrome (about forty minutes)
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const folder = process.argv[2];
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "tests", folder || "");
if (!folder || !/^(unit|db)$/.test(folder)) {
  console.error("Which suites: node tools/suites.mjs unit | db");
  process.exit(2);
}
// Helpers that other suites import are not suites.
const suites = readdirSync(dir).filter((f) => f.endsWith(".mjs") && !f.startsWith("lib")).sort();
const failed = [];
for (const s of suites) {
  const started = Date.now();
  const run = spawnSync(process.execPath, ["--experimental-websocket", join(dir, s)], { cwd: root, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const ok = run.status === 0;
  const last = `${run.stdout || ""}${run.stderr || ""}`.trim().split("\n").pop() || "";
  console.log(`${ok ? "pass" : "FAIL"}  ${folder}/${s}  ${Math.round((Date.now() - started) / 1000)}s  ${last.slice(0, 120)}`);
  if (!ok) { failed.push(s); console.log(`${run.stdout || ""}${run.stderr || ""}`.split("\n").slice(-40).join("\n")); }
}
console.log(failed.length ? `\nFailed: ${failed.join(", ")}` : `\nAll ${suites.length} passed.`);
process.exit(failed.length ? 1 : 0);
