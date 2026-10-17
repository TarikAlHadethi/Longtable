// The repo's own standing rules, checked over every tracked file: no em dash anywhere, and nothing that must stay
// on this computer is ever tracked (local notes, Claude settings, drafts, real .env files). Fast, no network.
//
//   node tools/house-rules.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Written as a number so this file passes its own check.
const DASH = Buffer.from(String.fromCharCode(0x2014), "utf8");
const NUL = String.fromCharCode(0);

// What may never be tracked. A .env.example holds names only, so it is the one exception.
export function mustStayLocal(path) {
  const parts = path.split("/");
  const name = parts[parts.length - 1];
  if (name === "CLAUDE.md") return "local notes";
  if (parts.includes(".claude")) return "Claude settings";
  if (parts[0] === "sweep-notes") return "sweep notes";
  if (parts[0] === "private") return "private drafts";
  if (/^\.env(\..+)?$/.test(name) && !/^\.env\.(example|sample|template)$/.test(name)) return "a real .env file";
  return "";
}

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else { fail++; console.log(`FAIL ${name} ${JSON.stringify(detail ?? "")}`.slice(0, 900)); } };

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split(NUL).filter(Boolean);

const local = tracked.map((path) => [path, mustStayLocal(path)]).filter(([, why]) => why);
check("nothing that must stay on this computer is tracked", local.length === 0, local.map(([path, why]) => `${path} (${why})`));

const dashed = [];
for (const path of tracked) {
  let bytes;
  // A file deleted in the working folder but not yet staged is still listed: it has nothing to check.
  try { bytes = readFileSync(path); } catch (e) { if (e.code === "ENOENT" || e.code === "EISDIR") continue; throw e; }
  // A picture or a font is not words.
  if (bytes.subarray(0, 8000).includes(0)) continue;
  let at = bytes.indexOf(DASH);
  if (at < 0) continue;
  const line = bytes.subarray(0, at).toString("utf8").split(String.fromCharCode(10)).length;
  dashed.push(`${path}:${line}`);
}
check("no tracked file holds an em dash", dashed.length === 0, dashed.slice(0, 20));

// One menu for the whole product: a screen never shows the browser's own dropdown. Every
// choice goes through components/select.tsx (or the model picker), which keeps a hidden <select> of its own.
const plain = [];
for (const path of tracked) {
  if (!/^apps\/web\/.*\.tsx$/.test(path) || path === "apps/web/components/select.tsx") continue;
  let text;
  try { text = readFileSync(path, "utf8"); } catch { continue; }
  text.split(String.fromCharCode(10)).forEach((l, i) => { if (/<select[\s>]/.test(l)) plain.push(`${path}:${i + 1}`); });
}
check("every dropdown is the product's own menu, never the browser's", plain.length === 0, plain);

// No code-style typeface anywhere on the site: file names, branches and code are set in the product's own face.
const mono = [];
for (const path of tracked) {
  if (!/^apps\/web\/.*\.(css|tsx|ts|mjs)$/.test(path)) continue;
  let text;
  try { text = readFileSync(path, "utf8"); } catch { continue; }
  text.split(String.fromCharCode(10)).forEach((l, i) => { if (/monospace|--font-mono|Mono\b.*from "next\/font/i.test(l)) mono.push(`${path}:${i + 1}`); });
}
check("no code-style typeface anywhere on the site", mono.length === 0, mono);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
