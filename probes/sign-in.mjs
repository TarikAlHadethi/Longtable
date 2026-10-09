// Probe (b2): give the background connection its own Claude sign-in.
//
// Claude Desktop keeps its sign-in to itself, so a background Claude needs one of its own.
// `claude setup-token` is Anthropic's documented way for scripts: it opens the browser, the person
// approves, and a one-year token prints. This catches that token, saves it encrypted on this computer,
// and never prints it. Nothing is sent anywhere.
//
//   node probes/sign-in.mjs

import { spawn } from "node:child_process";
import { findClaude, saveToken, childEnv, redact } from "./lib.mjs";

const claude = findClaude();
if (!claude) {
  console.error("Claude Code was not found on this computer.");
  process.exit(2);
}

console.log("Opening Claude's sign-in in your browser. Approve it there; this window never shows the token.");
const child = spawn(claude, ["setup-token"], { env: childEnv(null), stdio: ["inherit", "pipe", "pipe"], windowsHide: false });
let out = "";
child.stdout.on("data", (d) => {
  out += d;
  process.stdout.write(redact(d.toString()));
});
child.stderr.on("data", (d) => process.stderr.write(redact(d.toString())));
child.on("close", (code) => {
  const match = out.match(/sk-ant-oat\d{2}-[A-Za-z0-9_-]+/);
  if (!match) {
    console.error(`\nNo token came back (exit ${code}). Nothing was saved.`);
    process.exit(1);
  }
  saveToken(match[0]);
  console.log(`\nSaved. The background connection can now sign in on its own (token of ${match[0].length} characters, never shown).`);
});
