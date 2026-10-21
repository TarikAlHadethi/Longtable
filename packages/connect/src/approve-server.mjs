#!/usr/bin/env node
// The permission prompts of a person's full Claude Code at the table, brought to them in Longtable. Claude Code starts
// this as an MCP server and calls its one tool, "approve", whenever it wants to do something the person's own rules
// do not already allow (--permission-prompt-tool). The request goes to Longtable; the person allows or denies it on
// their own screen; the answer comes back here and decides. Nobody else at the table can answer. It waits for them as
// Claude Code at home does, for as long as the job runs; when the job ends (stopped, finished, its computer gone), the
// request ends with it.
//
// It is given, through its environment: Longtable's address and public key, a key for this one job (never the
// connection's device token: a key that can only ask about this job, and dies when it ends), and the file where this
// person's "always allow" answers are kept on this computer.

import { readFileSync, realpathSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, delimiter, dirname, extname, resolve, sep } from "node:path";
import { refused } from "./pointed.mjs";
import { client } from "./api.mjs";

const NL = String.fromCharCode(10);
const rpc = client({ supabaseUrl: process.env.LT_SUPABASE_URL, publishableKey: process.env.LT_KEY });
const key = process.env.LT_JOB_KEY;
const alwaysFile = process.env.LT_ALWAYS;
// No limit unless a test sets one.
const WAIT_MS = Number(process.env.LT_WAIT_MS || 0);
const POLL_MS = Number(process.env.LT_POLL_MS || 1500);

// What the person is asked: exactly what would be done. A command is shown whole; any other tool shows its whole
// input. Nothing is ever cut short: a request too long to show in full is refused instead (null).
export const SHOW_MAX = 2000;
// The tools that run a command: Bash, and on Windows Claude Code's PowerShell. Each is shown, explained and remembered alike.
export const SHELLS = ["Bash", "PowerShell"];
export function describe(tool, input) {
  const i = input && typeof input === "object" ? input : {};
  let text = "";
  if (SHELLS.includes(tool)) {
    // The command, and anything else it asks for that changes what it may do: never hidden behind the command.
    text = String(i.command || "");
    if (i.dangerouslyDisableSandbox) text += "\n(outside the sandbox)";
    if (i.run_in_background) text += "\n(keeps running in the background)";
  }
  else { try { text = JSON.stringify(i, null, 1); } catch { text = ""; } }
  return text.length > SHOW_MAX ? null : text;
}

// Why it is wanted, in one plain line, so a person who reads no commands can still answer: what Claude Code wrote for
// the command, or the file it would change.
export function whyOf(tool, input) {
  const i = input && typeof input === "object" ? input : {};
  // Only a command's own description: another tool's "description" field is what it would write, not why.
  const said = SHELLS.includes(tool) && typeof i.description === "string" ? i.description.replace(/\s+/g, " ").trim() : "";
  if (said) return said.slice(0, 1000);
  const file = String(i.file_path || i.notebook_path || "").split(/[\\/]/).pop();
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool) && file) return `Change ${file}`;
  return null;
}

// The rule an "always allow" answer adds: one command, exactly as it was asked for, and nothing broader. Never a
// whole tool, and never a command Claude Code could read as a pattern or that chains other commands.
const PLAIN = /^[^*()\r\n;&|`$<>]{1,500}$/;
export function ruleFor(tool, input) {
  const command = String(input?.command || "").trim();
  // Not for a command that asks to leave the sandbox or keep running: those are asked about every time.
  if (input?.dangerouslyDisableSandbox || input?.run_in_background) return null;
  return SHELLS.includes(tool) && PLAIN.test(command) ? `${tool}(${command})` : null;
}

// The rules kept on this computer, checked every time they are read: anything that is not one plain command is
// dropped, so nothing written into the file by anyone else can widen what runs unasked.
export function alwaysRules(file) {
  try {
    const list = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(list) ? list.filter((r) => typeof r === "string" && /^(Bash|PowerShell)\(.+\)$/.test(r) && PLAIN.test(r.slice(r.indexOf("(") + 1, -1))) : [];
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
    id = await rpc("runner_ask_approval", { key, tool, summary, why: whyOf(tool, input) });
  } catch (e) {
    return { behavior: "deny", message: `Longtable could not ask the person (${e.message}), so this was not done.` };
  }
  for (const end = WAIT_MS ? Date.now() + WAIT_MS : Infinity; Date.now() < end;) {
    await sleep(POLL_MS);
    let r;
    try { r = await rpc("runner_approval", { key, a: id }); } catch (e) {
      // The job ended and its key with it: nobody will answer now.
      if (/not for a running job|no such request/i.test(e.message)) break;
      continue;
    }
    if (r?.status === "allowed") {
      if (r.always) remember(ruleFor(tool, input));
      return { behavior: "allow", updatedInput: input };
    }
    if (r?.status === "denied") return { behavior: "deny", message: "The person said no to this in Longtable. Do not try it another way; say what you would have done instead." };
    if (r?.status === "expired") break;
  }
  return { behavior: "deny", message: "This work ended before the person answered in Longtable, so it was not done. Say what you would have done, and the person can ask again." };
}

// A question with choices for the person, as Claude Code's own question tool asks at home: a card in Longtable with a
// button for each choice and room for their own words. It waits for them as long as the job runs.
const ASK_ABOUT = "Ask your person a question with choices, the way you would at home: they see it in Longtable as a card with a button for each choice, and can answer in their own words. It waits for their answer. Use it when you need their decision to go on.";
async function askPerson(question, options) {
  const opts = (Array.isArray(options) ? options : []).map((o) => ({ label: String(o?.label ?? "").slice(0, 400), about: String(o?.description ?? o?.about ?? "").slice(0, 1000) }));
  let id;
  try { id = await rpc("runner_ask_question", { key, question: String(question ?? "").slice(0, 4000), options: opts }); }
  catch (e) { return `Longtable could not ask the person (${e.message}). Carry on with the safest choice and say which you took.`; }
  for (const end = WAIT_MS ? Date.now() + WAIT_MS : Infinity; Date.now() < end;) {
    await sleep(POLL_MS);
    let r;
    try { r = await rpc("runner_approval", { key, a: id }); } catch (e) {
      if (/not for a running job|no such request/i.test(e.message)) break;
      continue;
    }
    if (r?.status === "allowed" && r.answer) return `They answered: ${r.answer}`;
    if (r?.status && r.status !== "waiting") break;
  }
  return "This work ended before the person answered. Say what you would have needed to know.";
}

// A file or picture for its answer, as Claude in the app can send one: uploaded into the table's attachments (only into
// this job's own place) and shown on the answer. Never a secret file Longtable would refuse to open, never a folder,
// never over 15 MB.
const SHARE_ABOUT = "Put a file or a picture into your answer, the way you would send one in the Claude app: a screenshot you took, a spreadsheet or report you made. Give its path; it shows on your answer in Longtable for the team. Never keys or secret files.";
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".csv": "text/csv", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".html": "text/html",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".zip": "application/zip" };
async function shareFile(path) {
  const where = resolve(String(path || ""));
  let st;
  try { st = statSync(where); } catch { return `There is no file at ${path}.`; }
  if (!st.isFile()) return "That is not a file: share one file at a time.";
  if (refused(where) || refused(realpathSync(where))) return "That file is one Longtable never shares (keys, passwords, sign-ins). Say so instead.";
  // Only from the folder it works in (never the person's own notes laid beside it) or a screenshot it took: anything
  // else on the computer is never put in front of the team by a tool that does not ask.
  const real = realpathSync(where);
  const fold = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  const roots = String(process.env.LT_SHARE_ROOTS || "").split(delimiter).filter(Boolean).map((r) => { try { return realpathSync(r); } catch { return resolve(r); } });
  if (!roots.some((r) => fold(real).startsWith(fold(r.endsWith(sep) ? r : r + sep))) || /[\\/]\.longtable-yours([\\/]|$)/.test(real)) {
    return "Only a file from the folder you work in, or a screenshot you took, can go on your answer. Say where the file is instead.";
  }
  if (st.size > 15 * 1024 * 1024) return "That file is over 15 MB, too big to put in the answer. Say where it is instead.";
  const name = basename(where).replace(/[^\w.\- ()]/g, "_").slice(0, 120) || "file";
  let prefix;
  try { prefix = await rpc("runner_upload_slot", { key }); } catch (e) { return `Longtable could not take the file (${e.message}). Say where it is instead.`; }
  const object = `${prefix}${randomUUID()}-${name}`;
  const res = await fetch(`${process.env.LT_SUPABASE_URL}/storage/v1/object/attachments/${object.split("/").map(encodeURIComponent).join("/")}`, {
    method: "POST", headers: { apikey: process.env.LT_KEY, "Content-Type": MIME[extname(name).toLowerCase()] || "application/octet-stream", "x-upsert": "false" },
    body: readFileSync(where),
  }).catch((e) => ({ ok: false, status: e.message }));
  if (!res.ok) return `The file could not be uploaded (${res.status}). Say where it is instead.`;
  try { await rpc("runner_attach", { key, path: object, name }); } catch (e) { return `The file was not kept (${e.message}). Say where it is instead.`; }
  return `${name} is on your answer: the team sees it there.`;
}

// The MCP side: JSON-RPC over stdin and stdout, one message a line.
function serve() {
  let buf = "";
  const send = (m) => process.stdout.write(JSON.stringify(m) + NL);
  process.stdin.setEncoding("utf8");
  // Claude Code gone (its pipe closed): nobody is left to answer for, so it stops instead of polling on.
  process.stdin.on("end", () => process.exit(0));
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
          inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, required: ["tool_name", "input"] } },
        { name: "ask", description: ASK_ABOUT,
          inputSchema: { type: "object", properties: { question: { type: "string", description: "The question, in plain words." },
            options: { type: "array", minItems: 2, maxItems: 6, items: { type: "object", properties: { label: { type: "string", description: "A short choice." }, description: { type: "string", description: "One line on what choosing it means." } }, required: ["label"] } } },
          required: ["question", "options"] } },
        { name: "share_file", description: SHARE_ABOUT,
          inputSchema: { type: "object", properties: { path: { type: "string", description: "The file's path." } }, required: ["path"] } }] });
      } else if (m.method === "tools/call" && m.params?.name === "share_file") {
        shareFile(m.params?.arguments?.path).then(
          (text) => reply({ content: [{ type: "text", text }] }),
          () => reply({ content: [{ type: "text", text: "The file could not be shared. Say where it is instead." }] }));
      } else if (m.method === "tools/call" && m.params?.name === "ask") {
        const a = m.params?.arguments || {};
        askPerson(a.question, a.options).then(
          (text) => reply({ content: [{ type: "text", text }] }),
          () => reply({ content: [{ type: "text", text: "Longtable could not ask the person. Carry on with the safest choice and say which you took." }] }));
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
