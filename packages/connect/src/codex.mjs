// Codex on this computer: where it is, the connection's own ChatGPT sign-in, and a locked-down answer.
//
// The connection keeps its own Codex folder (CODEX_HOME), so its sign-in and settings are its own and none of the
// person's Codex settings, plugins or MCP servers come in. Every tool is switched off: a client's AI only reads
// what the job hands it and writes a reply.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { childEnv } from "./claude.mjs";
import { home, log } from "./store.mjs";

const isWindows = process.platform === "win32";

// Its own sign-in lives here. LONGTABLE_CODEX_HOME points tests at a signed-in folder.
export const codexHome = process.env.LONGTABLE_CODEX_HOME || join(home, "codex");

// OpenAI's Codex command-line tool. The desktop app's own copy cannot be run from outside it.
// npm puts a launcher script on PATH; it is run with this Node, so nothing goes through a shell.
export function findCodex() {
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    const js = join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(js)) return { cmd: process.execPath, pre: [js] };
    const bin = join(dir, isWindows ? "codex.exe" : "codex");
    if (existsSync(bin)) {
      const real = realpathSync(bin);
      return real.endsWith(".js") ? { cmd: process.execPath, pre: [real] } : { cmd: real, pre: [] };
    }
  }
  return null;
}

function env() {
  mkdirSync(codexHome, { recursive: true });
  return { ...childEnv(null), CODEX_HOME: codexHome };
}

export function codexVersion(codex) {
  const r = spawnSync(codex.cmd, [...codex.pre, "--version"], { env: env(), windowsHide: true });
  return r.stdout.toString().trim();
}

export function codexSignedIn(codex) {
  const r = spawnSync(codex.cmd, [...codex.pre, "login", "status"], { env: env(), windowsHide: true, timeout: 30000 });
  return r.status === 0 && /logged in/i.test(`${r.stdout}${r.stderr}`);
}

// Codex's own sign-in: it opens the person's browser at OpenAI and waits for them to approve.
export function codexSignIn(codex, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(codex.cmd, [...codex.pre, "login"], { env: env(), windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0 && codexSignedIn(codex)); });
    child.on("error", () => { clearTimeout(timer); resolve(false); });
  });
}

// Every tool Codex has, off. What is left is the model reading the prompt and writing the reply.
const OFF = ["shell_tool", "unified_exec", "apps", "plugins", "multi_agent", "image_generation", "browser_use",
  "browser_use_external", "computer_use", "view_image", "hooks", "skill_search", "tool_suggest", "goals",
  "in_app_browser", "remote_plugin", "workspace_dependencies", "sleep_tool", "code_mode_host"];

// Answer one job, locked down: an empty folder, read-only, no tools, nothing saved, none of the person's own
// settings or rules. The prompt goes in through stdin; the reply comes back shaped by the schema.
export function askCodex({ codex, prompt, schema, model, timeoutMs = 3 * 60 * 1000 }) {
  const work = mkdtempSync(join(tmpdir(), "longtable-codex-"));
  const schemaFile = join(work, "schema.json");
  const lastFile = join(work, "last.json");
  const room = join(work, "room");
  mkdirSync(room);
  writeFileSync(schemaFile, JSON.stringify(schema));
  const args = [...codex.pre, "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config",
    "--ignore-rules", "--sandbox", "read-only", "--color", "never", "-C", room,
    "--output-schema", schemaFile, "-o", lastFile, "-c", 'web_search="disabled"'];
  for (const f of OFF) args.push("--disable", f);
  if (model) args.push("-m", model);
  args.push("-");
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(codex.cmd, args, { cwd: room, env: env(), windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdin.on("error", () => {});
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => { if (err.length < 4000) err += d; });
    child.on("error", (e) => { clearTimeout(timer); rmSync(work, { recursive: true, force: true }); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const events = out.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      let structured = null;
      try { structured = JSON.parse(readFileSync(lastFile, "utf8")); } catch {}
      rmSync(work, { recursive: true, force: true });
      if (!structured) {
        log(`codex exited ${code} without an answer: ${err.slice(0, 300)}`);
        return reject(new Error("Codex did not answer. See the runner log."));
      }
      const usage = events.filter((e) => e.type === "turn.completed").map((e) => e.usage).filter(Boolean).at(-1) || {};
      const items = events.filter((e) => e.type === "item.started" || e.type === "item.completed").map((e) => e.item || {});
      // Codex's own notices arrive as error items (switching its code-mode host off makes it say code mode "will
      // fail closed"); they are logged, not counted. Anything else that is not its message or reasoning is a tool.
      for (const i of items) if (i.type === "error") log(`codex notice: ${String(i.message || "").slice(0, 200)}`);
      const tools = items.map((i) => i.type).filter((t) => t && !["agent_message", "reasoning", "error"].includes(t));
      resolve({ structured_output: structured, usage, tools, wall_ms: Date.now() - started });
    });
    child.stdin.end(prompt);
  });
}

// The ChatGPT plan's Codex limits, read from Codex's own app server (account/rateLimits/read). Null if it does not
// answer within ten seconds.
export function codexLimits(codex) {
  return new Promise((resolve) => {
    const child = spawn(codex.cmd, [...codex.pre, "app-server"], { env: env(), windowsHide: true });
    let buf = "";
    let limits = null;
    let over = false;
    // Once answered or out of time, nothing more is read or written: a reply arriving after the ten seconds used to
    // write to the stopped program's input, and that failed write took the whole connection down.
    const done = (value) => { if (over) return; over = true; clearTimeout(timer); try { child.kill(); } catch {} resolve(value); };
    const timer = setTimeout(() => done(limits), 10000);
    child.stdin.on("error", (e) => log(`codex limits: ${e.message}`));
    child.stdout.on("error", (e) => log(`codex limits: ${e.message}`));
    const send = (m) => { if (!over && child.stdin.writable) child.stdin.write(JSON.stringify(m) + "\n"); };
    const name = (mins) => mins === 300 ? "5-hour" : mins === 10080 ? "weekly" : mins === 43200 ? "30-day" : `${Math.round(mins / 60)}-hour`;
    const window = (w) => w && ({ name: name(w.windowDurationMins), used: Math.round(w.usedPercent ?? 0),
      resets: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null });
    child.stdout.on("data", (d) => {
      if (over) return;
      buf += d;
      let i;
      while (!over && (i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          send({ method: "initialized" });
          send({ method: "account/rateLimits/read", id: 2 });
        } else if (m.id === 2) {
          const r = m.result?.rateLimits;
          limits = r ? { ai: "codex", plan: r.planType || null, status: r.rateLimitReachedType ? "limited" : "allowed",
            windows: [window(r.primary), window(r.secondary)].filter(Boolean) } : null;
          send({ method: "model/list", id: 3, params: {} });
        } else if (m.id === 3) {
          // The model Codex uses when none is asked for: the one it marks as its default, else the first it lists.
          const list = m.result?.data || [];
          const pick = list.find((x) => x.isDefault) || list[0];
          done(limits ? { ...limits, model: pick?.id || null, models: list.filter((x) => !x.hidden).map((x) => x.id).filter(Boolean).slice(0, 12) } : null);
        }
      }
    });
    child.on("error", () => done(null));
    send({ method: "initialize", id: 1, params: { clientInfo: { name: "longtable", title: "Longtable", version: "0.1.0" } } });
  });
}
