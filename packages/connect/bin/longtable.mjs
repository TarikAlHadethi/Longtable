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
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { client, fetchConfig } from "../src/api.mjs";
import { claudeVersion, findClaude, tokenWorks } from "../src/claude.mjs";
import { codexSignIn, codexSignedIn, codexVersion, findCodex } from "../src/codex.mjs";
import { disableAutostart, enableAutostart } from "../src/autostart.mjs";
import { freshCopy, resolveSource } from "../src/repo.mjs";
import { runLoop } from "../src/run.mjs";
import { signIn } from "../src/signin.mjs";
import { forgetSecret, loadSecret, log, readConfig, saveSecret, writeConfig } from "../src/store.mjs";

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

  const cfg = await fetchConfig(app);
  const rpc = client(cfg);
  const paired = await rpc("pair_connection", { code, device_label: hostname() });
  if (paired.kind !== ai) throw new Error(`That connect code is for ${paired.kind === "codex" ? "Codex" : "Claude"}. Press Connect again.`);
  saveSecret(`device-${paired.table_id}-${paired.kind}`, paired.token);

  // A client's AI never gets the code. A team member's reads a clean copy of the project.
  let source = null;
  const repo = option("repo");
  if (paired.role !== "client") {
    try {
      source = resolveSource(repo || process.cwd());
    } catch (e) {
      if (repo) throw e;
    }
  }

  const config = readConfig();
  config.app = app;
  config.supabaseUrl = cfg.supabaseUrl;
  config.publishableKey = cfg.publishableKey;
  config.connections = (config.connections || []).filter((c) => !(c.table_id === paired.table_id && c.kind === paired.kind));
  config.connections.push({
    table_id: paired.table_id,
    kind: paired.kind,
    table_name: paired.table_name,
    member_name: paired.member_name,
    role: paired.role,
    source,
    model: option("model") || null,
  });
  writeConfig(config);

  if (source) freshCopy(paired.table_id, source);

  if (ai === "claude") {
    const token = loadSecret("claude-token");
    if (!token || !tokenWorks(claude, token)) {
      say("A page is opening in your browser so this connection can have its own Claude sign-in. Approve it there.");
      if (!(await signIn(claude))) throw new Error("The Claude sign-in didn't finish. Press Connect my Claude again.");
    }
  } else if (!codexSignedIn(codex)) {
    say("A page is opening in your browser so this connection can have its own ChatGPT sign-in for Codex. Approve it there.");
    if (!(await codexSignIn(codex))) throw new Error("The ChatGPT sign-in didn't finish. Press Connect again.");
  }

  if (!has("no-autostart")) enableAutostart(process.execPath, binPath);
  if (!has("no-run")) {
    spawn(process.execPath, [binPath, "run"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  }
  const word = ai === "codex" ? "Codex" : "Claude";
  log(`connected to "${paired.table_name}" for ${paired.member_name} (${ai === "codex" ? codexVersion(codex) : claudeVersion(claude)})`);
  say(`Connected. ${paired.member_name}'s ${word} is now at "${paired.table_name}". It answers in the background whenever this computer is on.`);
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

function disconnect() {
  const config = readConfig();
  for (const c of config.connections || []) forgetSecret(`device-${c.table_id}-${c.kind}`);
  writeConfig({ ...config, connections: [] });
  disableAutostart();
  say("Disconnected on this computer. Remove it in Longtable's settings too if it still shows.");
}

try {
  if (command === "connect") await connect();
  else if (command === "run") await runLoop();
  else if (command === "status") await status();
  else if (command === "disconnect") disconnect();
  else say("Usage: longtable connect <code> | run | status | disconnect");
} catch (e) {
  log(`error: ${e.message}`);
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
}
