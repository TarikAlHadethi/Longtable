// Where the connection keeps its settings and secrets, on this computer only.
// Secrets are encrypted for this Windows user with DPAPI; elsewhere they are files only this user can read.

import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const isWindows = process.platform === "win32";
export const defaultHome = isWindows ? join(process.env.LOCALAPPDATA || homedir(), "Longtable") : join(homedir(), ".longtable");
// LONGTABLE_HOME keeps a separate set of settings, for tests.
export const home = process.env.LONGTABLE_HOME || defaultHome;
const secretsDir = join(home, "secrets");
const configFile = join(home, "config.json");
const logFile = join(home, "runner.log");

mkdirSync(secretsDir, { recursive: true });

export function hideSecrets(text) {
  return String(text)
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[token]")
    .replace(/\b[0-9a-f]{64}\b/gi, "[device token]");
}

export function log(line) {
  appendFileSync(logFile, `${new Date().toISOString()} ${hideSecrets(line)}\n`);
}

export function readConfig() {
  if (!existsSync(configFile)) return { connections: [] };
  return JSON.parse(readFileSync(configFile, "utf8"));
}

export function writeConfig(config) {
  writeFileSync(configFile, JSON.stringify(config, null, 2));
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
