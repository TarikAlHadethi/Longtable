#!/usr/bin/env node
// longtable: brings your own Claude Code or Codex to your team's Longtable, quietly, on your own plan.
//
//   longtable connect <code> [--ai claude|codex] [--app <url>] [--repo <folder or git address>] [--model <name>]
//                     [--no-autostart] [--no-run]
//   longtable run
//   longtable status
//   longtable disconnect
//
// Nobody types these: Longtable's Connect button hands them to the person's own Claude or Codex, which runs them
// after the person presses Send. A client's AI gets no copy of the code.

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { client, fetchConfig } from "../src/api.mjs";
import { claudeVersion, findClaude, tokenWorks } from "../src/claude.mjs";
import { codexSignIn, codexSignedIn, codexVersion, findCodex } from "../src/codex.mjs";
import { disableAutostart, enableAutostart } from "../src/autostart.mjs";
import { forgetCopies, freshCopy, gitCanJoin, resolveSource } from "../src/repo.mjs";
import { endConnection, runLoop, runningConnection } from "../src/run.mjs";
import { handOffTo } from "../src/update.mjs";
import { pathToFileURL } from "node:url";
import { forgetSecret, home, loadSecret, log, readConfig, saveSecret, writeConfig } from "../src/store.mjs";

const binPath = fileURLToPath(import.meta.url);
const [command, ...args] = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
};
const has = (name) => args.includes(`--${name}`);
const say = (line) => process.stdout.write(`${line}\n`);

async function connect() {
  const code = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && ["app", "repo", "model", "ai"].includes(args[i - 1].slice(2))));
  if (!code) throw new Error("Missing the connect code. Press Connect in Longtable again.");
  const app = option("app") || "https://longtable.chat";
  const ai = option("ai") || "claude";
  if (!["claude", "codex"].includes(ai)) throw new Error("--ai is claude or codex.");
  // Check the AI is here before the one-use code is spent.
  const claude = ai === "claude" ? findClaude() : null;
  const codex = ai === "codex" ? findCodex() : null;
  if (ai === "claude" && !claude) throw new Error("Claude Code isn't installed on this computer. Install it from claude.com/claude-code, then press Connect again.");
  if (ai === "codex" && !codex) throw new Error("Codex's command-line tool isn't installed on this computer. Install it with npm install -g @openai/codex, then press Connect again.");

  // Find the code before the one-use code is spent: a repository this computer cannot open stops here, with
  // nothing changed at the table. (A client's AI gets no code; whether this is one is only known after pairing.)
  let source = null;
  const repo = option("repo");
  try {
    source = resolveSource(repo || process.cwd());
  } catch (e) {
    if (repo) throw e;
  }

  const cfg = await fetchConfig(app);
  const rpc = client(cfg);
  const paired = await rpc("pair_connection", { code, device_label: { win32: "Windows computer", darwin: "Mac", linux: "Linux computer" }[process.platform] || "computer" });
  // From here on, anything that goes wrong takes the connection off the table again, so the table never shows an AI
  // as connected that is not running.
  const leave = async (message) => {
    try { await rpc("runner_leave", { token: paired.token, reason: message }); } catch {}
    forgetSecret(`device-${paired.table_id}-${paired.kind}`);
    throw new Error(message);
  };
  if (paired.kind !== ai) await leave(`That connect code is for ${paired.kind === "codex" ? "Codex" : "Claude"}. Press Connect again.`);
  saveSecret(`device-${paired.table_id}-${paired.kind}`, paired.token);
  if (paired.role === "client") source = null;
  else if (!source) await leave("This folder is not the project. Open your AI in the project's own folder, then press Connect again.");

  const config = readConfig();
  config.app = app;
  config.supabaseUrl = cfg.supabaseUrl;
  config.publishableKey = cfg.publishableKey;
  // One seat per person at a table: connecting a different AI takes the place of the one that was there.
  for (const old of (config.connections || []).filter((c) => c.table_id === paired.table_id && c.kind !== paired.kind)) forgetSecret(`device-${old.table_id}-${old.kind}`);
  config.connections = (config.connections || []).filter((c) => c.table_id !== paired.table_id);
  config.connections.push({
    table_id: paired.table_id,
    kind: paired.kind,
    table_name: paired.table_name,
    member_name: paired.member_name,
    role: paired.role,
    source,
    folder: /^(https?:|git@|ssh:)/.test(repo || "") ? null : resolve(repo || process.cwd()),
    model: option("model") || null,
  });
  writeConfig(config);

  if (source) {
    try {
      freshCopy(paired.table_id, source);
    } catch (e) {
      writeConfig({ ...config, connections: config.connections.filter((c) => c.table_id !== paired.table_id) });
      await leave(`The connection could not copy the project's code: ${String(e.message).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || "git could not reach it"}`);
    }
  }

  if (ai === "claude") {
    const token = loadSecret("claude-token");
    if (!token || !tokenWorks(claude, token)) {
      say("A page is opening in your browser so this connection can have its own Claude sign-in. Approve it there.");
      // Loaded only here: it needs packages that the copy kept for start-up does not carry.
      const { signIn } = await import("../src/signin.mjs");
      if (!(await signIn(claude))) await leave("The Claude sign-in didn't finish. Press Connect again.");
    }
  } else if (!codexSignedIn(codex)) {
    say("A page is opening in your browser so this connection can have its own ChatGPT sign-in for Codex. Approve it there.");
    if (!(await codexSignIn(codex))) await leave("The ChatGPT sign-in didn't finish. Press Connect again.");
  }

  const auto = has("no-autostart") ? { started: false } : enableAutostart(process.execPath, binPath);
  if (!has("no-run") && !auto.started) {
    spawn(process.execPath, [binPath, "run"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  }
  const word = ai === "codex" ? "Codex" : "Claude";
  log(`connected to "${paired.table_name}" for ${paired.member_name} (${ai === "codex" ? codexVersion(codex) : claudeVersion(claude)})`);
  say(`Connected. ${paired.member_name}'s ${word} is now at "${paired.table_name}". It answers in the background whenever this computer is on.`);
  const git = gitCanJoin();
  if (!git.ok) {
    log(`git cannot join two parts of work (${git.version})`);
    say(`One thing to know: this computer's git (${git.version}) is older than 2.38, so when two AIs work on one task, this one's part goes on a branch of its own beside the other. Updating git puts them together.`);
  }
}

async function status() {
  const config = readConfig();
  if (!config.connections?.length) return say("Not connected to any table.");
  const rpc = client(config);
  for (const c of config.connections) {
    const token = loadSecret(`device-${c.table_id}-${c.kind}`);
    let state = "missing its device key";
    if (token) {
      try {
        await rpc("runner_hello", { token });
        state = "connected";
      } catch (e) {
        state = e.message;
      }
    }
    say(`${c.member_name}'s ${c.kind === "claude" ? "Claude" : "Codex"} at "${c.table_name}": ${state}${c.source ? `, reading ${c.source}` : ""}`);
  }
}

async function disconnect() {
  const config = readConfig();
  // The table is told first, so it takes the AI off at once (its list of commands goes with it).
  if (config.supabaseUrl && config.publishableKey) {
    const rpc = client(config);
    for (const c of config.connections || []) {
      const token = loadSecret(`device-${c.table_id}-${c.kind}`);
      if (token) { try { await rpc("runner_leave", { token, reason: "Disconnected on its own computer" }); } catch (e) { log(`disconnect: the table was not told: ${e.message}`); } }
    }
  }
  for (const c of config.connections || []) forgetSecret(`device-${c.table_id}-${c.kind}`);
  writeConfig({ ...config, connections: [] });
  disableAutostart();
  // The connection that is running right now still holds its keys in memory: end it.
  try {
    const pid = runningConnection();
    if (pid && pid !== process.pid) endConnection(pid);
  } catch {}
  rmSync(join(home, "runner.pid"), { force: true });
  // The project copies and work folders it kept go too. The Claude sign-in stays: it is the person's own,
  // and another table on this computer may still use it.
  forgetCopies((config.connections || []).map((c) => c.table_id), (config.connections || []).map((c) => c.folder).filter(Boolean));
  // Its own notes from those tables, and a client's ChatGPT sign-in kept for Longtable alone, go too.
  for (const c of config.connections || []) { try { rmSync(join(home, "minds", `${String(c.table_id).replace(/[^0-9a-f-]/gi, "")}.md`), { force: true }); } catch {} }
  if ((config.connections || []).some((c) => c.role === "client")) { try { rmSync(join(home, "codex"), { recursive: true, force: true }); } catch {} }
  say("Disconnected on this computer, and its copies of the project are removed. Remove it in Longtable's settings too if it still shows.");
}

try {
  if (command === "connect") await connect();
  else if (command === "run") {
    if (!readConfig().connections?.length) { log("run: not connected to any table, so nothing to do"); process.exit(0); }
    // Started from an older copy (a cache, or an old start-up entry) while ~/.longtable/app holds a newer one: run that.
    const newerCopy = handOffTo();
    if (newerCopy) { log(`run: handing over to the newer copy in ${newerCopy}`); await import(pathToFileURL(newerCopy).href); }
    else await runLoop();
  }
  else if (command === "status") await status();
  else if (command === "disconnect") await disconnect();
  else say("Usage: longtable connect <code> | run | status | disconnect");
} catch (e) {
  log(`error: ${e.message}`);
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
}
