#!/usr/bin/env node
// The permission prompts of a person's full Claude Code at the table, brought to them in Longtable. Claude Code starts
// this as an MCP server and calls its one tool, "approve", whenever it wants to do something the person's own rules
// do not already allow (--permission-prompt-tool). The request goes to Longtable; the person allows or denies it on
// their own screen; the answer comes back here and decides. Nobody else at the table can answer. An answer that does
// not come in 10 minutes is a no.
//
// It is given, through its environment: Longtable's address and public key, a key for this one job (never the
// connection's device token: a key that can only ask about this job, and dies when it ends), and the file where this
// person's "always allow" answers are kept on this computer.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { client } from "./api.mjs";

const NL = String.fromCharCode(10);
const rpc = client({ supabaseUrl: process.env.LT_SUPABASE_URL, publishableKey: process.env.LT_KEY });
const key = process.env.LT_JOB_KEY;
const alwaysFile = process.env.LT_ALWAYS;
const WAIT_MS = Number(process.env.LT_WAIT_MS || 10 * 60 * 1000);
const POLL_MS = Number(process.env.LT_POLL_MS || 1500);

// What the person is asked: exactly what would be done. A command is shown whole; any other tool shows its whole
// input. Nothing is ever cut short: a request too long to show in full is refused instead (null).
export const SHOW_MAX = 2000;
export function describe(tool, input) {
  const i = input && typeof input === "object" ? input : {};
  let text = "";
  if (tool === "Bash") text = String(i.command || "");
  else { try { text = JSON.stringify(i, null, 1); } catch { text = ""; } }
  return text.length > SHOW_MAX ? null : text;
}

// The rule an "always allow" answer adds: one command, exactly as it was asked for, and nothing broader. Never a
// whole tool, and never a command Claude Code could read as a pattern or that chains other commands.
const PLAIN = /^[^*()\r\n;&|`$<>]{1,500}$/;
export function ruleFor(tool, input) {
  const command = String(input?.command || "").trim();
  return tool === "Bash" && PLAIN.test(command) ? `Bash(${command})` : null;
}

// The rules kept on this computer, checked every time they are read: anything that is not one plain command is
// dropped, so nothing written into the file by anyone else can widen what runs unasked.
export function alwaysRules(file) {
  try {
    const list = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(list) ? list.filter((r) => typeof r === "string" && /^Bash\(.+\)$/.test(r) && PLAIN.test(r.slice(5, -1))) : [];
  } catch { return []; }
}

function remember(rule) {
  if (!alwaysFile || !rule) return;
  const list = alwaysRules(alwaysFile);
  if (list.includes(rule)) return;
  mkdirSync(dirname(alwaysFile), { recursive: true });
  writeFileSync(alwaysFile, JSON.stringify([...list, rule].slice(-200), null, 2));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function decide(tool, input) {
  const summary = describe(tool, input);
  if (summary === null) return { behavior: "deny", message: "This was too long to show the person in full, so it was not asked and not done. Break it into smaller steps." };
  let id;
  try {
    id = await rpc("runner_ask_approval", { key, tool, summary });
  } catch (e) {
    return { behavior: "deny", message: `Longtable could not ask the person (${e.message}), so this was not done.` };
  }
  for (const end = Date.now() + WAIT_MS; Date.now() < end;) {
    await sleep(POLL_MS);
    let r;
    try { r = await rpc("runner_approval", { key, a: id }); } catch { continue; }
    if (r?.status === "allowed") {
      if (r.always) remember(ruleFor(tool, input));
      return { behavior: "allow", updatedInput: input };
    }
    if (r?.status === "denied") return { behavior: "deny", message: "The person said no to this in Longtable. Do not try it another way; say what you would have done instead." };
    if (r?.status === "expired") break;
  }
  return { behavior: "deny", message: "Nobody answered this in Longtable in time, so it was not done. Say what you would have done, and the person can ask again." };
}

// The MCP side: JSON-RPC over stdin and stdout, one message a line.
function serve() {
  let buf = "";
  const send = (m) => process.stdout.write(JSON.stringify(m) + NL);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    buf += d;
    let at;
    while ((at = buf.indexOf(NL)) >= 0) {
      const line = buf.slice(0, at);
      buf = buf.slice(at + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      const reply = (result) => send({ jsonrpc: "2.0", id: m.id, result });
      if (m.method === "initialize") {
        reply({ protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "longtable", version: "1" } });
      } else if (m.method === "tools/list") {
        reply({ tools: [{ name: "approve", description: "Asks the person in Longtable whether their Claude may do this.",
          inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, required: ["tool_name", "input"] } }] });
      } else if (m.method === "tools/call") {
        const a = m.params?.arguments || {};
        decide(String(a.tool_name || "a tool"), a.input || {}).then(
          (out) => reply({ content: [{ type: "text", text: JSON.stringify(out) }] }),
          () => reply({ content: [{ type: "text", text: JSON.stringify({ behavior: "deny", message: "Longtable could not ask the person, so this was not done." }) }] }));
      } else if (m.id !== undefined) {
        reply({});
      }
    }
  });
}

if (process.argv[1] && process.argv[1].endsWith("approve-server.mjs")) serve();
