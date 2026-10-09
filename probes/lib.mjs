// Shared pieces for the feasibility probes. The runner (packages/connect) will grow out of these.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";

const isWindows = process.platform === "win32";
const exe = isWindows ? "claude.exe" : "claude";

function byVersionDesc(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
  return 0;
}

// Where Claude Code lives: PATH, then the native installer, then the copy bundled with Claude Desktop on Windows.
export function findClaude() {
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (dir && existsSync(join(dir, exe))) return join(dir, exe);
  }
  const native = join(homedir(), ".local", "bin", exe);
  if (existsSync(native)) return native;
  if (isWindows) {
    const root = join(process.env.APPDATA || "", "Claude", "claude-code");
    if (existsSync(root)) {
      const versions = readdirSync(root).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort(byVersionDesc);
      for (const v of versions) {
        for (const h of readdirSync(join(root, v))) {
          const p = join(root, v, h, exe);
          if (existsSync(p)) return p;
        }
      }
    }
  }
  return null;
}

// The background connection's own Claude sign-in, kept on this computer only.
// Windows: encrypted for this Windows user with DPAPI. Elsewhere: a file only this user can read.
const tokenDir = join(homedir(), ".longtable");
const tokenFile = join(tokenDir, isWindows ? "claude-token.bin" : "claude-token");

function powershell(script, input) {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input,
    env: { ...process.env, LT_TOKEN_FILE: tokenFile },
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error("PowerShell failed: " + r.stderr.toString().slice(0, 300));
  return r.stdout.toString();
}

export function saveToken(token) {
  mkdirSync(tokenDir, { recursive: true });
  if (isWindows) {
    powershell(
      "Add-Type -AssemblyName System.Security; $t = [Console]::In.ReadToEnd(); " +
        "$p = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($t), $null, 'CurrentUser'); " +
        "[IO.File]::WriteAllBytes($env:LT_TOKEN_FILE, $p)",
      token,
    );
  } else {
    writeFileSync(tokenFile, token, { mode: 0o600 });
    chmodSync(tokenFile, 0o600);
  }
}

export function loadToken() {
  if (!existsSync(tokenFile)) return null;
  if (isWindows) {
    return powershell(
      "Add-Type -AssemblyName System.Security; $p = [IO.File]::ReadAllBytes($env:LT_TOKEN_FILE); " +
        "$b = [Security.Cryptography.ProtectedData]::Unprotect($p, $null, 'CurrentUser'); " +
        "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))",
    ).trim();
  }
  return readFileSync(tokenFile, "utf8").trim();
}

// A clean environment for a background Claude: only what the operating system needs, plus its own sign-in.
// Nothing from the parent process leaks in (no API keys, no host settings from whatever started it).
export function childEnv(token) {
  const keep = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP",
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "HOME", "USER", "LANG", "SHELL"];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
}

export function redact(text) {
  return String(text).replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[token hidden]");
}

export function claudeVersion(claude) {
  return execFileSync(claude, ["--version"], { windowsHide: true, env: childEnv(null) }).toString().trim();
}
