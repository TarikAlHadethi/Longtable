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
// apiKey is only for the evals in CI, on the owner's own key; a person's connection always uses their own sign-in.
export function childEnv(token, apiKey) {
  const keep = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP",
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "HOME", "USER", "LANG", "SHELL"];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
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
// A client's AI gets no tools at all (tools ""): it only reads what the job hands it.
// With `edit`, the file tools may also change files, still only inside the working folder and still with no commands:
// that is how a person's own AI does work they asked for, in the connection's copy.
export function ask({ claude, cwd, prompt, system, schema, model, tools = "Read,Grep,Glob", edit = false, long = false, onNote, control, apiKey, timeoutMs = 4 * 60 * 1000, addDirs = [] }) {
  // Work a person asked for takes as long as it takes: no time limit, and steps to match. It ends when it is done,
  // when someone presses Stop, or when the connection itself goes away.
  if (edit) { tools = "Read,Grep,Glob,Edit,Write"; timeoutMs = long ? 0 : 10 * 60 * 1000; }
  const token = apiKey ? null : loadSecret("claude-token");
  if (!token && !apiKey) return Promise.reject(new Error("This connection has no Claude sign-in yet. Run connect again."));
  // Streamed output carries the plan's usage limits (a rate_limit_event) as well as the result.
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--restricted", "--permission-mode", edit ? "acceptEdits" : "dontAsk",
    "--strict-mcp-config", "--max-turns", edit ? (long ? "10000" : "60") : tools ? "25" : "4", "--tools", tools];
  if (system) args.push("--append-system-prompt", system);
  if (schema) args.push("--json-schema", JSON.stringify(schema));
  if (model) args.push("--model", model);
  // Folders beside the working one that this job may read: only ever ones the connection chose.
  for (const d of addDirs) args.push("--add-dir", d);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(claude, args, { cwd, env: childEnv(token, apiKey), windowsHide: true });
    // Only the result and the plan's limits are kept: work with no time limit would otherwise hold every file it ever
    // read in memory.
    let err = "";
    let ended = "";
    let result = null;
    let rate = null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const timer = timeoutMs ? setTimeout(() => { ended = "ran out of time"; child.kill(); }, timeoutMs) : null;
    if (control) control.kill = () => { ended = "stopped"; child.kill(); };
    const lines = lineReader((e) => {
      if (e.type === "result") result = e;
      else if (e.type === "rate_limit_event") rate = e.rate_limit_info;
      else if (onNote && e.type === "assistant") {
        // A tool call says what the AI is doing right now.
        for (const part of e.message?.content || []) {
          if (part.type !== "tool_use") continue;
          const file = String(part.input?.file_path || part.input?.path || "").split(/[/\\]/).pop();
          onNote(part.name === "Edit" || part.name === "Write" ? `editing ${file}` : part.name === "Read" ? `reading ${file}` : "searching the code");
        }
      }
    });
    child.stdout.on("data", (d) => lines.push(d));
    child.stderr.on("data", (d) => { if (err.length < 4000) err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      lines.end();
      if (ended) return reject(new Error(ended));
      if (!result) {
        log(`claude exited ${code} without a result: ${err.slice(0, 300)}`);
        return reject(new Error("Claude Code did not answer. See the runner log."));
      }
      resolve({ ...result, wall_ms: Date.now() - started, limits: claudeLimits(rate) });
    });
    // A child that dies before it has read the whole prompt must not take the connection down with it.
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

// Output arrives a line at a time, each line one event: every whole line that is JSON goes to onEvent, blank and
// other lines are passed over, and a last line with no end is read when the output ends.
export function lineReader(onEvent) {
  let rest = "";
  const take = (line) => {
    if (!line.trim()) return;
    let e;
    try { e = JSON.parse(line); } catch { return; }
    onEvent(e);
  };
  return {
    push(d) {
      rest += d;
      let at;
      while ((at = rest.indexOf(String.fromCharCode(10))) !== -1) {
        const line = rest.slice(0, at);
        rest = rest.slice(at + 1);
        try { take(line); } catch {}
      }
    },
    end() { try { take(rest); } catch {} rest = ""; },
  };
}

// The plan's limits as Longtable shows them: each window's use in percent and when it resets.
export function claudeLimits(rate) {
  if (!rate) return null;
  const names = { five_hour: "5-hour", seven_day: "weekly" };
  const windows = Object.entries(rate.unifiedWindows || {}).map(([k, w]) => ({
    // A week counted for one model alone arrives as seven_day_<model>.
    name: names[k] || (k.startsWith("seven_day_") ? `weekly ${k.slice(10).replace(/_/g, " ")}` : k.replace(/_/g, " ")),
    used: Math.round((w.utilization ?? 0) * 100),
    resets: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null,
  }));
  return { ai: "claude", plan: null, status: rate.status === "rejected" ? "limited" : "allowed", windows };
}
