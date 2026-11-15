// What a person's own Claude knows and keeps on their own computer, laid beside a job for it.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileFolder, neverCommit, safeTable } from "./repo.mjs";
import { tableSessionIds } from "./sessions.mjs";
import { claudeHome } from "./extras.mjs";
import { cut, hideSecrets, home, log, trip, writeWhole } from "./store.mjs";

const NL = String.fromCharCode(10);

// What this person's Claude already knows on their own computer: their standing instructions, the project's
// instructions in their folder, and the memory their Claude keeps for this project. Read fresh for every job, so it
// is as up to date as their own Claude is. It goes to their own AI on their own plan, and nowhere else.
export function knows(seat, { talkOnly = false } = {}) {
  if (seat.kind !== "claude") return "";
  if (talkOnly) {
    const folder = seat.folder || fileFolder(seat.source);
    let talk = "";
    if (folder) { try { talk = recentSession(folder, 16000); } catch (e) { log(`their recent conversation could not be read: ${e.message}`); } }
    return talk ? `## The latest of your own conversation with them about this project (newest last)${NL}${talk}` : "";
  }
  const parts = [];
  const add = (label, file, cap) => {
    try {
      const t = hideSecrets(readFileSync(file, "utf8")).trim();
      if (t) parts.push(`## ${label}${NL}${t.length > cap ? t.slice(0, cap) + NL + "[cut short here]" : t}`);
    } catch {}
  };
  const folder = seat.folder || fileFolder(seat.source);
  add("Your person's standing instructions", join(claudeHome(), "CLAUDE.md"), 4000);
  if (folder) {
    add("This project's instructions in their folder", join(folder, "CLAUDE.md"), 12000);
    add("This project's instructions in their folder (.claude)", join(folder, ".claude", "CLAUDE.md"), 6000);
    add("Their own notes for this project", join(folder, "CLAUDE.local.md"), 4000);
    const memory = join(claudeHome(), "projects", resolve(folder).replace(/[^a-zA-Z0-9]/g, "-"), "memory");
    add("Your memory for this project: the index", join(memory, "MEMORY.md"), 6000);
    try {
      const files = readdirSync(memory).filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
        .map((f) => ({ f, at: statSync(join(memory, f)).mtimeMs })).sort((a, b) => b.at - a.at).slice(0, 12);
      for (const { f } of files) add(`Your memory: ${f}`, join(memory, f), 1200);
    } catch {}
  }
  // The end of their own conversation about this project comes first: it is what the two of them were just doing.
  let talk = "";
  if (folder) { try { talk = recentSession(folder, 16000); } catch (e) { log(`their recent conversation could not be read: ${e.message}`); } }
  // The rest has what room the conversation leaves, so the whole stays within 36,000 characters.
  const head = talk ? `## The latest of your own conversation with them about this project (newest last)${NL}${talk}${NL}${NL}` : "";
  const out = head + parts.join(NL + NL).slice(0, Math.max(0, 36000 - head.length));
  if (out.length > 36000) trip("what a person's Claude knows came out over its 36,000 characters");
  return out;
}

// Everything this person's Claude knows on their own computer, whole, laid in a folder beside the code for it to
// read when a question needs it: their instructions in full (the summary above is cut to size), every memory file,
// and the latest of their own conversation with their Claude about this project. That last part is what makes it
// the same Claude: what the two of them were just doing, said in their own words. It is read on their computer, by
// their own AI, on their own plan, and it is never committed and never sent to Longtable.
export const YOURS = ".longtable-yours";
function said(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join(NL);
}
// Where Claude Code keeps the sessions it ran in a folder.
const sessionsDir = (folder) => join(claudeHome(), "projects", resolve(folder).replace(/[^a-zA-Z0-9]/g, "-"));
// The kinds of job that are a person's own request to their own AI, and so carry on the chat's session.
export const SESSION_KINDS = new Set(["look", "work", "answer", "plan"]);
// A session can only be picked up while Claude Code still has it (the person may have cleared it).
export const sessionOnDisk = (folder, id) => { try { return statSync(join(sessionsDir(folder), `${id}.jsonl`)).isFile(); } catch { return false; } };
// The person's own Claude Code sessions in this folder (never a table's), each with its size, to tell afterwards whether
// one was written to while a run worked.
export function folderSessions(folder) {
  const tables = tableSessionIds();
  const out = new Map();
  try { for (const f of readdirSync(sessionsDir(folder))) if (f.endsWith(".jsonl") && !tables.has(f.slice(0, -6))) out.set(f, statSync(join(sessionsDir(folder), f)).size); } catch {}
  return out;
}
export const sessionsGrew = (before, folder) => !!before && [...folderSessions(folder)].some(([f, size]) => before.get(f) !== size);

// Whether one of the person's own Claude Code sessions (not a table's) was at work in this folder in the last two
// minutes: then two Claudes are changing the same files, which is worth saying, not stopping.
export function folderBusy(folder, withinMs = 120000) {
  const tables = tableSessionIds();
  try {
    return readdirSync(sessionsDir(folder)).some((f) => f.endsWith(".jsonl") && !tables.has(f.slice(0, -6))
      && Date.now() - statSync(join(sessionsDir(folder), f)).mtimeMs < withinMs);
  } catch { return false; }
}

export function recentSession(folder, room = 90000) {
  const dir = sessionsDir(folder);
  // A table's own sessions are not the person's conversation with their Claude.
  const tables = tableSessionIds();
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !tables.has(f.slice(0, -6))).map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs, size: statSync(join(dir, f)).size })).sort((a, b) => b.at - a.at).slice(0, 3); } catch { return ""; }
  const turns = [];
  let used = 0;
  for (const { f, size } of files) {
    let text = "";
    try {
      // Only the end of a long conversation is read: the newest part is what matters, and a session can be very large.
      const fd = openSync(join(dir, f), "r");
      const take = Math.min(size, 6 * 1024 * 1024);
      const buf = Buffer.alloc(take);
      readSync(fd, buf, 0, take, size - take);
      closeSync(fd);
      text = buf.toString("utf8");
    } catch { continue; }
    const lines = text.split(NL);
    const mine = [];
    for (let i = lines.length - 1; i >= 0 && used < room; i--) {
      let e;
      try { e = JSON.parse(lines[i]); } catch { continue; }
      // A line that is valid JSON but not a turn ("null", left by a crash) is skipped, not allowed to stop the rest.
      if (!e || typeof e !== "object") continue;
      if (e.isSidechain || (e.type !== "user" && e.type !== "assistant")) continue;
      const words = said(e.message?.content).trim();
      // Reminders the app adds to a message are not something either of them said.
      if (!words || /^<(system-reminder|command-|local-command)/.test(words)) continue;
      const line = `${e.type === "user" ? "They said" : "You said"}: ${words.length > 4000 ? words.slice(0, 4000) + " […]" : words}`;
      // Within its room: the line that would go over it is left out (the newest always comes), so what follows it in
      // what their Claude knows keeps its share.
      if (used + line.length > room && turns.length + mine.length) { used = room; break; }
      used += line.length;
      mine.unshift(line);
    }
    turns.unshift(...mine);
    if (used >= room) break;
  }
  return hideSecrets(turns.join(NL + NL));
}
// Where a handout's HTML is left for this job to open when it needs it: beside the attachments, never committed. Named
// by its path inside the working folder, or whole when it sits beside their own folder.
export function handoutPlace(seat, folder, handed, dir) {
  return {
    write(name, text) {
      if (seat.source && !folder) neverCommit(seat.table_id, YOURS);
      const at = join(handed, YOURS, "handouts");
      mkdirSync(at, { recursive: true });
      writeFileSync(join(at, name), text);
      const file = join(at, name);
      const rel = relative(dir, file);
      return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(/[\\/]/).join("/") : file;
    },
  };
}
export function layYours(seat, dir) {
  if (seat.kind !== "claude") return false;
  const folder = seat.folder || fileFolder(seat.source);
  const dest = join(dir, YOURS);
  let any = false;
  try {
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(join(dest, "memory"), { recursive: true });
    const put = (from, to) => {
      try {
        if (statSync(from).size > 1024 * 1024) return;
        const t = hideSecrets(readFileSync(from, "utf8"));
        if (t.trim()) { writeFileSync(join(dest, to), t); any = true; }
      } catch {}
    };
    put(join(claudeHome(), "CLAUDE.md"), "their-standing-instructions.md");
    if (folder) {
      put(join(folder, "CLAUDE.md"), "project-instructions.md");
      put(join(folder, ".claude", "CLAUDE.md"), "project-instructions-2.md");
      put(join(folder, "CLAUDE.local.md"), "their-project-notes.md");
      const memory = join(claudeHome(), "projects", resolve(folder).replace(/[^a-zA-Z0-9]/g, "-"), "memory");
      try { for (const f of readdirSync(memory).filter((x) => x.endsWith(".md")).slice(0, 200)) put(join(memory, f), join("memory", f.replace(/[^A-Za-z0-9._-]/g, "_"))); } catch {}
      const talk = recentSession(folder);
      if (talk) { writeFileSync(join(dest, "recent-conversation.md"), talk); any = true; }
    }
    if (!any) rmSync(dest, { recursive: true, force: true });
  } catch {
    return false;
  }
  return any;
}

// Each person's AI keeps its own short notes on that person's computer. They are what makes one person's AI differ
// from another's on the same model: what it has learned here, in its own words. They never leave this computer.
const mindFile = (tableId) => join(home, "minds", `${safeTable(tableId)}.md`);
export function mind(tableId) {
  try { return readFileSync(mindFile(tableId), "utf8").trim(); } catch { return ""; }
}
export function remember(tableId, text) {
  const line = cut(hideSecrets(String(text || "")).replace(/\s+/g, " ").trim(), 300);
  if (line.length < 12) return;
  mkdirSync(join(home, "minds"), { recursive: true });
  const kept = mind(tableId).split(NL).filter(Boolean).slice(-39);
  writeWhole(mindFile(tableId), [...kept, `- ${new Date().toISOString().slice(0, 10)}: ${line}`].join(NL) + NL);
}

// Keep only sources that are real files inside the copy, written relative to it.
export function cleanSources(dir, sources) {
  const out = [];
  for (const s of sources || []) {
    if (typeof s !== "string" || !s.trim()) continue;
    let p = s.trim().replace(/^\.\//, "");
    if (isAbsolute(p)) p = relative(dir, p);
    p = normalize(p).replace(/\\/g, "/");
    // On Windows and macOS ".LONGTABLE-YOURS" is the same folder, so the person's own is matched in any letter case.
    if (p.startsWith("..") || isAbsolute(p) || p.toLowerCase().startsWith(YOURS)) continue;
    if (existsSync(join(dir, p)) && !out.includes(p)) out.push(p);
  }
  return out.slice(0, 6);
}

