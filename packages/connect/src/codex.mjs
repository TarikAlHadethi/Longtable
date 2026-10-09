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
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
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
      const tools = events.filter((e) => e.type === "item.started" || e.type === "item.completed")
        .map((e) => e.item?.type).filter((t) => t && t !== "agent_message" && t !== "reasoning");
      resolve({ structured_output: structured, usage, tools, wall_ms: Date.now() - started });
    });
    child.stdin.end(prompt);
  });
}
