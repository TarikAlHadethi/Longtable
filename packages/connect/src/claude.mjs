// Claude Code on this computer: where it is, its own sign-in for the connection, and a locked-down answer.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { home, loadSecret, log } from "./store.mjs";

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
    // The Claude app's own copy: where the app sees it, and where Windows really keeps it for a packaged app, which
    // is what a connection started outside the app sees.
    const roots = [join(process.env.APPDATA || "", "Claude", "claude-code")];
    const packages = join(process.env.LOCALAPPDATA || "", "Packages");
    try { for (const d of readdirSync(packages)) if (/^Claude_/i.test(d)) roots.push(join(packages, d, "LocalCache", "Roaming", "Claude", "claude-code")); } catch {}
    for (const root of roots) {
      if (!existsSync(root)) continue;
      let versions = [];
      try { versions = readdirSync(root).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort(byVersionDesc); } catch {}
      for (const v of versions) {
        let builds = [];
        try { builds = readdirSync(join(root, v)); } catch {}
        for (const h of builds) {
          const p = join(root, v, h, exe);
          if (existsSync(p)) return p;
        }
      }
    }
  }
  return null;
}

// Claude Code from Anthropic's own installer, for a computer that has none the connection can run (only the
// Claude app's, kept to itself, or none at all). It is the documented way to install it; what it prints is shown.
export function installClaude() {
  const cmd = isWindows
    ? ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"]]
    : ["bash", ["-c", "curl -fsSL https://claude.ai/install.sh | bash"]];
  const r = spawnSync(cmd[0], cmd[1], { stdio: "inherit", windowsHide: true, timeout: 10 * 60 * 1000 });
  if (r.error) log(`installing Claude Code failed to start: ${r.error.message}`);
  return findClaude();
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

// A full Claude Code run gets the person's own environment, as their Claude Code at home would (their PATH, their git
// and their tools), with the connection's own sign-in: never an API key or another account from whatever started it.
export function fullEnv(token, { guard = true } = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_USE_|OPENAI_API_KEY$|LT_)/.test(k)) delete env[k];
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  // In their own folder git is theirs as at home: their hooks run and a push is theirs to approve.
  if (!guard) return env;
  // Git itself refuses every push from the commands this Claude runs, however the command is written (git -C, -c,
  // an alias, a script): every push address is rewritten to one no git can reach. Only the connection pushes, and
  // only the task's longtable/ branch. Git hooks point at an empty folder, so a hook from the branch never runs.
  const noHooks = join(home, "no-hooks");
  try { mkdirSync(noHooks, { recursive: true }); } catch {}
  env.GIT_CONFIG_COUNT = "2";
  env.GIT_CONFIG_KEY_0 = "url.longtable-no-push://refused/.pushInsteadOf";
  env.GIT_CONFIG_VALUE_0 = "";
  env.GIT_CONFIG_KEY_1 = "core.hooksPath";
  env.GIT_CONFIG_VALUE_1 = noHooks;
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

// Every Claude Code this connection has running. When the connection ends they end with it: before this, a
// disconnect or a second start ended the connection and left its Claude editing the work folder on its own.
const running = new Set();
export function keepTrack(child) {
  running.add(child);
  child.on("close", () => running.delete(child));
}
export function stopAll() {
  for (const child of running) { try { child.kill(); } catch {} }
  running.clear();
}

// Answer one job, locked down: read and search the clean copy only. No commands, no edits, no network tools, none
// of the person's own settings, and no MCP servers. The prompt goes in through stdin, so a long table history never
// hits the command-line length limit. With a schema, the result carries `structured_output`.
// A client's AI gets no tools at all (tools ""): it only reads what the job hands it.
// With `edit`, the file tools may also change files, still only inside the working folder and still with no commands:
// that is how a person's own AI does work they asked for, in the connection's copy.
export const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

// With `full`, the person runs their AI as their full Claude Code: their own settings, rules, hooks, MCP servers,
// skills and commands, every built-in tool including Bash, and Claude Code's own permission prompts sent to Longtable
// through the approval server (`full.mcp`, the MCP config that starts it), where the person allows or denies each one.
// Their "always allow" answers come back as `full.allow`. On Mac and Linux, commands also run in Claude Code's sandbox.
// A job that only reads may not change files (`edit` false).
export function ask({ claude, cwd, prompt, system, schema, model, tools = "Read,Grep,Glob", edit = false, long = false, onNote, control, apiKey, timeoutMs = 4 * 60 * 1000, addDirs = [], effort = null, fast = false, full = null }) {
  // Work a person asked for takes as long as it takes: no time limit, and steps to match. It ends when it is done,
  // when someone presses Stop, or when the connection itself goes away.
  if (edit) { tools = "Read,Grep,Glob,Edit,Write"; timeoutMs = long ? 0 : 10 * 60 * 1000; }
  // A full run can wait on the person's answers, so a short job gets longer than a locked one.
  if (full && !edit) timeoutMs = Math.max(timeoutMs, 15 * 60 * 1000);
  const token = apiKey ? null : loadSecret("claude-token");
  if (!token && !apiKey) return Promise.reject(new Error("This connection has no Claude sign-in yet. Run connect again."));
  // Streamed output carries the plan's usage limits (a rate_limit_event) as well as the result.
  const args = full
    ? ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
      // Their own choice of how it asks (manual, accept edits, auto, plan), else as before: edits go ahead in work.
      "--permission-mode", full.mode === "plan" ? "plan" : full.mode === "auto" ? "auto" : full.mode === "manual" ? "default" : full.mode === "acceptEdits" || edit ? "acceptEdits" : "default",
      "--permission-prompt-tool", "mcp__longtable__approve",
      "--mcp-config", full.mcp, "--max-turns", edit ? (long ? "10000" : "200") : "60"]
    : ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--restricted", "--permission-mode", edit ? "acceptEdits" : "dontAsk",
      "--strict-mcp-config", "--max-turns", edit ? (long ? "10000" : "60") : tools ? "25" : "4", "--tools", tools];
  if (full) {
    // Their own settings come from their own computer: their user settings, and their project's settings read from
    // their own folder (full.project), never from the branch being worked on, which other people's AIs push to.
    // In their own folder (full.folder) it is Claude Code as at home: every settings source of theirs, the project's
    // and their local ones included, read by Claude Code itself.
    args.push("--setting-sources", full.folder ? "user,project,local" : "user");
    // Only the connection pushes, and only the task's branch: their Claude never pushes itself, whatever their rules.
    // In their own folder a push is theirs, asked like any command. In plan mode the plan is its answer here: there is
    // no plan to approve, so it never asks to leave plan mode.
    const no = [...(full.folder ? [] : ["Bash(git push:*)", "Bash(git push)"]), ...(edit ? [] : ["Edit", "Write", "NotebookEdit"]), ...(full.mode === "plan" ? ["ExitPlanMode"] : [])];
    if (no.length) args.push("--disallowedTools", ...no);
    if (full.allow?.length) args.push("--allowedTools", ...full.allow);
  }
  if (system) args.push("--append-system-prompt", system);
  if (schema) args.push("--json-schema", JSON.stringify(schema));
  if (model) args.push("--model", model);
  // How hard it thinks, and fast mode: the person's own choices for their AI ("/effort", "/fast" at the table).
  if (EFFORTS.has(effort)) args.push("--effort", effort);
  // On Mac and Linux commands also run in Claude Code's sandbox, and still ask: the sandbox alone never stands in for
  // the person's answer.
  const settings = { ...(full?.project || {}), ...(fast ? { fastMode: true } : {}),
    ...(full && !full.folder && process.platform !== "win32" ? { sandbox: { ...(full?.project?.sandbox || {}), enabled: true, autoAllowBashIfSandboxed: false } } : {}) };
  if (Object.keys(settings).length) args.push("--settings", JSON.stringify(settings));
  // Folders beside the working one that this job may read: only ever ones the connection chose.
  for (const d of addDirs) args.push("--add-dir", d);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(claude, args, { cwd, env: full ? fullEnv(token, { guard: !full.folder }) : childEnv(token, apiKey), windowsHide: true });
    keepTrack(child);
    // Only the result and the plan's limits are kept: work with no time limit would otherwise hold every file it ever
    // read in memory.
    let err = "";
    let ended = "";
    let result = null;
    let rate = null;
    let init = null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const timer = timeoutMs ? setTimeout(() => { ended = "ran out of time"; child.kill(); }, timeoutMs) : null;
    if (control) control.kill = () => { ended = "stopped"; child.kill(); };
    const lines = lineReader((e) => {
      if (e.type === "result") result = e;
      // What this Claude Code has built in, and whether fast mode can serve: the table's "/" list and the AI's window.
      else if (e.type === "system" && e.subtype === "init") init = { commands: Array.isArray(e.slash_commands) ? e.slash_commands : [], fast: e.fast_mode_state || null, fastWhy: e.fast_mode_disabled_reason || null };
      else if (e.type === "rate_limit_event") rate = e.rate_limit_info;
      else if (onNote && e.type === "assistant") {
        // A tool call says what the AI is doing right now.
        for (const part of e.message?.content || []) {
          if (part.type !== "tool_use") continue;
          const where = String(part.input?.file_path || part.input?.path || "");
          // The path inside the project when it is in it (src/booking/StaffPicker.tsx), else the file's name alone.
          const inside = where && where.toLowerCase().startsWith(String(cwd).toLowerCase()) ? where.slice(String(cwd).length).replace(/^[/\\]+/, "").replace(/\\/g, "/") : "";
          const file = inside && inside.length <= 80 ? inside : where.split(/[/\\]/).pop();
          if (/[/\\]\.longtable-yours([/\\]|$)/.test(where) || /^\.longtable-yours([/\\]|$)/.test(where)) onNote("reading what it knows");
          // A command is named by its program only: the rest of a command line can hold a secret.
          else if (part.name === "Bash") onNote(`running ${String(part.input?.command || "").trim().split(/\s+/)[0].replace(/[^A-Za-z0-9._-]/g, "").slice(0, 30) || "a command"}`);
          else onNote(part.name === "Edit" || part.name === "Write" ? `editing ${file}` : part.name === "Read" ? `reading ${file}`
            : (part.name === "Grep" || part.name === "Glob") && part.input?.pattern ? `searching for ${String(part.input.pattern).replace(/\s+/g, " ").slice(0, 40)}` : "searching the code");
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
      resolve({ ...result, wall_ms: Date.now() - started, limits: claudeLimits(rate), init });
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
