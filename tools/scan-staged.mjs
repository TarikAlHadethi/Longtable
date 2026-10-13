// Looks through what is about to be committed for anything shaped like a real key or password, for real .env
// files, and for the folders that must stay on this computer. Only the lines being added are read, so an old line
// never blocks a new commit. The pre-commit hook runs it; it needs nothing installed.
//
//   node tools/scan-staged.mjs             what is staged now (exit 1 when something is found)
//   node tools/scan-staged.mjs --history   every line ever added, in every commit (for a look before going public)
//
// A made-up key in a test is let through when its line says so: put the words "scan:fake" on that line.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const NL = String.fromCharCode(10);
const NUL = String.fromCharCode(0);
const FAKE = "scan:fake";

// Shapes that are a key whatever is around them.
const SHAPES = [
  ["an Anthropic key or Claude sign-in", /\bsk-ant-[A-Za-z0-9_-]{24,}/],
  ["an OpenAI key", /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{40,}/],
  ["a Supabase secret key", /\bsb_secret_[A-Za-z0-9_-]{20,}/],
  ["a Supabase access token", /\bsbp_[a-f0-9]{40}\b/],
  ["a signed token (JWT)", /\beyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{16,}/],
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/],
  ["an npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["a Resend key", /\bre_[A-Za-z0-9]{6,12}_[A-Za-z0-9]{20,}\b/],
  ["a Vercel token", /\bvercel_[A-Za-z0-9_-]{24,}/],
  ["an AWS key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["a Stripe key", /\b[sr]k_live_[A-Za-z0-9]{20,}/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{20,}/],
  ["a Google key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["a sign-in inside an address", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]{1,64}:[^\s:@/${}<>]{8,}@[a-z0-9.-]+/i],
];

// A name that says "secret" given a written-out value: `password = "..."` in code, or NAME=value in an env file.
const NAMED = /(?:pass(?:word|wd)?|secret|token|api[_-]?key|service[_-]?role(?:[_-]?key)?|auth|credential|dsn)[a-z0-9_]*["']?\s*[:=]\s*(?:"([^"]{12,})"|'([^']{12,})'|`([^`]{12,})`)/i;
const ENV_LINE = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*(?:PASS(?:WORD)?|SECRET|TOKEN|KEY|DSN|CREDENTIALS?))\s*=\s*["']?([^\s"'#]{12,})/;
const PLACEHOLDER = /example|placeholder|changeme|change[_-]me|your[_-]|xxxx|\.\.\.|<[^>]*>|\$\{|\$\(|process\.env|secrets\.|redacted|dummy|made[_-]?up|fake|test/i;

// A value somebody typed as a stand-in reads like words; a real one mixes letters and digits with no spaces.
export function looksReal(value) {
  if (!value || PLACEHOLDER.test(value)) return false;
  if (/\s/.test(value)) return false;
  if (!/^[A-Za-z0-9+/_.=:@~-]+$/.test(value)) return false;
  return /[a-z]/i.test(value) && /\d/.test(value) && new Set(value).size >= 10;
}

// What is wrong with one added line, or "".
export function lineTrouble(line) {
  if (line.includes(FAKE)) return "";
  for (const [what, shape] of SHAPES) if (shape.test(line)) return what;
  const named = NAMED.exec(line);
  if (named && looksReal(named[1] ?? named[2] ?? named[3])) return "a password or key written out";
  const env = ENV_LINE.exec(line);
  // The publishable key is made to be public: it is the one "KEY" that may be written down.
  if (env && !/PUBLISHABLE/.test(env[1]) && looksReal(env[2])) return "a password or key written out";
  return "";
}

// What is wrong with a path being committed at all, or "".
export function pathTrouble(path) {
  const parts = path.split("/");
  const name = parts[parts.length - 1];
  if (/^\.env(\..+)?$/.test(name) && !/^\.env\.(example|sample|template)$/.test(name)) return "a real .env file";
  if (name === "CLAUDE.md") return "local notes that never leave this computer";
  if (parts.includes(".claude")) return "Claude settings that never leave this computer";
  if (parts[0] === "sweep-notes" || parts[0] === "private") return "a folder that never leaves this computer";
  if (/\.(pem|p12|pfx|keystore)$/i.test(name) || /^id_(rsa|ed25519|ecdsa|dsa)$/.test(name)) return "a key file";
  return "";
}

// The found thing is never printed whole: the start is enough to find it by.
const shown = (line) => { const t = line.trim(); return t.length > 44 ? `${t.slice(0, 40)}...` : t.replace(/.{0,8}$/, "..."); };

// Reads a diff with no context lines and returns what is wrong in the lines it adds.
export function scanDiff(diff) {
  const found = [];
  let path = "", at = 0;
  for (const line of diff.split(NL)) {
    if (line.startsWith("+++ ")) { path = line.slice(4).replace(/^b\//, "").replace(/\r$/, ""); continue; }
    if (line.startsWith("@@")) { at = Number(/\+(\d+)/.exec(line)?.[1] ?? 0); continue; }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const trouble = path === "/dev/null" ? "" : lineTrouble(line.slice(1));
    if (trouble) found.push({ path, line: at, what: trouble, text: shown(line.slice(1)) });
    at++;
  }
  return found;
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });

function main() {
  const history = process.argv.includes("--history");
  const found = [];
  if (history) {
    found.push(...scanDiff(git("log", "--all", "-p", "-U0", "--no-color", "--no-ext-diff", "--format=")));
    for (const path of new Set(git("log", "--all", "--name-only", "--diff-filter=A", "--format=").split(NL).filter(Boolean))) {
      const trouble = pathTrouble(path);
      if (trouble) found.push({ path, line: 0, what: trouble, text: "" });
    }
  } else {
    for (const path of git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z").split(NUL).filter(Boolean)) {
      const trouble = pathTrouble(path);
      if (trouble) found.push({ path, line: 0, what: trouble, text: "" });
    }
    found.push(...scanDiff(git("diff", "--cached", "-U0", "--no-color", "--no-ext-diff", "--diff-filter=ACMR")));
  }
  if (!found.length) { console.log(history ? "Nothing key-shaped in the history." : "Nothing key-shaped is staged."); return 0; }
  console.log(history ? "Found in the history:" : "This commit is stopped. Staged for it:");
  for (const f of found) console.log(`  ${f.path}${f.line ? `:${f.line}` : ""}  ${f.what}${f.text ? `  ${f.text}` : ""}`);
  if (!history) {
    console.log("");
    console.log("Take it out of the commit (git restore --staged <file>), or, for a made-up key in a test, put the words");
    console.log(`${FAKE} on that line. If it is a real key, it has been on this disk in plain sight: replace it.`);
  }
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main());
