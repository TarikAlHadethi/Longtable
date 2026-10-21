// Programs a person's Claude starts and leaves running (a dev server, a test run in the background) live as long as
// the chat's session that started them, as they do in a Claude Code session at home, and are stopped when that session
// ends. Only ever what its own Claude started through its command shell, and only programs that serve or run code
// (node, python and the like): never a browser, an editor or anything else on the person's computer. Each one is known
// by its process number AND the moment it started, so a number since given to another program is never touched, and
// each is stopped on its own, never with whatever happens to sit below it by then.

import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { home, log, writeWhole } from "./store.mjs";

const win = process.platform === "win32";
// The command shells Claude Code's Bash tool runs commands in. What sits below one of these is what Claude ran.
const SHELLS = /^(bash|sh|zsh|dash|cmd|powershell|pwsh)(\.exe)?$/i;
// What may be stopped: programs that run or serve code, and the shells that hold them. Nothing else, ever.
const RUNS_CODE = /^(node|nodejs|deno|bun|python[0-9.]*|py|pythonw|ruby|php|java|dotnet|go|cargo|uvicorn|gunicorn|flask|rails|npm|npx|pnpm|yarn|vite|esbuild|tsx|ts-node|nodemon|bash|sh|zsh|dash|cmd|powershell|pwsh)(\.exe|\.cmd)?$/i;

const WIN_LIST = "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToFileTimeUtc()) $($_.Name)\" }";
// On Mac and Linux each line is: pid ppid pgid, the start (five words, in UTC so a clock change never alters it), name.
const PS_ARGS = ["-A", "-o", "pid=,ppid=,pgid=,lstart=,comm="];
const PS_ENV = { ...process.env, TZ: "UTC", LC_ALL: "C" };

export function parse(out, onWindows = win) {
  const list = [];
  for (const raw of String(out).split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (onWindows) {
      const m = l.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      if (m) list.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: null, start: m[3], ms: Number(m[3]) / 10000 - 11644473600000, name: m[4].trim() });
    } else {
      const m = l.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/);
      if (m) list.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), start: m[4], ms: Date.parse(`${m[4]} UTC`), name: m[5].trim().split("/").pop() });
    }
  }
  return list;
}
function listAll() {
  return new Promise((resolve) => {
    const done = (e, out) => resolve(e ? null : parse(out));
    if (win) execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_LIST], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 20000 }, done);
    else execFile("ps", PS_ARGS, { env: PS_ENV, maxBuffer: 16 * 1024 * 1024, timeout: 20000 }, done);
  });
}
function listAllNow() {
  const r = win
    ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_LIST], { windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 20000 })
    : spawnSync("ps", PS_ARGS, { env: PS_ENV, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 20000 });
  return r.status === 0 && r.stdout ? parse(r.stdout) : null;
}

// What a Claude (process `root`, started at `rootMs`) ran through its shells and left running, found in a listing.
// A process counts as another's child only if it started after it: on Windows a program whose parent has gone keeps
// naming that parent's old number, which the system may since have given to a new process. Its own MCP servers and
// anything they start are not below a shell, so they are left alone. On Mac and Linux, what it started keeps its
// process group (the connection makes each Claude the leader of its own), so it is found even after its parent has
// gone and it was handed to the system.
export function pick(all, root, rootMs, onWindows = win) {
  if (!all) return [];
  const byPid = new Map(all.map((p) => [p.pid, p]));
  const kids = new Map();
  for (const p of all) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
  const out = new Map();
  const take = (p) => { if (RUNS_CODE.test(p.name) && p.pid !== process.pid) out.set(`${p.pid}|${p.start}`, { pid: p.pid, start: p.start }); };
  const walk = (p, depth) => {
    if (depth > 30) return;
    for (const k of kids.get(p.pid) || []) {
      if (k.pid === p.pid || !(k.ms >= p.ms - 1000)) continue;
      take(k);
      walk(k, depth + 1);
    }
  };
  const self = byPid.get(root) || { pid: root, ms: rootMs };
  for (const shell of (kids.get(root) || []).filter((k) => SHELLS.test(k.name) && k.ms >= self.ms - 1000)) { take(shell); walk(shell, 1); }
  if (!onWindows) for (const p of all) if (p.pgid === root && p.pid !== root && p.ms >= rootMs - 1000) take(p);
  return [...out.values()];
}

export async function below(root, rootMs) {
  return pick(await listAll(), root, rootMs);
}

// Stop each that is still the same program (same number, same start), on its own. Returns how many were stopped, or
// null when the system could not be asked, so nothing is forgotten that was not really stopped.
export function stopProcs(list, all = undefined) {
  if (!list?.length) return 0;
  if (all === undefined) all = listAllNow();
  if (!all) return null;
  const still = new Set(all.map((p) => `${p.pid}|${p.start}`));
  let stopped = 0;
  for (const p of list) {
    if (!still.has(`${p.pid}|${p.start}`) || p.pid === process.pid) continue;
    try {
      if (win) spawnSync("taskkill", ["/PID", String(p.pid), "/F"], { windowsHide: true, stdio: "ignore" });
      else process.kill(p.pid, "SIGTERM");
      stopped++;
    } catch {}
  }
  return stopped;
}

// What each chat's session has running, kept on disk too: a connection that restarts (an update, a crash) stops what
// the one before it left, rather than leaving it running with nobody to stop it.
const FILE = () => join(home, "sessions", "running.json");
const running = new Map();
const save = () => {
  try { mkdirSync(dirname(FILE()), { recursive: true }); writeWhole(FILE(), JSON.stringify(Object.fromEntries(running))); }
  catch (e) { log(`could not note what is running: ${e.message}`); }
};

export function keepForSession(key, list) {
  if (!list?.length) return;
  const was = running.get(key) || { procs: [], at: 0 };
  const seen = new Set(was.procs.map((p) => `${p.pid}|${p.start}`));
  running.set(key, { procs: [...was.procs, ...list.filter((p) => !seen.has(`${p.pid}|${p.start}`))].slice(-500), at: Date.now() });
  save();
}
export function touchSession(key) {
  const was = running.get(key);
  if (was) { was.at = Date.now(); save(); }
}
function endKeys(keys, why) {
  const procs = keys.flatMap((k) => running.get(k)?.procs || []);
  if (!procs.length) { for (const k of keys) running.delete(k); if (keys.length) save(); return; }
  const n = stopProcs(procs);
  // The system could not be asked: kept, to be stopped next time, never forgotten while still running.
  if (n === null) { log(`could not list programs to stop (${why}); will try again`); return; }
  for (const k of keys) running.delete(k);
  save();
  if (n) log(`stopped ${n} program(s) a session had left running (${why})`);
}
export function endSession(key, why) { if (running.has(key)) endKeys([key], why); }
// A session nobody has used for this long has ended, as a Claude Code session closed at home would have.
export const SESSION_IDLE_MS = Number(process.env.LONGTABLE_SESSION_IDLE_MS || 2 * 3600 * 1000);
export function endIdleSessions(inUse = () => false) {
  // A session with a request running right now is not quiet, however long ago it started its programs.
  const quiet = [...running].filter(([key, v]) => Date.now() - v.at > SESSION_IDLE_MS && !inUse(key)).map(([key]) => key);
  if (quiet.length) endKeys(quiet, "the session went quiet");
}
export function endAllSessions(why) { if (running.size) endKeys([...running.keys()], why); }
// At start: whatever a connection before this one left running is stopped.
export function stopLeftovers() {
  let left = {};
  try { left = JSON.parse(readFileSync(FILE(), "utf8")); } catch { return; }
  const procs = Object.values(left || {}).flatMap((v) => v?.procs || []);
  if (!procs.length) return;
  const n = stopProcs(procs);
  if (n === null) { log("could not list programs an earlier connection left running; they stay noted"); return; }
  try { writeWhole(FILE(), "{}"); } catch {}
  if (n) log(`stopped ${n} program(s) an earlier connection's sessions had left running`);
}
