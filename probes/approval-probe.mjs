// Probe: can a headless Claude Code run relay its permission prompts to a tool of ours (--permission-prompt-tool),
// so a person can approve a command from somewhere else? Uses the connection's saved sign-in, a scratch repository,
// and a tiny MCP server that writes each prompt to a file and answers it.
//
//   node probes/approval-probe.mjs allow|deny

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findClaude, childEnv } from "../packages/connect/src/claude.mjs";
import { loadSecret } from "../packages/connect/src/store.mjs";

const answer = process.argv[2] === "deny" ? "deny" : "allow";
const dir = mkdtempSync(join(tmpdir(), "lt-approve-"));
execFileSync("git", ["init", "-q", dir]);
writeFileSync(join(dir, "hello.js"), "console.log('hello from the probe');\n");
const log = join(dir, "prompts.jsonl");

// The MCP server: one tool, "approve", answering every permission prompt with the chosen answer.
const server = join(dir, "approve-server.mjs");
writeFileSync(server, `
import { appendFileSync } from "node:fs";
const ANSWER = ${JSON.stringify(answer)};
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
    if (m.method === "initialize") reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "lt", version: "0" } });
    else if (m.method === "tools/list") reply({ tools: [{ name: "approve", description: "Answers permission prompts", inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, required: ["tool_name", "input"] } }] });
    else if (m.method === "tools/call") {
      appendFileSync(${JSON.stringify(log)}, JSON.stringify(m.params.arguments) + "\\n");
      const a = m.params.arguments;
      const out = ANSWER === "allow" ? { behavior: "allow", updatedInput: a.input } : { behavior: "deny", message: "The person said no." };
      reply({ content: [{ type: "text", text: JSON.stringify(out) }] });
    } else if (m.id !== undefined) reply({});
  }
});
`);
const mcp = join(dir, "mcp.json");
writeFileSync(mcp, JSON.stringify({ mcpServers: { lt: { command: process.execPath, args: [server] } } }));

const token = loadSecret("claude-token");
const args = ["-p", "--output-format", "json", "--no-session-persistence", "--model", "haiku", "--max-turns", "6",
  "--strict-mcp-config", "--mcp-config", mcp, "--permission-prompt-tool", "mcp__lt__approve", "--permission-mode", "manual"];
const child = spawn(findClaude(), args, { cwd: dir, env: childEnv(token), windowsHide: true });
let out = "", err = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (err += d));
child.stdin.end("Run the command `node hello.js` with your Bash tool and tell me exactly what it printed. Do not do anything else.");
child.on("close", (code) => {
  let r = {};
  try { r = JSON.parse(out); } catch {}
  console.log(JSON.stringify({ code, answer, result: r.result, prompts: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [], err: err.slice(0, 400) }, null, 2));
});
