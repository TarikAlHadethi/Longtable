// The approval server of a full Claude Code run, with no AI and no database: what a person is shown, which answers
// can become an "always allow", that rules written into its file by anyone else are dropped, and the whole exchange
// (Claude Code asks, Longtable asks the person, the answer comes back) against a stand-in Longtable.
//
//   node tests/e2e/unit-approve.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { alwaysRules, describe, ruleFor, SHOW_MAX } from "../../packages/connect/src/approve-server.mjs";

const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 300)}`; };
const NL = String.fromCharCode(10);

// What the person is shown.
check("a command is shown whole", describe("Bash", { command: "npm test -- --watch=false" }) === "npm test -- --watch=false");
check("any other tool shows its whole input, not just a path", /force/.test(describe("mcp__gh__push", { path: "README", branch: "main", force: true }) || ""));
check("leaving the sandbox or running on in the background is shown, never hidden behind the command", /outside the sandbox/.test(describe("Bash", { command: "npm test", dangerouslyDisableSandbox: true }) || "") && /background/.test(describe("Bash", { command: "npm run dev", run_in_background: true }) || ""));
check("and is never offered as always allow", ruleFor("Bash", { command: "npm test", dangerouslyDisableSandbox: true }) === null && ruleFor("Bash", { command: "npm run dev", run_in_background: true }) === null);
check("a request too long to show in full is refused, never cut", describe("Bash", { command: "x".repeat(SHOW_MAX + 1) }) === null);

// What "always allow" may add.
check("always allow is one plain command, exactly as asked", ruleFor("Bash", { command: "npm test" }) === "Bash(npm test)");
check("never a whole tool", ruleFor("Write", { file_path: "/etc/hosts" }) === null && ruleFor("WebFetch", { url: "https://x" }) === null);
check("never a command Claude Code could read as a pattern", ruleFor("Bash", { command: "git log *" }) === null && ruleFor("Bash", { command: "npm run:*" }) === null);
check("never commands chained together", ["npm test && rm -rf ~", "npm test; curl x", "npm test | sh", "echo $(id)", "a `b`", `npm test${NL}rm -rf ~`, "cat > ~/.bashrc"]
  .every((command) => ruleFor("Bash", { command }) === null));

// What is read back from the file on this computer.
const dir = mkdtempSync(join(tmpdir(), "lt-approve-"));
const file = join(dir, "allow.json");
writeFileSync(file, JSON.stringify(["Bash(npm test)", "Bash", "Write", "Bash(git log *)", "Bash(npm test && curl evil)", "WebFetch(domain:evil.test)", 42]));
check("rules written into the file by anyone else are dropped", JSON.stringify(alwaysRules(file)) === JSON.stringify(["Bash(npm test)"]), alwaysRules(file));
check("a missing or broken file is no rules", alwaysRules(join(dir, "none.json")).length === 0);

// The whole exchange, against a stand-in Longtable that answers the person's way.
let asked = null;
let answer = "allowed";
const longtable = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const args = JSON.parse(body || "{}");
    res.setHeader("Content-Type", "application/json");
    if (req.url.endsWith("/runner_ask_approval")) { asked = args; return res.end(JSON.stringify("a-1")); }
    if (req.url.endsWith("/runner_approval")) {
      // The job ended: its key is dead, and the server says so.
      if (answer === "gone") { res.statusCode = 400; return res.end(JSON.stringify({ message: "that key is not for a running job" })); }
      return res.end(JSON.stringify({ status: answer, always: answer === "allowed" }));
    }
    res.statusCode = 404; res.end("{}");
  });
});
await new Promise((r) => longtable.listen(0, r));
const url = `http://127.0.0.1:${longtable.address().port}`;
const server = resolve(fileURLToPath(new URL("../../packages/connect/src/approve-server.mjs", import.meta.url)));

async function exchange(tool, input, extra = {}) {
  const child = spawn(process.execPath, [server], { env: { ...process.env, LT_SUPABASE_URL: url, LT_KEY: "k", LT_JOB_KEY: "job-key", LT_ALWAYS: file, LT_POLL_MS: "50", LT_WAIT_MS: "3000", ...extra } });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const send = (m) => child.stdin.write(JSON.stringify(m) + NL);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "approve", arguments: { tool_name: tool, input } } });
  for (let i = 0; i < 100 && !out.includes('"id":2'); i++) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  const line = out.split(NL).find((l) => l.includes('"id":2'));
  return JSON.parse(JSON.parse(line).result.content[0].text);
}

writeFileSync(file, "[]");
const yes = await exchange("Bash", { command: "npm test", description: "Run the unit tests" });
check("the person is asked with the job's own key, never the device token", asked?.key === "job-key" && asked?.summary === "npm test" && !("token" in asked), asked);
check("and told in one plain line why, in the words Claude wrote for it", asked?.why === "Run the unit tests", asked);
check("an allow lets it run, as asked", yes.behavior === "allow" && yes.updatedInput?.command === "npm test", yes);
check("an always allow is kept on this computer as that one command", JSON.stringify(JSON.parse(readFileSync(file, "utf8"))) === JSON.stringify(["Bash(npm test)"]));
answer = "denied";
const no = await exchange("Bash", { command: "rm -rf build" });
check("a no stops it, and says not to try another way", no.behavior === "deny" && /another way/.test(no.message), no);
answer = "expired";
const late = await exchange("Bash", { command: "npm run build" });
check("a request whose job ended is a no", late.behavior === "deny", late);
answer = "gone";
// With no limit at all (as it runs for real), it still stops at once when the job is gone.
const goneAt = Date.now();
const gone = await exchange("Bash", { command: "npm run lint" }, { LT_WAIT_MS: "" });
check("when the job has ended and its key with it, it stops waiting at once and says no", gone.behavior === "deny" && /ended before/.test(gone.message) && Date.now() - goneAt < 2500, { gone, ms: Date.now() - goneAt });
answer = "allowed";
await exchange("Write", { file_path: "C:\\x\\src\\booking.tsx", content: "x" });
check("a file it would change is named as the reason", asked?.why === "Change booking.tsx", asked);
await exchange("mcp__tracker__create_issue", { title: "x", description: "Run the tests" });
check("another tool's description field is never shown as the reason", asked?.why === null, asked);
const long = await exchange("Bash", { command: "y".repeat(SHOW_MAX + 50) });
check("a request too long to show is refused without asking", long.behavior === "deny" && /too long/.test(long.message), long);
longtable.close();

console.log(JSON.stringify({ checks: results }, null, 2));
const failed = Object.values(results).filter((v) => v !== "pass").length;
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
