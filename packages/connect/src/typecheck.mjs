// The project's own type check, run on a client's copy before a change is pushed, so a change that would break the
// copy's build never reaches it (a failed build costs the client minutes and a "that did not work"). Only TypeScript's
// own `tsc --noEmit`, from the person's own installed packages: never an npm script, never anything the project runs.
//
// The copy's working folder holds only what git tracks. A check there must see what the person's own folder has beside
// it (installed packages, generated code such as a Prisma client): each folder git ignores in their folder is linked
// in for the check and taken out again after, never a secret file, and nothing in their folder is ever changed.

import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const win = process.platform === "win32";
// Never linked or copied into a working folder, whatever git ignores.
const SECRET = /(^|\/)(\.env[^/]*|.*\.(pem|key|p12|pfx)|id_[a-z0-9]+|\.npmrc|\.netrc|credentials[^/]*)(\/|$)/i;

export function tscOf(folder) {
  const tsc = folder ? join(folder, "node_modules", "typescript", "bin", "tsc") : null;
  return tsc && existsSync(tsc) ? tsc : null;
}

// Whether this project can be checked here: it has a tsconfig, and their own folder has TypeScript installed.
export const canCheck = (dir, folder) => existsSync(join(dir, "tsconfig.json")) && !!tscOf(folder);

// What their folder has that git ignores, laid into the working folder for the check: folders linked, type
// declaration files copied. Returns what was put there, so it can be taken out again.
export function mirrorIgnored(dir, folder) {
  let list = [];
  try {
    list = execFileSync("git", ["-C", folder, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 60000, maxBuffer: 16 * 1024 * 1024 }).toString().split("\0").filter(Boolean);
  } catch { return []; }
  const made = [];
  for (const raw of list) {
    const isDir = raw.endsWith("/");
    const p = raw.replace(/\/$/, "");
    if (!p || p.startsWith("..") || SECRET.test(p) || p.split("/").includes(".git")) continue;
    const at = join(dir, ...p.split("/"));
    if (existsSync(at) || !existsSync(dirname(at))) continue;
    try {
      if (isDir) { symlinkSync(join(folder, ...p.split("/")), at, win ? "junction" : "dir"); made.push({ at, link: true }); }
      else if (/\.d\.ts$/.test(p)) { copyFileSync(join(folder, ...p.split("/")), at); made.push({ at, link: false }); }
    } catch {}
  }
  return made;
}

// Takes out what mirrorIgnored put in. A link is removed as a link: what it points at is never touched.
export function unmirror(made) {
  for (const m of [...made].reverse()) {
    try {
      const st = lstatSync(m.at);
      if (m.link && st.isSymbolicLink()) { if (win) rmdirSync(m.at); else unlinkSync(m.at); }
      else if (!m.link && st.isFile()) rmSync(m.at, { force: true });
    } catch {}
  }
}

// One error, the same however its line moved: the file, the code and the words.
const ERR = /^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/;
export function parseErrors(out) {
  const errors = [];
  for (const line of String(out).split(/\r?\n/)) {
    const m = ERR.exec(line.trim());
    if (m) errors.push(`${m[1].replace(/\\/g, "/")}: ${m[2]}: ${m[3]}`);
  }
  return [...new Set(errors)];
}
export const newErrors = (after, before) => after.filter((e) => !before.includes(e));

// The check itself, in a working folder. ok, or the errors it found; null when it could not be run here.
export function typeCheck(dir, folder, timeoutMs = 4 * 60 * 1000) {
  const tsc = tscOf(folder);
  if (!tsc || !existsSync(join(dir, "tsconfig.json"))) return Promise.resolve(null);
  const made = mirrorIgnored(dir, folder);
  // A project that keeps incremental build notes writes one beside its tsconfig: it is not part of the change.
  const notes = new Set(readdirSync(dir).filter((f) => f.endsWith(".tsbuildinfo")));
  return new Promise((resolve) => {
    execFile(process.execPath, [tsc, "--noEmit", "-p", join(dir, "tsconfig.json")],
      { cwd: dir, windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { PATH: process.env.PATH || "", SystemRoot: process.env.SystemRoot || "", NODE_OPTIONS: "--max-old-space-size=4096" } },
      (e, stdout) => {
        unmirror(made);
        try { for (const f of readdirSync(dir)) if (f.endsWith(".tsbuildinfo") && !notes.has(f)) rmSync(join(dir, f), { force: true }); } catch {}
        if (!e) return resolve({ ok: true, errors: [] });
        const errors = parseErrors(stdout);
        // It stopped for another reason (ran out of time, could not start): not a verdict on the change.
        resolve(errors.length && !e.killed ? { ok: false, errors } : null);
      });
  });
}

// What the check found on a commit, remembered on this computer, so the version a change starts from is checked once.
export function remembered(home, tableId, sha) {
  try { return JSON.parse(readFileSync(join(home, "checks", `${tableId}.json`), "utf8"))[sha] || null; } catch { return null; }
}
export function remember(home, tableId, sha, errors) {
  if (!sha) return;
  const file = join(home, "checks", `${tableId}.json`);
  let all = {};
  try { all = JSON.parse(readFileSync(file, "utf8")); } catch {}
  all[sha] = errors;
  // The newest forty are plenty: a copy only ever starts from its own latest.
  const keep = Object.fromEntries(Object.entries(all).slice(-40));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(keep));
}
