// Claude Code on this computer: where it is, its own sign-in for the connection, and a locked-down answer.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { loadSecret, log } from "./store.mjs";

const isWindows = process.platform === "win32";
const exe = isWindows ? "claude.exe" : "claude";

function byVersionDesc(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
  return 0;
}

// PATH, then the native installer, then the copy bundled with Claude Desktop on Windows.
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

// A clean environment: only what the operating system needs, plus the connection's own sign-in.
// Nothing from the parent process leaks in: no API keys, no settings from whatever started the connection.
export function childEnv(token) {
  const keep = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP",
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "HOME", "USER", "LANG", "SHELL"];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
}

// A token only counts once a one-word request goes through with it.
export function tokenWorks(claude, token) {
  const r = spawnSync(claude, ["-p", "Reply with the word OK", "--output-format", "json", "--model", "haiku",
    "--max-turns", "1", "--restricted", "--permission-mode", "dontAsk", "--tools", ""], {
    env: childEnv(token), windowsHide: true, timeout: 120000,
  });
  try {
    return JSON.parse(r.stdout.toString()).is_error === false;
  } catch {
    return false;
  }
}

export function claudeVersion(claude) {
  return execFileSync(claude, ["--version"], { windowsHide: true, env: childEnv(null) }).toString().trim();
}

// Answer one job, locked down: read and search the clean copy only. No commands, no edits, no network tools, none
// of the person's own settings, and no MCP servers. The prompt goes in through stdin, so a long table history never
// hits the command-line length limit. With a schema, the result carries `structured_output`.
export function ask({ claude, cwd, prompt, system, schema, model, timeoutMs = 4 * 60 * 1000 }) {
  const token = loadSecret("claude-token");
  if (!token) return Promise.reject(new Error("This connection has no Claude sign-in yet. Run connect again."));
  const args = ["-p", "--output-format", "json", "--restricted", "--permission-mode", "dontAsk",
    "--strict-mcp-config", "--max-turns", "25", "--tools", "Read,Grep,Glob"];
  if (system) args.push("--append-system-prompt", system);
  if (schema) args.push("--json-schema", JSON.stringify(schema));
  if (model) args.push("--model", model);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(claude, args, { cwd, env: childEnv(token), windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        resolve({ ...JSON.parse(out), wall_ms: Date.now() - started });
      } catch {
        log(`claude exited ${code} without JSON: ${err.slice(0, 300)}`);
        reject(new Error("Claude Code did not answer. See the runner log."));
      }
    });
    child.stdin.end(prompt);
  });
}
