// The note-taker on the real model: a private chat set up to take notes, a real connection on this computer's saved
// Claude sign-in (Haiku). People talk; once they go quiet the AI keeps the chat's notes as one handout, writes
// nothing in the chat, and a later talk changes the same handout as a new version.
//
//   node --experimental-websocket tests/e2e/step47-notes-ai.mjs

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accessToken, launch, rest, rpc, sleep, startTable } from "./lib.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const bin = join(repoRoot, "packages", "connect", "bin", "longtable.mjs");
const run = Date.now().toString(36);
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 400)}`; };
const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
const savedSignIn = join(homedir(), ".longtable", "secrets", "claude-token.bin");
if (!existsSync(savedSignIn)) throw new Error("No saved Claude sign-in on this computer.");

const scratch = mkdtempSync(join(tmpdir(), "longtable-notes-"));
const project = join(scratch, "project");
mkdirSync(project);
writeFileSync(join(project, "README.md"), "# Clinic booking\n");
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project });
execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-q", "--allow-empty", "-m", "start"], { cwd: project });
const dir = join(scratch, "home");
mkdirSync(join(dir, "secrets"), { recursive: true });
copyFileSync(savedSignIn, join(dir, "secrets", "claude-token.bin"));
const env = { ...process.env, LONGTABLE_HOME: dir, LONGTABLE_MODEL: "haiku", LONGTABLE_NO_UPDATE: "1" };

const browser = await launch();
let runner = null;
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Notes", "Maya");
  const T = owner.tableId;
  const tok = await accessToken(owner.context);
  const code = (await rpc(tok, "start_pairing", { t: T, ai_kind: "claude" })).body;
  const r = spawnSync(process.execPath, [bin, "connect", code, "--app", "http://localhost:3000", "--repo", project, "--no-autostart", "--no-run"], { env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  runner = spawn(process.execPath, [bin, "run"], { env, stdio: "ignore", windowsHide: true });
  const mayaId = sql(`select id from public.members where table_id = '${T}' and display_name = 'Maya'`);
  // The Chat room, set up by its owner: just her, notes on, the AIs only reading.
  const room = sql(`select id from public.chats where table_id = '${T}' and name = 'Chat room'`);
  const set = await rpc(tok, "setup_chat", { c: room, chat_name: "Brainstorm", chat_about: "Ideas for reminders", who: "me", people: [], take_notes: true, ai_answers: "silent" });
  check("the owner sets the Chat room up to take notes", set.status < 300, set.body);
  for (const [ago, body] of [[150, "What if appointment reminders went out on WhatsApp instead of SMS?"], [120, "Clinics told us WhatsApp is cheaper and patients read it more."], [90, "Decided: we try WhatsApp first and keep SMS as the fallback."], [75, "Open question: do we need each patient's consent before the first WhatsApp message?"]]) {
    sql(`insert into public.messages (table_id, chat_id, member_id, body, created_at) values ('${T}', '${room}', '${mayaId}', '${body.replace(/'/g, "''")}', now() - interval '${ago} seconds')`);
  }
  const notesPage = async () => sql(`select coalesce(notes_page::text, '') from public.chats where id = '${room}'`);
  let page = "";
  for (let i = 0; i < 90 && !page; i++) { await sleep(2000); page = await notesPage(); }
  const html = page ? sql(`select html from public.page_versions where page_id = '${page}' order by n desc limit 1`) : "";
  check("once people are quiet, the AI keeps the chat's notes as a handout", !!page && /whatsapp/i.test(html) && /sms/i.test(html), html.slice(0, 300));
  check("the notes keep what was decided and what is still open", /decid/i.test(html) && /consent/i.test(html), html.slice(0, 600));
  check("and it writes nothing in the chat", sql(`select count(*) from public.messages where chat_id = '${room}' and by_ai`) === "0");
  check("the notes are hers to see", (await rest(tok, `pages?id=eq.${page}&select=title`)).body?.[0]?.title?.startsWith("Notes"), (await rest(tok, `pages?id=eq.${page}&select=title`)).body);

  // More is said: the same handout changes, as a new version.
  sql(`insert into public.messages (table_id, chat_id, member_id, body, created_at) values ('${T}', '${room}', '${mayaId}', 'Next step: Sam drafts the WhatsApp template by Friday.', now() - interval '70 seconds')`);
  sql(`update public.chats set noted_at = now() - interval '80 seconds' where id = '${room}'`);
  let version = "1";
  for (let i = 0; i < 90 && version === "1"; i++) { await sleep(2000); version = sql(`select version from public.pages where id = '${page}'`); }
  const html2 = sql(`select html from public.page_versions where page_id = '${page}' order by n desc limit 1`);
  check("a later talk changes the same handout as a new version", version === "2" && /template/i.test(html2) && /whatsapp/i.test(html2), { version, html: html2.slice(0, 300) });
} catch (e) {
  check("the run did not crash", false, e.stack || e.message);
} finally {
  if (runner) runner.kill();
  try { spawnSync(process.execPath, [bin, "disconnect"], { env }); } catch {}
  await browser.close();
  try { rmSync(scratch, { recursive: true, force: true }); } catch {}
}
console.log(JSON.stringify({ checks: results }, null, 2));
const failed = Object.values(results).filter((v) => v !== "pass").length;
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
