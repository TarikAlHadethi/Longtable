// A pack of the code for an AI that is given no tools.
//
// Claude Code answers by opening files itself, locked to reading. Codex cannot be locked that way on every computer
// (on Windows its read-only mode refuses every command), so a team member's ChatGPT gets no tools at all: the
// connection picks the files most related to the question out of the clean copy and hands them over as text.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

// The folder laid beside the code for a person's own Claude holds what is theirs alone (their instructions, memory
// and recent conversation). It stays in the copy between jobs, so it is never part of a pack.
const SKIP_DIRS = new Set([".git", ".longtable-yours", "node_modules", "dist", "build", "out", "target", ".next", ".turbo", "vendor", "coverage", "__pycache__", ".venv", "venv"]);
const SKIP_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".pdf", ".zip", ".gz", ".tar", ".woff", ".woff2", ".ttf", ".otf",
  ".mp3", ".mp4", ".mov", ".wav", ".exe", ".dll", ".so", ".dylib", ".bin", ".lock", ".map", ".onnx", ".wasm", ".jar", ".class", ".pyc"]);
const SKIP_NAMES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock"]);
const STOP = new Set(("the and for that this with from have does what when where which will would could should about into your our their there " +
  "how why who are was were can any all not but you they them then than its it's has had did use used using get make take long much many " +
  "project code file files table team client please tell know need want").split(" "));
const MAX_FILE = 200 * 1024;

function walk(dir, base = "", out = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && out.length < 6000) walk(join(dir, e.name), rel, out);
    } else if (e.isFile() && !SKIP_EXT.has(extname(e.name).toLowerCase()) && !SKIP_NAMES.has(e.name) && !/\.min\.(js|css)$/.test(e.name)) {
      out.push(rel);
    }
  }
  return out;
}

export function keywords(text) {
  const words = String(text || "").toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) || [];
  const split = words.flatMap((w) => [w, ...w.split("_")]).filter((w) => w.length >= 3 && !STOP.has(w));
  return [...new Set(split)].slice(0, 40);
}

// The pack: the list of files, then the text of the ones that matter most for `about`, inside a budget.
// Returns the text and the paths it carried, so sources can be checked against them.
export function packCode(dir, about, { budget = 110000, perFile = 16000 } = {}) {
  const paths = walk(dir);
  if (!paths.length) return { text: "There is no code in the connection's copy of the project.", files: [] };
  const keys = keywords(about);
  const scored = [];
  for (const p of paths) {
    let size = 0;
    try { size = statSync(join(dir, p)).size; } catch { continue; }
    if (size > MAX_FILE || size === 0) continue;
    let body = "";
    try { body = readFileSync(join(dir, p), "utf8"); } catch { continue; }
    if (body.includes("\u0000")) continue;
    const low = body.toLowerCase();
    const lowPath = p.toLowerCase();
    let score = 0;
    for (const k of keys) {
      if (lowPath.includes(k)) score += 8;
      let hits = 0;
      for (let i = low.indexOf(k); i >= 0 && hits < 6; i = low.indexOf(k, i + k.length)) hits++;
      score += hits;
    }
    // What says what the project is always helps a little.
    if (/^readme(\.|$)/i.test(p) || /^(package\.json|pyproject\.toml|cargo\.toml|go\.mod)$/i.test(p)) score += 6;
    if (p.split("/").length <= 2) score += 1;
    if (/(^|\/)(test|tests|__tests__|fixtures?)\//i.test(p)) score -= 2;
    scored.push({ p, body, score });
  }
  scored.sort((a, b) => b.score - a.score || a.p.length - b.p.length);
  const tree = paths.slice(0, 500).join("\n") + (paths.length > 500 ? `\n… and ${paths.length - 500} more files` : "");
  let left = budget - tree.length;
  const parts = [];
  const files = [];
  for (const f of scored) {
    if (left < 1500 || files.length >= 28) break;
    if (f.score <= 0 && files.length >= 6) break;
    const cut = f.body.length > Math.min(perFile, left) ? `${f.body.slice(0, Math.min(perFile, left))}\n… (cut here)` : f.body;
    parts.push(`=== ${f.p} ===\n${cut}`);
    files.push(f.p);
    left -= cut.length + f.p.length + 10;
  }
  return {
    text: `Every file in the project:\n${tree}\n\nThe files most related to the question, in full unless marked cut:\n\n${parts.join("\n\n")}`,
    files,
  };
}
