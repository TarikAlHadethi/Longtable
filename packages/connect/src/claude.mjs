// Claude Code on this computer: where it is, its own sign-in for the connection, and a locked-down answer.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { home, loadSecret, log } from "./store.mjs";
import { below } from "./procs.mjs";

// A command that can leave a program running after it returns.
export const LEAVES_RUNNING = /(^|[^&<>])&(?![&>])|\bnohup\b|\bdisown\b|\bsetsid\b|\bnpm\s+(run\s+)?(dev|start)\b|\bnext\s+(dev|start)\b|\bvite\b|\bserve\b|docker\s+compose\s+up|\bpm2\b/i;

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
// Every character that can carry a repository address on past its end.
// (The table's repository is only ever an https or ssh address, whose names use few of these; the rest are here so
// an address on this computer, a path, is held to the same rule.)
const CONTINUES = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-~+/@:%\\ #?=,;!$&'()*[]"];

// The environment a full run's commands see. `pushTo`: the only addresses git may push to (an empty list refuses
// every push; null leaves pushing to the person, as at home). `hooksOff`: git hooks point at an empty folder.
export function fullEnv(token, { hooksOff = true, pushTo = [] } = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_USE_|OPENAI_API_KEY$|LT_)/.test(k)) delete env[k];
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  // A permission request waits for its person as long as they take, as at home: Claude Code's own limit on a tool call
  // (the approval is one) is set to a week, unless they set their own.
  if (!env.MCP_TOOL_TIMEOUT) env.MCP_TOOL_TIMEOUT = String(7 * 24 * 3600 * 1000);
  const conf = [];
  // Git itself refuses a push from the commands this Claude runs, however the command is written (git -C, -c, an
  // alias, a script): every push address is rewritten to one no git can reach. The addresses it may push to are
  // rewritten to themselves, and git takes the longest match, so only those go through.
  if (Array.isArray(pushTo)) {
    const NO = "url.longtable-no-push://refused/.pushInsteadOf";
    conf.push([NO, ""]);
    const allowed = [...new Set(pushTo.filter((x) => typeof x === "string" && x && !/[\r\n]/.test(x)))];
    for (const u of allowed) {
      conf.push([`url.${u}.pushInsteadOf`, u]);
      // The rewrite matches by prefix, so an address that only starts with an allowed one (team/app-old after
      // team/app) is refused by a longer rule of its own. An allowed longer form (app.git) is longer still and wins.
      for (const c of CONTINUES) if (!allowed.includes(u + c)) conf.push([NO, u + c]);
    }
  }
  // A hook from a branch other people's AIs push to never runs. In the person's own folder their hooks are theirs.
  if (hooksOff) {
    const noHooks = join(home, "no-hooks");
    try { mkdirSync(noHooks, { recursive: true }); } catch {}
    conf.push(["core.hooksPath", noHooks]);
  }
  if (conf.length) {
    env.GIT_CONFIG_COUNT = String(conf.length);
    conf.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  }
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
// A run asked for in Auto on an account that cannot use it goes again in Accept edits, rather than failing.
export function ask(opts) {
  return askOnce(opts).catch((e) => {
    if (!e.noAuto) throw e;
    log("Auto mode is not available to this Claude Code; running in Accept edits");
    return askOnce({ ...opts, full: { ...opts.full, mode: "acceptEdits" } });
  });
}

function askOnce({ claude, cwd, prompt, system, schema, model, tools = "Read,Grep,Glob", edit = false, long = false, onNote, control, apiKey, timeoutMs = 4 * 60 * 1000, addDirs = [], effort = null, fast = false, full = null, session = null }) {
  // Work a person asked for takes as long as it takes: no time limit, and steps to match. It ends when it is done,
  // when someone presses Stop, or when the connection itself goes away.
  if (edit) { tools = "Read,Grep,Glob,Edit,Write"; timeoutMs = long ? 0 : 10 * 60 * 1000; }
  // Their own full Claude Code takes as long as it takes, a question as much as work, as at home: no time limit and
  // steps to match. It ends when it is done, when they press Stop, or when the connection goes away.
  if (full) timeoutMs = 0;
  const token = apiKey ? null : loadSecret("claude-token");
  if (!token && !apiKey) return Promise.reject(new Error("This connection has no Claude sign-in yet. Run connect again."));
  // Streamed output carries the plan's usage limits (a rate_limit_event) as well as the result.
  const args = full
    ? ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
      // Their own choice of how it asks (manual, accept edits, auto, plan), else as before: edits go ahead in work.
      "--permission-mode", full.mode === "plan" ? "plan" : full.mode === "auto" ? "auto" : full.mode === "manual" ? "default" : full.mode === "acceptEdits" || edit ? "acceptEdits" : "default",
      "--permission-prompt-tool", "mcp__longtable__approve",
      "--mcp-config", full.mcp, "--max-turns", edit && !long ? "200" : "10000"]
    : ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--restricted", "--permission-mode", edit ? "acceptEdits" : "dontAsk",
      "--strict-mcp-config", "--max-turns", edit ? (long ? "10000" : "60") : tools ? "25" : "4", "--tools", tools];
  if (full) {
    // Their own settings come from their own computer: their user settings, and their project's settings read from
    // their own folder (full.project), never from the branch being worked on, which other people's AIs push to.
    // In their own folder (full.folder) it is Claude Code as at home: every settings source of theirs, the project's
    // and their local ones included, read by Claude Code itself.
    args.push("--setting-sources", full.folder ? "user,project,local" : "user");
    // Only the connection pushes, and only the task's branch: their Claude never pushes itself, whatever their rules.
    // In their own folder a push goes only to the table's repository (unless they let it push anywhere), asked like
    // any command. In plan mode the plan is its answer here: there is
    // no plan to approve, so it never asks to leave plan mode.
    // A remote with a push address of its own is not covered by git's rewrite, so then pushing is refused outright.
    // Its own question tool goes nowhere in a run like this; questions go to the person through Longtable's instead.
    const no = ["AskUserQuestion", ...(full.folder && !full.noPush ? [] : ["Bash(git push:*)", "Bash(git push)"]), ...(edit ? [] : ["Edit", "Write", "NotebookEdit"]), ...(full.mode === "plan" ? ["ExitPlanMode"] : [])];
    if (no.length) args.push("--disallowedTools", ...no);
    // Asking its person a question, or putting a file on its answer, is never itself something to ask permission for.
    args.push("--allowedTools", "mcp__longtable__ask", "mcp__longtable__share_file", ...(full.allow || []));
  }
  // A person's own chat in their own folder keeps one session, as at home: kept by Claude Code, picked up next time.
  if (session && full) {
    args.splice(args.indexOf("--no-session-persistence"), 1);
    args.push(session.resume ? "--resume" : "--session-id", session.id);
  }
  if (system) args.push("--append-system-prompt", system);
  if (schema) args.push("--json-schema", JSON.stringify(schema));
  if (model) args.push("--model", model);
  // How hard it thinks, and fast mode: the person's own choices for their AI ("/effort", "/fast" at the table).
  if (EFFORTS.has(effort)) args.push("--effort", effort);
  // On Mac and Linux commands also run in Claude Code's sandbox, and still ask: the sandbox alone never stands in for
  // the person's answer.
  // full.hooks: what the person says in the chat while it works reaches it after each step (added to the hooks of their
  // own settings, which Claude Code still runs).
  const settings = { ...(full?.project || {}), ...(fast ? { fastMode: true } : {}), ...(full?.hooks ? { hooks: full.hooks } : {}),
    ...(full && !full.folder && process.platform !== "win32" ? { sandbox: { ...(full?.project?.sandbox || {}), enabled: true, autoAllowBashIfSandboxed: false } } : {}) };
  if (Object.keys(settings).length) args.push("--settings", JSON.stringify(settings));
  // Folders beside the working one that this job may read: only ever ones the connection chose.
  for (const d of addDirs) args.push("--add-dir", d);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(claude, args, { cwd, env: full ? fullEnv(token, full.folder ? { hooksOff: false, pushTo: full.pushTo === undefined ? [] : full.pushTo } : {}) : childEnv(token, apiKey), windowsHide: true,
      // On Mac and Linux a full run leads its own process group, so what it starts can still be found after it is gone.
      detached: !!full && process.platform !== "win32" });
    keepTrack(child);
    // Only the result and the plan's limits are kept: work with no time limit would otherwise hold every file it ever
    // read in memory.
    let err = "";
    let ended = "";
    let result = null;
    let rate = null;
    let init = null;
    let initAt = 0;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const timer = timeoutMs ? setTimeout(() => { ended = "ran out of time"; child.kill(); }, timeoutMs) : null;
    if (control) control.kill = () => { ended = "stopped"; child.kill(); };
    // What this Claude starts and leaves running: looked for just after a command that can leave something behind,
    // and once more as it finishes, while it is still there to be the parent of what it started.
    const seen = new Map();
    const lingering = new Set();
    // Each listing is waited for before the run reports: the last one is taken as it finishes, and what it started still
    // names it as their parent after it has gone.
    const looks = [];
    const look = () => { if (full) looks.push(below(child.pid, started).then((list) => { for (const p of list) seen.set(`${p.pid}|${p.start}`, p); }).catch(() => {})); };
    const lines = lineReader((e) => {
      if (full && e.type === "assistant") {
        for (const part of e.message?.content || []) {
          if (part.type === "tool_use" && (part.name === "Bash" || part.name === "PowerShell") && (part.input?.run_in_background || LEAVES_RUNNING.test(String(part.input?.command || "")))) lingering.add(part.id);
        }
      } else if (full && e.type === "user") {
        for (const part of e.message?.content || []) if (part.type === "tool_result" && lingering.has(part.tool_use_id)) setTimeout(look, 1500);
      }
      if (e.type === "result") {
        result = e;
        // Where the time went, for when an answer is slow: starting Claude Code, waiting on the model, and the rest.
        log(`claude: started in ${initAt ? initAt - started : "?"} ms, answered after ${Date.now() - started} ms, ${e.duration_api_ms ?? "?"} ms with the model, ${e.num_turns ?? "?"} turns`);
        look();
        // Its answer is in. Claude Code can stay running after that, waiting on a program it left in the background; then
        // what it left is listed and that Claude Code ends, so the run finishes. What it started lives on (in a chat's
        // session) or is stopped (outside one).
        setTimeout(() => {
          if (finished || child.exitCode !== null) return;
          look();
          Promise.allSettled(looks).then(() => { try { child.kill(); } catch {} setTimeout(() => finish(child.exitCode), 1000); });
        }, 4000);
      }
      // What this Claude Code has built in, and whether fast mode can serve: the table's "/" list and the AI's window.
      else if (e.type === "system" && e.subtype === "init" && (initAt = initAt || Date.now())) init = { commands: Array.isArray(e.slash_commands) ? e.slash_commands : [], fast: e.fast_mode_state || null, fastWhy: e.fast_mode_disabled_reason || null };
      else if (e.type === "rate_limit_event") rate = e.rate_limit_info;
      else if (onNote && e.type === "assistant") {
        // A tool call says what the AI is doing right now, and what it writes between steps ("Rebuilt, running the
        // checks again") is shown as it says it, as in Claude Code: its first sentence, marked with a quote mark.
        for (const part of e.message?.content || []) {
          if (part.type === "text") {
            // Only from a person's own full Claude Code, as at home: never from work done for a client's copy or others.
            if (!full) continue;
            const first = Array.from(String(part.text || "").replace(/\s+/g, " ").trim().split(/(?<=[.!?:])\s/)[0] || "");
            if (first.length > 2) onNote(`"${first.length > 115 ? `${first.slice(0, 114).join("")}…` : first.join("")}`);
            continue;
          }
          if (part.type !== "tool_use") continue;
          const where = String(part.input?.file_path || part.input?.path || "");
          // The path inside the project when it is in it (src/booking/StaffPicker.tsx), else the file's name alone.
          const inside = where && where.toLowerCase().startsWith(String(cwd).toLowerCase()) ? where.slice(String(cwd).length).replace(/^[/\\]+/, "").replace(/\\/g, "/") : "";
          const file = inside && inside.length <= 80 ? inside : where.split(/[/\\]/).pop();
          if (/[/\\]\.longtable-yours([/\\]|$)/.test(where) || /^\.longtable-yours([/\\]|$)/.test(where)) onNote("reading what it knows");
          // A command is named by its program only: the rest of a command line can hold a secret.
          else if (part.name === "Bash" || part.name === "PowerShell") onNote(`running ${String(part.input?.command || "").trim().split(/\s+/)[0].replace(/[^A-Za-z0-9._-]/g, "").slice(0, 30) || "a command"}`);
          else onNote(part.name === "Edit" || part.name === "Write" ? `editing ${file}` : part.name === "Read" ? `reading ${file}`
            : (part.name === "Grep" || part.name === "Glob") && part.input?.pattern ? `searching for ${String(part.input.pattern).replace(/\s+/g, " ").slice(0, 40)}` : "searching the code");
        }
      }
    });
    let finished = false;
    // Read for as long as anything writes to it, even after the run is done, so a program left running never blocks on
    // a full pipe or fails writing to a closed one; what comes after the run is not kept.
    child.stdout.on("data", (d) => { if (!finished) lines.push(d); });
    child.stderr.on("data", (d) => { if (!finished && err.length < 4000) err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    // Done when Claude itself has exited, not when its output closes: a program it left running in the background holds
    // its output open, so waiting for that would wait as long as the program runs. A moment after it exits, for the
    // last of its output to be read, the run is finished, once.
    const finish = (code) => { if (finished) return; finished = true; if (lingering.size) look(); return Promise.allSettled(looks).then(() => {
      clearTimeout(timer);
      lines.end();
      const procs = [...seen.values()];
      if (ended) return reject(Object.assign(new Error(ended), { procs }));
      // Asked for Auto on an account or model that cannot use it: said so, so the run is tried again without it.
      const noAuto = full?.mode === "auto" && /auto/i.test(`${err} ${result?.is_error ? result.result || "" : ""}`)
        && /not (available|supported|enabled)|unavailable|unsupported|requires|disabled/i.test(`${err} ${result?.result || ""}`)
        && (!result || result.is_error);
      if (noAuto) return reject(Object.assign(new Error("Auto mode is not available here"), { noAuto: true }));
      // A session that is gone (deleted, or never written) cannot be picked up: said so, so the request starts a new one.
      if (session?.resume && (!result || result.is_error) && /no conversation found with session id/i.test(`${err} ${result?.result || ""}`)) {
        return reject(Object.assign(new Error("that session could not be picked up"), { noSession: true }));
      }
      if (!result) {
        log(`claude exited ${code} without a result: ${err.slice(0, 300)}`);
        return reject(new Error("Claude Code did not answer. See the runner log."));
      }
      resolve({ ...result, wall_ms: Date.now() - started, limits: claudeLimits(rate), init, procs });
    }); };
    child.on("close", (code) => finish(code));
    child.on("exit", (code) => setTimeout(() => finish(code), 1500));
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
