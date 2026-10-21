// Programs a person's Claude leaves running: found below its command shells, never what it did not start (an orphan
// naming a parent number the system gave to something new, its own MCP servers, a browser it opened), stopped only
// when still the same program, kept while the chat's session lives and stopped when it ends, and stopped at the next
// start when a connection went away without stopping them. Real processes for the lifetime, made-up listings for the
// rules. No AI.
//
//   node tests/e2e/unit-procs.mjs

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "longtable-procs-"));
process.env.LONGTABLE_HOME = join(scratch, "home");
mkdirSync(process.env.LONGTABLE_HOME, { recursive: true });
process.env.LONGTABLE_SESSION_IDLE_MS = "50";
const P = await import("../../packages/connect/src/procs.mjs");
const { LEAVES_RUNNING } = await import("../../packages/connect/src/claude.mjs");

const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 400)}`; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const win = process.platform === "win32";

// The rules, on made-up listings (Windows-style: every start in milliseconds).
const p = (pid, ppid, at, name, pgid = null) => ({ pid, ppid, pgid, start: String(1792500000000 + at * 1000), ms: 1792500000000 + at * 1000, name });
const CLAUDE = 1000;
const listing = [
  p(CLAUDE, 1, 100, "claude.exe"),
  p(2000, CLAUDE, 200, "bash.exe"),            // its command shell
  p(2001, 2000, 300, "node.exe"),              // a server it started: taken
  p(3000, CLAUDE, 150, "node.exe"),            // its MCP server: not below a shell
  p(3001, 3000, 400, "chrome.exe"),            // what that server opened: left alone
  p(2002, 2000, 500, "chrome.exe"),            // a browser opened from its shell: never a program that runs code
  p(4000, 2000, 50, "python.exe"),             // names the shell's number but started before it: someone else's
  p(4001, 4000, 600, "node.exe"),              // ...and what that one started
];
const picked = P.pick(listing, CLAUDE, 1792500000000 + 100 * 1000, true).map((x) => x.pid).sort();
check("what it ran through its shell is found: the shell and the server", JSON.stringify(picked) === JSON.stringify([2000, 2001]), picked);
check("never its own MCP servers or what they open", !picked.includes(3000) && !picked.includes(3001));
check("never a browser, even one opened from its shell", !picked.includes(2002));
check("never a program that only names a parent number the system gave to something newer", !picked.includes(4000) && !picked.includes(4001));
// On Mac and Linux what it started keeps its process group after its parent has gone.
const unix = [p(CLAUDE, 1, 100, "claude", CLAUDE), p(5000, 1, 300, "node", CLAUDE), p(5001, 1, 300, "node", 5001)];
const pickedUnix = P.pick(unix, CLAUDE, 1792500000000 + 100 * 1000, false).map((x) => x.pid);
check("on Mac and Linux an orphan of its own group is still found, and only that one", JSON.stringify(pickedUnix) === JSON.stringify([5000]), pickedUnix);
check("a command that leaves something running is recognised", ["npm run dev &", "nohup node server.js", "npm run dev", "docker compose up -d", "next start", "node a.js & node b.js"].every((c) => LEAVES_RUNNING.test(c))
  && ["npm test", "git status", "node check.js", "a && b", "npm test 2>&1", "node x.js &> out.txt", "start chrome http://localhost:3000"].every((c) => !LEAVES_RUNNING.test(c)));
check("a listing that could not be taken stops nothing and says so", P.stopProcs([{ pid: 123, start: "1" }], null) === null);

// The lifetime, with real processes: a stand-in Claude runs a server through a shell, as Claude Code's Bash tool does.
const serverJs = join(scratch, "server.js");
writeFileSync(serverJs, "setTimeout(() => {}, 600000);");
const startClaude = () => spawn(process.execPath, ["-e",
  `const c = require('child_process').spawn(${JSON.stringify(win ? "cmd.exe" : "sh")}, ${JSON.stringify(win ? ["/c", "node", serverJs] : ["-c", `node "${serverJs}"`])}, { stdio: 'ignore' }); setTimeout(() => {}, 600000);`],
{ stdio: "ignore", windowsHide: true });
const serverOf = async (claude, since) => {
  for (let i = 0; i < 40; i++) {
    const found = await P.below(claude.pid, since);
    const node = found.filter((x) => x.pid !== claude.pid);
    if (node.length >= 2) return found;
    await sleep(250);
  }
  return [];
};
const kids = [];
try {
  const t0 = Date.now();
  const claude = startClaude();
  kids.push(claude);
  const found = await serverOf(claude, t0);
  check("on this computer, what the stand-in Claude ran through its shell is found", found.length >= 2, found);
  const pids = found.map((x) => x.pid);
  kids.push({ kill: () => { for (const q of pids) { try { process.kill(q); } catch {} } } });

  check("a program with the same number but another start is never stopped", P.stopProcs([{ pid: pids[0], start: "not-its-start" }]) === 0 && pids.every(alive));

  P.keepForSession("t:chat", found);
  await sleep(120);
  P.endIdleSessions(() => true);
  await sleep(300);
  check("a session with a request running is never ended for going quiet", pids.every(alive));
  P.endIdleSessions();
  await sleep(800);
  check("when the session has gone quiet, what it left running is stopped", pids.every((q) => !alive(q)), pids.map(alive));
  check("and the Claude itself is not, since it was not below its shell", alive(claude.pid));

  const t1 = Date.now();
  const claude2 = startClaude();
  kids.push(claude2);
  const found2 = await serverOf(claude2, t1);
  const pids2 = found2.map((x) => x.pid);
  kids.push({ kill: () => { for (const q of pids2) { try { process.kill(q); } catch {} } } });
  P.keepForSession("t:other", found2);
  // As a connection starting after one that went away without stopping them: it reads what was noted and stops it.
  P.stopLeftovers();
  await sleep(800);
  check("what an earlier connection's sessions left running is stopped at the next start", found2.length >= 2 && pids2.every((q) => !alive(q)), { found2, alive: pids2.map(alive) });
} catch (e) {
  check("the run did not crash", false, e.stack || String(e));
} finally {
  for (const k of kids) { try { k.kill(); } catch {} }
  await sleep(200);
  try { rmSync(scratch, { recursive: true, force: true }); } catch {}
}

const failed = Object.values(results).filter((v) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
