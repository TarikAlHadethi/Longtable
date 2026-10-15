// Where the connection keeps its settings and secrets, on this computer only.
// Secrets are encrypted for this Windows user with DPAPI; elsewhere they are files only this user can read.

import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const isWindows = process.platform === "win32";
// ~/.longtable on every system, never AppData. On Windows an app installed as a package (Claude Desktop is one)
// has the new folders it makes under AppData quietly kept in its own private folder, so a connection set up from
// inside it was invisible to everything else on the computer, start-up included. Folders in the user profile itself
// are not redirected (both checked 9 Oct 2026).
export const defaultHome = join(homedir(), ".longtable");
const legacyHome = isWindows ? join(process.env.LOCALAPPDATA || homedir(), "Longtable") : null;
// LONGTABLE_HOME keeps a separate set of settings, for tests.
export const home = process.env.LONGTABLE_HOME || defaultHome;

// A connection set up before the move keeps working: its settings, sign-ins and log come across once.
if (!process.env.LONGTABLE_HOME && legacyHome && existsSync(legacyHome) && !existsSync(join(defaultHome, "config.json"))
    && !existsSync(join(defaultHome, "secrets"))) {
  try {
    cpSync(legacyHome, defaultHome, { recursive: true, errorOnExist: false, force: false });
  } catch {}
}
const secretsDir = join(home, "secrets");
const configFile = join(home, "config.json");
const logFile = join(home, "runner.log");

mkdirSync(secretsDir, { recursive: true });

export function hideSecrets(text) {
  return String(text)
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[token]")
    .replace(/\b[0-9a-f]{64}\b/gi, "[device token]");
}

// The log keeps to a size. Offline, a connection writes a line every few seconds, so it once grew without end; past
// 5 MB it starts again and keeps only the file before it (runner.log.1).
const LOG_MAX = 5 * 1024 * 1024;
let logWrites = 0;
// Text cut to n, never through the middle of a character that takes two (most emoji).
export const cut = (s, n) => {
  const t = String(s ?? "");
  if (t.length <= n) return t;
  const x = t.slice(0, n);
  return /[\uD800-\uDBFF]$/.test(x) ? x.slice(0, -1) : x;
};
// A file written whole or not at all: to a file beside it, then put in its place. A stop halfway through a write
// used to leave settings or notes cut short, and the next start could not read them.
export function writeWhole(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export function log(line) {
  if (logWrites++ % 200 === 0) {
    try { if (statSync(logFile).size > LOG_MAX) renameSync(logFile, `${logFile}.1`); } catch {}
  }
  appendFileSync(logFile, `${new Date().toISOString()} ${hideSecrets(line)}\n`);
}

export function readConfig() {
  if (!existsSync(configFile)) return { connections: [] };
  return JSON.parse(readFileSync(configFile, "utf8"));
}

export function writeConfig(config) {
  writeWhole(configFile, JSON.stringify(config, null, 2));
}

function powershell(script, input, file) {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input,
    env: { ...process.env, LT_SECRET_FILE: file },
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error("Could not use Windows' secret store: " + r.stderr.toString().slice(0, 200));
  return r.stdout.toString();
}

const secretPath = (name) => join(secretsDir, isWindows ? `${name}.bin` : name);

export function saveSecret(name, value) {
  const file = secretPath(name);
  if (isWindows) {
    powershell(
      "Add-Type -AssemblyName System.Security; $t = [Console]::In.ReadToEnd(); " +
        "$p = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($t), $null, 'CurrentUser'); " +
        "[IO.File]::WriteAllBytes($env:LT_SECRET_FILE, $p)",
      value,
      file,
    );
  } else {
    writeFileSync(file, value, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
}

export function loadSecret(name) {
  const file = secretPath(name);
  if (!existsSync(file)) return null;
  if (isWindows) {
    return powershell(
      "Add-Type -AssemblyName System.Security; $p = [IO.File]::ReadAllBytes($env:LT_SECRET_FILE); " +
        "$b = [Security.Cryptography.ProtectedData]::Unprotect($p, $null, 'CurrentUser'); " +
        "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))",
      undefined,
      file,
    ).trim();
  }
  return readFileSync(file, "utf8").trim();
}

export function forgetSecret(name) {
  rmSync(secretPath(name), { force: true });
}

// The feasibility probe saved the Claude sign-in one folder up; adopt it instead of asking for a new approval.
const oldClaudeToken = join(defaultHome, isWindows ? "claude-token.bin" : "claude-token");
const defaultClaudeToken = join(defaultHome, "secrets", isWindows ? "claude-token.bin" : "claude-token");
if (existsSync(oldClaudeToken) && !existsSync(defaultClaudeToken)) {
  mkdirSync(join(defaultHome, "secrets"), { recursive: true });
  renameSync(oldClaudeToken, defaultClaudeToken);
}
