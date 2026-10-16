// The connection starting at login and starting again after an update, for real, on the computer this runs on. It
// installs the start-up entry exactly as `connect` does (launchd on a Mac, systemd on Linux), sees it start, has it
// stop the way a self-update does, sees the system start it again, then takes it all away.
//
// It replaces this computer's own Longtable start-up entry and ~/.longtable/app, so it runs only on a throwaway
// machine: GitHub's check machines (CI=true). Windows is checked on Tarik's PC instead (Task Scheduler there needs a
// signed-in desktop, which a check machine does not have).
//
//   CI=true node tests/e2e/os-autostart.mjs

import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.CI !== "true") { console.log("Not a check machine: this would replace this computer's own start-up entry. Skipped."); process.exit(0); }
if (process.platform === "win32") { console.log("Windows is checked on a real desktop, not here."); process.exit(0); }

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 600)}`; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const { home } = await import("../../packages/connect/src/store.mjs");
const { enableAutostart, disableAutostart } = await import("../../packages/connect/src/autostart.mjs");

// A stand-in connection: the real code, with a bin that notes each start, and stops the way an update does when told.
const pkg = mkdtempSync(join(tmpdir(), "longtable-os-"));
cpSync(join(repoRoot, "packages", "connect", "src"), join(pkg, "src"), { recursive: true });
cpSync(join(repoRoot, "packages", "connect", "package.json"), join(pkg, "package.json"));
mkdirSync(join(pkg, "bin"));
writeFileSync(join(pkg, "bin", "longtable.mjs"), `import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { home } from "../src/store.mjs";
import { restartOnNew } from "../src/update.mjs";
appendFileSync(join(home, "starts.log"), process.pid + " " + (process.env.XPC_SERVICE_NAME || process.env.INVOCATION_ID ? "supervised" : "alone") + "\\n");
writeFileSync(join(home, "runner.pid"), process.pid + " " + Date.now());
setInterval(() => { if (existsSync(join(home, "restart-now"))) { rmSync(join(home, "restart-now")); restartOnNew(process.argv[1]); } }, 300);
`);
const starts = () => { try { return readFileSync(join(home, "starts.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => ({ pid: Number(l.split(" ")[0]), how: l.split(" ")[1] })); } catch { return []; } };
const waitFor = async (fn, ms) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) if (fn()) return true; return false; };

mkdirSync(home, { recursive: true });
rmSync(join(home, "starts.log"), { force: true });
try {
  const how = enableAutostart(process.execPath, join(pkg, "bin", "longtable.mjs"));
  results.where = how.where;
  check("the start-up entry starts the connection", await waitFor(() => starts().length >= 1, 30000), { how, starts: starts() });
  check("it runs from the copy the connection keeps up to date", existsSync(join(home, "app", "bin", "longtable.mjs")));
  check("the system knows it is looking after it", starts()[0]?.how === "supervised", starts());
  const first = starts()[0]?.pid;
  writeFileSync(join(home, "restart-now"), "");
  check("stopped the way an update stops it, the system starts it again", await waitFor(() => starts().length >= 2 && alive(starts()[1].pid), 60000), starts());
  check("the old one is gone", !alive(first));
  disableAutostart();
  const last = starts().at(-1)?.pid;
  await sleep(3000);
  check("taken away, it stops and does not come back", !alive(last) && starts().length === 2, starts());
} catch (e) {
  results.error = String(e?.stack || e).slice(0, 900);
} finally {
  try { disableAutostart(); } catch {}
  for (const s of starts()) if (alive(s.pid)) try { process.kill(s.pid); } catch {}
  rmSync(pkg, { recursive: true, force: true });
}
const failed = Object.entries(results).filter(([k, v]) => k !== "where" && v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
console.log(`${Object.keys(results).length - 1 - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
