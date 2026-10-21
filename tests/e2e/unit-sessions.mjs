// One Claude Code session per chat for a person's own requests in their own folder: which session belongs to which
// chat, what of the chat it has already seen, one request at a time, and a table's sessions never read as the person's
// own conversation. No AI, no database.
//
//   node tests/e2e/unit-sessions.mjs

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "longtable-sessions-"));
process.env.LONGTABLE_HOME = join(scratch, "home");
process.env.LONGTABLE_CLAUDE_HOME = join(scratch, "claude");
mkdirSync(process.env.LONGTABLE_HOME, { recursive: true });
const S = await import("../../packages/connect/src/sessions.mjs");
const { recentSession, sessionOnDisk } = await import("../../packages/connect/src/run.mjs");

const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 400)}`; };
const T = "table-1";
const folder = join(scratch, "project");
mkdirSync(folder);
try {
  check("a chat with no session has none", S.sessionFor(T, "chat-a", folder) === null);
  const id = S.newSessionId();
  check("a new session is written down the moment it starts", S.tableSessionIds().has(id));

  const history = [
    { id: "m1", created_at: "2026-10-21T10:00:00Z", name: "Maya", body: "the login page is slow" },
    { id: "m2", created_at: "2026-10-21T10:01:00Z", name: "Sam", body: "only on phones I think" },
  ];
  S.remember(T, "chat-a", { id, folder, history, questionId: "q1", jobId: "j1" });
  const had = S.sessionFor(T, "chat-a", folder);
  check("the chat's session is found again in the same folder", had?.id === id, had);
  check("but never from another folder, where Claude Code would not have it", S.sessionFor(T, "chat-a", join(scratch, "elsewhere")) === null);
  check("and each chat has its own", S.sessionFor(T, "chat-b", folder) === null);

  // The next request: the chat now also holds her earlier request and the AI's own answer, and new messages.
  const later = [
    ...history,
    { id: "q1", created_at: "2026-10-21T10:02:00Z", name: "Maya", body: "yes" },
    { id: "a1", job_id: "j1", created_at: "2026-10-21T10:03:00Z", name: "Maya", by_ai: true, body: "It loads every booking first." },
    { id: "m3", created_at: "2026-10-21T10:04:00Z", name: "Sam", body: "yes" },
    { id: "a2", job_id: "j-sam", created_at: "2026-10-21T10:05:00Z", name: "Sam", by_ai: true, body: "Sam's AI: the logo is a 1x png." },
  ];
  const fresh = S.unseen(later, had);
  check("a session is sent only what it has not seen: not the old talk, not its own request or answer", JSON.stringify(fresh.map((m) => m.id))
    === JSON.stringify(["m3", "a2"]), fresh.map((m) => m.id));
  check("a teammate saying the same words as her earlier request is still sent", fresh.some((m) => m.id === "m3" && m.body === "yes"));
  check("with no session, everything is new", S.unseen(later, null).length === later.length);

  S.remember(T, "chat-a", { id, folder, history: later, questionId: "q2", jobId: "j2" });
  const after = S.sessionFor(T, "chat-a", folder);
  check("each request moves what it has seen forward", after.lastAt === "2026-10-21T10:05:00Z" && after.asked.length === 2 && after.jobs.length === 2, after);

  check("one request at a time in a session", S.takeSession(T, "chat-a") === true && S.takeSession(T, "chat-a") === false && S.takeSession(T, "chat-b") === true);
  S.giveBackSession(T, "chat-a");
  check("and it is free again when that request ends", S.takeSession(T, "chat-a") === true);

  S.forgetSession(T, "chat-a");
  check("a session that could not be picked up is forgotten for its chat", S.sessionFor(T, "chat-a", folder) === null);
  S.forgetTableSessions([T]);
  check("disconnecting forgets which chat had which session, but not that they were the table's", S.tableSessionIds().has(id));

  // The person's own recent conversation, read for "the same Claude", leaves the table's sessions out.
  const projectDir = join(process.env.LONGTABLE_CLAUDE_HOME, "projects", folder.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(projectDir, { recursive: true });
  const turn = (who, text) => JSON.stringify({ type: who, message: { content: [{ type: "text", text }] } });
  writeFileSync(join(projectDir, "mine.jsonl"), [turn("user", "MY-OWN-TALK about the booking page"), turn("assistant", "noted")].join("\n"));
  writeFileSync(join(projectDir, `${id}.jsonl`), [turn("user", "TABLE-TALK from Longtable"), turn("assistant", "ok")].join("\n"));
  const talk = recentSession(folder);
  check("a table's session is never read as the person's own conversation", talk.includes("MY-OWN-TALK") && !talk.includes("TABLE-TALK"), talk.slice(0, 300));
  check("a session is picked up only while Claude Code still has it", sessionOnDisk(folder, id) === true && sessionOnDisk(folder, "not-there") === false);
} catch (e) {
  check("the run did not crash", false, e.stack || String(e));
} finally {
  try { rmSync(scratch, { recursive: true, force: true }); } catch {}
}

const failed = Object.values(results).filter((v) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
