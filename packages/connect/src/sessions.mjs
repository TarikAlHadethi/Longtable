// One Claude Code session per chat for a person's own requests in their own folder, as at home: each request picks up
// where the last one left off (what it read, ran and found is still there), and Claude Code compacts it by itself when
// it fills up. Each person's sessions are their own, on their own computer: one person's filling up never touches
// another's. Kept here: which session belongs to which chat, and what of the chat that session has already seen, so a
// request sends only what is new.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { home, writeWhole } from "./store.mjs";

const dir = () => join(home, "sessions");
const STARTED = "started.list";
const fileFor = (table) => join(dir(), `${String(table).replace(/[^A-Za-z0-9_-]/g, "")}.json`);
const read = (table) => { try { const v = JSON.parse(readFileSync(fileFor(table), "utf8")); return v && typeof v === "object" ? v : {}; } catch { return {}; } };
const sameFolder = (a, b) => !!a && !!b && resolve(a).toLowerCase() === resolve(b).toLowerCase();

// A chat's session at this table, when it was started in this same folder (Claude Code keeps a session under the
// folder it ran in, so it can only be picked up from there).
export function sessionFor(table, chat, folder) {
  const s = read(table)[chat];
  return s && typeof s.id === "string" && sameFolder(s.folder, folder) ? s : null;
}

// A new session, written down before it runs: every session it ever started is kept, even after a disconnect or a
// failed first run, so none is read later as the person's own conversation.
export function newSessionId() {
  const id = randomUUID();
  let started = [];
  try { started = JSON.parse(readFileSync(join(dir(), STARTED), "utf8")); } catch {}
  mkdirSync(dir(), { recursive: true });
  writeWhole(join(dir(), STARTED), JSON.stringify([...(Array.isArray(started) ? started : []), id].slice(-2000)));
  return id;
}

// What of the chat this session has not seen: messages after the last one it was given, without the requests it was
// given and the answers it wrote (both already in the session), told apart by their ids, never by their words: a
// teammate's "yes" is not the person's earlier "yes".
export function unseen(history, s) {
  const asked = new Set(s?.asked || []);
  const jobs = new Set(s?.jobs || []);
  return (history || []).filter((m) => (!s?.lastAt || String(m.created_at) > String(s.lastAt))
    && !(m.id && asked.has(m.id)) && !(m.job_id && jobs.has(m.job_id)));
}

// After a request: the session, the newest message it has now seen, and what it was asked and answered.
export function remember(table, chat, { id, folder, history, questionId, jobId }) {
  const all = read(table);
  const was = all[chat]?.id === id ? all[chat] : {};
  const last = (history || []).reduce((at, m) => (String(m.created_at) > at ? String(m.created_at) : at), String(was.lastAt || ""));
  all[chat] = {
    id, folder, lastAt: last || null, at: Date.now(),
    asked: [...(was.asked || []), questionId].filter(Boolean).slice(-200),
    jobs: [...(was.jobs || []), jobId].filter(Boolean).slice(-200),
  };
  mkdirSync(dir(), { recursive: true });
  writeWhole(fileFor(table), JSON.stringify(all));
}

export function forgetSession(table, chat) {
  const all = read(table);
  if (!all[chat]) return;
  delete all[chat];
  writeWhole(fileFor(table), JSON.stringify(all));
}

// Every session id Longtable started on this computer, so reading the person's own recent conversation never mistakes
// a table's session for one of theirs.
export function tableSessionIds() {
  const ids = new Set();
  let files = [];
  try { for (const id of JSON.parse(readFileSync(join(dir(), STARTED), "utf8"))) ids.add(id); } catch {}
  try { files = readdirSync(dir()).filter((f) => f.endsWith(".json")); } catch { return ids; }
  for (const f of files) {
    try { for (const s of Object.values(JSON.parse(readFileSync(join(dir(), f), "utf8")))) if (s?.id) ids.add(s.id); } catch {}
  }
  return ids;
}

export function forgetTableSessions(tables) {
  for (const t of tables || []) rmSync(fileFor(t), { force: true });
}

// One request at a time in a session: a second one in the same chat while the first runs starts fresh instead.
const busy = new Set();
export function takeSession(table, chat) {
  const k = `${table}:${chat}`;
  if (busy.has(k)) return false;
  busy.add(k);
  return true;
}
export function giveBackSession(table, chat) { busy.delete(`${table}:${chat}`); }
