// Chat rooms, against the database with stand-in connections: every table has a Chat room its owner sets up; a
// private chat is seen, written in and heard only by its people, live and in the log and the owner's download; every
// AI job of a private chat goes to the AI of someone in it; silent and named chats are heard as set; the note-taker
// keeps one handout of notes and writes nothing in the chat.
//
//   node --experimental-websocket tests/e2e/step46-chat-rooms.mjs

import { execFileSync } from "node:child_process";
import { accessToken, API, inviteLink, join as joinTable, KEY, launch, listen, rest, rpc, sleep, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 400)}`; };
const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
const first = (s) => s.split(/\r?\n/)[0];
const anon = async (fn, args) => {
  const res = await fetch(`${API}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
};
const ok = (r) => r.status < 300;
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(400); } return v; };

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Rooms", "Maya Stone");
  const T = owner.tableId;
  const sam = await joinTable(browser, await inviteLink(owner.page, "developer"), `sam-${run}@example.test`, "Sam Ali");
  const lee = await joinTable(browser, await inviteLink(owner.page, "developer"), `lee-${run}@example.test`, "Lee Park");
  const elena = await joinTable(browser, await inviteLink(owner.page, "client"), `elena-${run}@example.test`, "Elena");
  const tok = { maya: await accessToken(owner.context), sam: await accessToken(sam.context), lee: await accessToken(lee.context), elena: await accessToken(elena.context) };
  const id = (name) => sql(`select id from public.members where table_id = '${T}' and display_name = '${name}'`);
  const [mayaId, samId, leeId] = ["Maya Stone", "Sam Ali", "Lee Park"].map(id);
  const device = {};
  for (const [who, t] of [["maya", tok.maya], ["sam", tok.sam], ["lee", tok.lee]]) {
    const code = (await rpc(t, "start_pairing", { t: T, ai_kind: "claude" })).body;
    device[who] = (await anon("pair_connection", { code, device_label: "rooms" })).body.token;
    await anon("runner_hello", { token: device[who] });
  }
  sql(`update public.jobs set status = 'skipped' where table_id = '${T}' and kind = 'intro'`);
  const general = sql(`select id from public.chats where table_id = '${T}' and is_general`);

  // ---- every table has a Chat room, waiting for its owner
  const room = sql(`select id from public.chats where table_id = '${T}' and name = 'Chat room'`);
  check("a new table has General and a Chat room that is not set up yet", !!room && sql(`select set_up from public.chats where id = '${room}'`) === "f");
  const samWrites = await rest(tok.sam, "messages", { method: "POST", body: JSON.stringify({ table_id: T, chat_id: room, member_id: samId, body: "hello?" }) });
  const samAsks = await rpc(tok.sam, "ask_table", { c: room, body: "anyone?" });
  check("nobody writes or asks in it before it is set up", samWrites.status >= 400 && samAsks.status >= 400, { samWrites: samWrites.status, samAsks: samAsks.status });
  const samSetsUp = await rpc(tok.sam, "setup_chat", { c: room, chat_name: "Chat room", chat_about: "", who: "everyone", people: [], take_notes: false, ai_answers: "normal" });
  check("a developer cannot set up the table's own Chat room", samSetsUp.status >= 400, samSetsUp.body);

  // ---- the owner makes it hers alone
  const mine = await rpc(tok.maya, "setup_chat", { c: room, chat_name: "Ideas", chat_about: "Thinking out loud", who: "me", people: [], take_notes: false, ai_answers: "normal" });
  check("the owner sets it up as just hers", ok(mine) && sql(`select private::text || set_up::text || name from public.chats where id = '${room}'`) === "truetrueIdeas", mine.body);

  // Sam hears the team's channel while Maya writes in her room: he must never hear the words.
  const samHears = await listen(tok.sam, `team:${T}`);
  const samRoom = await listen(tok.sam, `room:${room}`);
  const mayaRoom = await listen(tok.maya, `room:${room}`);
  check("only the room's people may open its live channel", mayaRoom.status === "SUBSCRIBED" && samRoom.status !== "SUBSCRIBED", { maya: mayaRoom.status, sam: samRoom.status });
  const secret = `blueberry-${run}`;
  const wrote = await rest(tok.maya, "messages", { method: "POST", body: JSON.stringify({ table_id: T, chat_id: room, member_id: mayaId, body: `the plan is ${secret}` }) });
  await sleep(2500);
  check("she writes in her room", ok(wrote), wrote);
  check("the team's channel never carries what is said in a private room", !JSON.stringify(samHears.heard).includes(secret), samHears.heard.slice(0, 3));
  check("the room's channel carries it to her", JSON.stringify(mayaRoom.heard).includes(secret), mayaRoom.heard.length);
  await samHears.stop(); await samRoom.stop(); await mayaRoom.stop();

  const samReads = {
    chats: (await rest(tok.sam, `chats?id=eq.${room}&select=id`)).body.length,
    messages: (await rest(tok.sam, `messages?chat_id=eq.${room}&select=id`)).body.length,
    log: (await rest(tok.sam, `activity?table_id=eq.${T}&subject=eq.${room}&select=id`)).body.length,
  };
  check("a teammate outside the room reads nothing of it, not even in the log", samReads.chats === 0 && samReads.messages === 0 && samReads.log === 0, samReads);
  const samIn = {
    write: (await rest(tok.sam, "messages", { method: "POST", body: JSON.stringify({ table_id: T, chat_id: room, member_id: samId, body: "let me in" }) })).status,
    ask: (await rpc(tok.sam, "ask_table", { c: room, body: "what is the plan?" })).status,
    decide: (await rpc(tok.sam, "create_decision", { c: room, title: "x", context: "", origin: "", affects_client: false, options: [{ label: "a" }, { label: "b" }] })).status,
    rename: (await rpc(tok.sam, "rename_chat", { c: room, chat_name: "mine now" })).status,
  };
  check("nor writes, asks, polls or renames in it", Object.values(samIn).every((s) => s >= 400), samIn);
  check("a client never sees it", (await rest(tok.elena, `chats?id=eq.${room}&select=id`)).body.length === 0);
  const clientsThere = await rpc(tok.maya, "update_table", { t: T, table_name: "Rooms", undo: 10, requests_chat: room });
  check("clients' requests can never be sent to a private chat", clientsThere.status >= 400, clientsThere.body);

  // ---- people picked
  const some = await rpc(tok.maya, "setup_chat", { c: room, chat_name: "Ideas", chat_about: "", who: "some", people: [samId], take_notes: false, ai_answers: "normal" });
  check("she adds Sam: he reads it now, Lee still does not", ok(some) && (await rest(tok.sam, `messages?chat_id=eq.${room}&select=body`)).body.some((m) => m.body.includes(secret))
    && (await rest(tok.lee, `messages?chat_id=eq.${room}&select=id`)).body.length === 0, some.body);
  // A file attached in the room: Sam, in it, may fetch it; Lee, on the team but outside it, can neither list nor fetch it.
  const store = (t, path, init = {}) => fetch(`${API}/storage/v1/object/${path}`, { ...init, headers: { apikey: KEY, Authorization: `Bearer ${t}`, ...(init.headers || {}) } });
  const fpath = `${T}/${mayaId}/${crypto.randomUUID()}-plan.txt`;
  const up = await store(tok.maya, `attachments/${fpath}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: `secret plan ${secret}` });
  const signed = await (await store(tok.maya, `sign/attachments/${fpath}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 3600 }) })).json();
  const sent = await rpc(tok.maya, "send_with_files", { c: room, body: "the plan, attached", files: [{ path: fpath, name: "plan.txt", mime: "text/plain", size: 20, url: `${API}/storage/v1${signed.signedURL}` }] });
  const samGets = (await store(tok.sam, `authenticated/attachments/${fpath}`)).status;
  const leeGets = (await store(tok.lee, `authenticated/attachments/${fpath}`)).status;
  const leeLists = await (await store(tok.lee, "list/attachments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prefix: `${T}/${mayaId}`, limit: 100 }) })).json();
  check("a file attached in the room is the room's: its people fetch it, a teammate outside can neither list nor fetch it",
    up.ok && sent.status < 300 && samGets === 200 && leeGets >= 400 && Array.isArray(leeLists) && leeLists.length === 0, { up: up.status, sent: sent.status, samGets, leeGets, leeLists });

  // Someone inside who is not the maker changes who is in it: the maker always stays in their own room.
  const samRoom2 = (await rpc(tok.sam, "make_chat", { t: T, chat_name: "Sam and Maya", chat_about: "", who: "some", people: [mayaId], take_notes: false, ai_answers: "normal" })).body;
  await rpc(tok.maya, "setup_chat", { c: samRoom2, chat_name: "Sam and Maya", chat_about: "", who: "me", people: [], take_notes: false, ai_answers: "normal" });
  check("whoever sets a room up, its maker stays in it", (await rest(tok.sam, `chats?id=eq.${samRoom2}&select=id`)).body.length === 1);

  // Work queued for someone who is then left out of the room is taken from them.
  const openChat = (await rpc(tok.maya, "make_chat", { t: T, chat_name: "Open for now", chat_about: "", who: "everyone", people: [], take_notes: false, ai_answers: "normal" })).body;
  const q = first(sql(`insert into public.messages (table_id, chat_id, member_id, body) values ('${T}', '${openChat}', '${mayaId}', 'what about ${secret}?') returning id`));
  const leeJob = first(sql(`insert into public.jobs (table_id, chat_id, member_id, question_id, kind) values ('${T}', '${openChat}', '${leeId}', '${q}', 'look') returning id`));
  await rpc(tok.maya, "setup_chat", { c: openChat, chat_name: "Open for now", chat_about: "", who: "me", people: [], take_notes: false, ai_answers: "normal" });
  const after = sql(`select m.display_name || ':' || j.status from public.jobs j join public.members m on m.id = j.member_id where j.id = '${leeJob}'`);
  const leeClaims = [];
  for (const lane of ["heavy", "light"]) { const j = (await anon("runner_claim", { token: device.lee, lane })).body; if (j?.job_id) leeClaims.push(j); }
  check("work queued for someone left out of a room is taken from them, and their AI is never handed it", !after.startsWith("Lee Park:queued") && !JSON.stringify(leeClaims).includes(secret), { after, claimed: leeClaims.map((j) => j.chat_id === openChat) });

  const clientIn = await rpc(tok.maya, "setup_chat", { c: room, chat_name: "Ideas", chat_about: "", who: "some", people: [id("Elena")], take_notes: false, ai_answers: "normal" });
  check("a client can never be put in a chat", clientIn.status >= 400, clientIn.body);
  const generalPrivate = await rpc(tok.maya, "setup_chat", { c: general, chat_name: "General", chat_about: "", who: "me", people: [], take_notes: false, ai_answers: "normal" });
  check("General stays everyone's", generalPrivate.status >= 400, generalPrivate.body);

  // ---- a chat of Sam's own, made with +: even the owner is outside it
  const leeHears = await listen(tok.lee, `team:${T}`);
  const samsChat = await rpc(tok.sam, "make_chat", { t: T, chat_name: "Sam's corner", chat_about: "", who: "me", people: [], take_notes: false, ai_answers: "normal" });
  await sleep(2000);
  check("a private chat made with + never sends its name to the team's channel", !JSON.stringify(leeHears.heard).includes("Sam's corner"), leeHears.heard.slice(0, 3));
  await leeHears.stop();
  const corner = samsChat.body;
  check("Sam makes a chat of his own with +", ok(samsChat) && typeof corner === "string", samsChat.body);
  sql(`insert into public.messages (table_id, chat_id, member_id, body) values ('${T}', '${corner}', '${samId}', 'pineapple-${run} is the codename')`);
  const exp = (await rpc(tok.maya, "export_table", { t: T })).body;
  check("the owner neither reads it nor gets it in Download everything", (await rest(tok.maya, `chats?id=eq.${corner}&select=id`)).body.length === 0
    && !JSON.stringify(exp).includes(`pineapple-${run}`) && !JSON.stringify(exp).includes("Sam's corner"), Object.keys(exp ?? {}));
  const mayaSetsUp = await rpc(tok.maya, "setup_chat", { c: corner, chat_name: "Taken", chat_about: "", who: "everyone", people: [], take_notes: false, ai_answers: "normal" });
  check("and cannot change how it is set up from outside it", mayaSetsUp.status >= 400, mayaSetsUp.body);

  // ---- the AIs: a request in Sam's room goes only to Sam's AI, and other AIs never get its words
  const asked = await rpc(tok.sam, "ask_table", { c: corner, body: `is pineapple-${run} ready?` });
  check("Sam asks the table in his room", ok(asked), asked.body);
  const jobsThere = sql(`select string_agg(distinct m.display_name, ',') from public.jobs j join public.members m on m.id = j.member_id where j.chat_id = '${corner}'`);
  check("every job of his room is his AI's", jobsThere === "Sam Ali", jobsThere);
  const mayaClaims = [];
  for (let i = 0; i < 4; i++) for (const lane of ["heavy", "light"]) { const j = (await anon("runner_claim", { token: device.maya, lane })).body; if (j?.job_id) mayaClaims.push(j); }
  check("Maya's AI is given nothing from it", !JSON.stringify(mayaClaims).includes(`pineapple-${run}`), mayaClaims.map((j) => j.kind));
  // A question in General with the same words: the related messages Lee's AI gets for its view never come from Sam's room.
  for (const who of ["maya", "sam", "lee"]) await anon("runner_hello", { token: device[who] });
  const g = await rpc(tok.maya, "ask_table", { c: general, body: `pineapple-${run} codename status` });
  let gj = null;
  await until(async () => { const j = (await anon("runner_claim", { token: device.lee, lane: "light" })).body; if (j?.job_id && j.chat_id === general) { gj = j; return true; } return false; });
  check("an AI's related messages from other chats leave out rooms its person is not in", ok(g) && !!gj && !JSON.stringify(gj.related ?? []).includes(`pineapple-${run}`) && !(gj.tasks ?? []).some((t) => t.chat === "Sam's corner"), gj && { related: gj.related, tasks: gj.tasks });
  // Listening: Sam talks in his room; the one who listens is his AI, never the table's seat (Maya's).
  sql(`update public.jobs set status = 'skipped' where table_id = '${T}' and status in ('queued', 'running', 'waiting')`);
  await rest(tok.sam, "messages", { method: "POST", body: JSON.stringify({ table_id: T, chat_id: corner, member_id: samId, body: "Could you check whether the booking page loads fast enough on a phone?" }) });
  const listened = await until(() => sql(`select string_agg(m.display_name, ',') from public.jobs j join public.members m on m.id = j.member_id where j.chat_id = '${corner}' and j.kind = 'listen'`) || null, 20000);
  check("what is said in a private room is heard by an AI of someone in it", listened === "Sam Ali", listened);

  // Deleting a private room keeps its lines in the log hidden from everyone outside it.
  const gone = (await rpc(tok.sam, "make_chat", { t: T, chat_name: `Hidden-${run}`, chat_about: "", who: "me", people: [], take_notes: false, ai_answers: "normal" })).body;
  await rpc(tok.sam, "rename_chat", { c: gone, chat_name: `Hidden-${run}-b` });
  await rpc(tok.sam, "delete_chat", { c: gone });
  const leeLog = JSON.stringify((await rest(tok.lee, `activity?table_id=eq.${T}&select=action,details`)).body);
  check("a deleted private room's lines in the log stay hidden", !leeLog.includes(`Hidden-${run}`), leeLog.slice(0, 300));

  // ---- silent and named
  const quiet = (await rpc(tok.maya, "make_chat", { t: T, chat_name: "Quiet", chat_about: "", who: "everyone", people: [], take_notes: false, ai_answers: "silent" })).body;
  await rest(tok.maya, "messages", { method: "POST", body: JSON.stringify({ table_id: T, chat_id: quiet, member_id: mayaId, body: "Could someone explain how the reminder emails are sent out each night?" }) });
  const named = (await rpc(tok.maya, "make_chat", { t: T, chat_name: "Named", chat_about: "", who: "everyone", people: [], take_notes: false, ai_answers: "named" })).body;
  await rest(tok.maya, "messages", { method: "POST", body: JSON.stringify({ table_id: T, chat_id: named, member_id: mayaId, body: "How do the reminder emails get sent out each night, does anyone remember?" }) });
  await sleep(9000);
  check("a silent chat is never answered", sql(`select count(*) from public.jobs where chat_id = '${quiet}'`) === "0" && sql(`select count(*) from public.listens where chat_id = '${quiet}'`) === "0");
  check("a chat that answers when named stays quiet when no AI is named", sql(`select count(*) from public.jobs where chat_id = '${named}'`) === "0");
  await rest(tok.maya, "messages", { method: "POST", body: JSON.stringify({ table_id: T, chat_id: named, member_id: mayaId, body: "@claude how are the reminder emails sent?" }) });
  const heardNamed = await until(() => sql(`select count(*) from public.jobs where chat_id = '${named}' and kind = 'listen'`) !== "0", 20000);
  check("and is heard when someone names an AI", !!heardNamed);

  // ---- the note-taker
  const notesChat = (await rpc(tok.sam, "make_chat", { t: T, chat_name: "Brainstorm", chat_about: "", who: "some", people: [leeId], take_notes: true, ai_answers: "silent" })).body;
  sql(`update public.jobs set status = 'skipped' where table_id = '${T}' and status in ('queued', 'running', 'waiting')`);
  sql(`insert into public.messages (table_id, chat_id, member_id, body, created_at) values ('${T}', '${notesChat}', '${samId}', 'What if reminders went out by WhatsApp?', now() - interval '2 minutes'), ('${T}', '${notesChat}', '${leeId}', 'Cheaper than SMS, and clinics already use it.', now() - interval '90 seconds')`);
  await anon("runner_hello", { token: device.sam }); await anon("runner_hello", { token: device.lee }); await anon("runner_hello", { token: device.maya });
  const nj = await until(async () => { for (const who of ["sam", "lee", "maya"]) { const j = (await anon("runner_claim", { token: device[who], lane: "light" })).body; if (j?.job_id && j.kind === "notes") return { ...j, who }; } return null; }, 45000);
  check("a chat that takes notes gets a notes job on the AI of someone in it, the chat's maker first", nj?.who === "sam" && nj?.chat_id === notesChat, nj && { who: nj.who, kind: nj.kind });
  if (nj) {
    const made = await anon("runner_page", { token: device.sam, job: nj.job_id, page: { title: "Notes: Brainstorm", html: "<h1>Notes</h1><ul><li>WhatsApp reminders</li></ul>" } });
    const fin = await anon("runner_finish", { token: device.sam, job: nj.job_id, answer: "", info: {} });
    const notesPage = sql(`select notes_page from public.chats where id = '${notesChat}'`);
    check("its notes are a handout of the chat, and nothing is written in the chat", ok(made) && ok(fin) && notesPage === made.body
      && sql(`select count(*) from public.messages where chat_id = '${notesChat}' and by_ai`) === "0", { made, fin, notesPage });
    check("Maya, outside the room, does not see the notes", (await rest(tok.maya, `pages?id=eq.${made.body}&select=id`)).body.length === 0);
    // Something new said since the notes were taken (the clock moved back so the test need not wait out the quiet minute).
    sql(`update public.chats set noted_at = now() - interval '5 minutes' where id = '${notesChat}'`);
    sql(`insert into public.messages (table_id, chat_id, member_id, body, created_at) values ('${T}', '${notesChat}', '${leeId}', 'And email as a fallback.', now() - interval '70 seconds')`);
    const nj2 = await until(async () => { const j = (await anon("runner_claim", { token: device.sam, lane: "light" })).body; return j?.kind === "notes" ? j : null; }, 45000);
    const again = nj2 && await anon("runner_page", { token: device.sam, job: nj2.job_id, page: { title: "Notes: Brainstorm", html: "<h1>Notes</h1><ul><li>WhatsApp</li><li>Email fallback</li></ul>" } });
    if (nj2) await anon("runner_finish", { token: device.sam, job: nj2.job_id, answer: "", info: {} });
    check("the next notes change the same handout as a new version", !!again && again.body === made.body && sql(`select version from public.pages where id = '${made.body}'`) === "2", again);
  }
} catch (e) {
  check("the run did not crash", false, e.stack || e.message);
} finally {
  await browser.close();
}
console.log(JSON.stringify({ checks: results }, null, 2));
const failed = Object.values(results).filter((v) => v !== "pass").length;
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
