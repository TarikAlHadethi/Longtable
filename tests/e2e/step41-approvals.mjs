// A person's full Claude Code at the table, against the database with stand-in connections: the switch is theirs
// alone and off until they turn it on; their Claude's requests reach only them; only they answer; a job's key asks
// only about that job and dies with it; a request waits for its person for as long as its job runs.
//
//   node --experimental-websocket tests/e2e/step41-approvals.mjs

import { execFileSync } from "node:child_process";
import { accessToken, API, inviteLink, join as joinTable, KEY, launch, rest, rpc, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 400)}`; };
const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
const anon = async (fn, args) => {
  const res = await fetch(`${API}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
};

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Approvals", "Maya Stone");
  const { tableId } = owner;
  const sam = await joinTable(browser, await inviteLink(owner.page, "developer"), `sam-${run}@example.test`, "Sam Ali");
  const elena = await joinTable(browser, await inviteLink(owner.page, "client"), `elena-${run}@example.test`, "Elena");
  const tok = { maya: await accessToken(owner.context), sam: await accessToken(sam.context), elena: await accessToken(elena.context) };
  const device = {};
  for (const [who, t] of [["maya", tok.maya], ["sam", tok.sam]]) {
    const code = (await rpc(t, "start_pairing", { t: tableId, ai_kind: "claude" })).body;
    device[who] = (await anon("pair_connection", { code, device_label: "full" })).body.token;
  }
  sql(`update public.jobs set status = 'skipped' where table_id = '${tableId}' and kind = 'intro'`);
  const conn = Object.fromEntries(["maya", "sam"].map((w) => [w, sql(`select c.id from public.connections c join public.members m on m.id = c.member_id where c.table_id = '${tableId}' and m.display_name = '${w === "maya" ? "Maya Stone" : "Sam Ali"}' and c.revoked_at is null`)]));
  const mayaId = sql(`select id from public.members where table_id = '${tableId}' and display_name = 'Maya Stone'`);
  const chatId = sql(`select id from public.chats where table_id = '${tableId}' and is_general`);

  // A running job of Maya's, as the connection would have claimed it.
  const job = sql(`insert into public.jobs (table_id, member_id, kind, chat_id, status, started_at) values ('${tableId}', '${mayaId}', 'look', '${chatId}', 'running', now()) returning id`).split(/\r?\n/)[0];

  check("full Claude Code is on by default, working in its person's own folder", sql(`select bool_and(full_claude and in_folder) from public.connections where table_id = '${tableId}' and kind = 'claude'`) === "t");
  check("a new connection starts in Auto, so almost nothing needs its person", sql(`select bool_and(mode = 'auto') from public.connections where table_id = '${tableId}' and kind = 'claude'`) === "t");
  const samFolder = await rpc(tok.sam, "set_work_in_folder", { conn: conn.maya, on_: false });
  const mayaFolder = await rpc(tok.maya, "set_work_in_folder", { conn: conn.maya, on_: false });
  check("only its person decides whether it works in their folder", samFolder.status >= 400 && mayaFolder.status < 300
    && sql(`select in_folder from public.connections where id = '${conn.maya}'`) === "f", { samFolder, mayaFolder });
  await rpc(tok.maya, "set_work_in_folder", { conn: conn.maya, on_: true });

  // Where it may push from her folder is hers alone to widen.
  const samPush = await rpc(tok.sam, "set_push_anywhere", { conn: conn.maya, on_: true });
  const elenaPush = await rpc(tok.elena, "set_push_anywhere", { conn: conn.maya, on_: true });
  check("pushing only to the table's repository is the default, and only its person can widen it", sql(`select push_anywhere from public.connections where id = '${conn.maya}'`) === "f"
    && samPush.status >= 400 && elenaPush.status >= 400, { samPush, elenaPush });

  // The table's repository, set by someone who may change settings (never a client), reaches the connection with each job.
  const elenaRepo = await rpc(tok.elena, "set_table_repo", { t: tableId, url: "https://github.com/someone/else" });
  const withSignIn = await rpc(tok.maya, "set_table_repo", { t: tableId, url: "https://maya:secret@github.com/team/app" });
  const setRepo = await rpc(tok.maya, "set_table_repo", { t: tableId, url: "https://github.com/team/app" });
  check("the owner sets the table's repository; a client cannot, and a sign-in in it is refused", setRepo.status < 300 && elenaRepo.status >= 400 && withSignIn.status >= 400, { setRepo, elenaRepo, withSignIn });
  // Using it is each person's own yes, to exactly that address.
  const samYes = await rpc(tok.sam, "set_use_repo", { conn: conn.maya, url: "https://github.com/team/app" });
  const wrongYes = await rpc(tok.maya, "set_use_repo", { conn: conn.maya, url: "https://github.com/someone/else" });
  const mayaYes = await rpc(tok.maya, "set_use_repo", { conn: conn.maya, url: "https://github.com/team/app" });
  check("only its person says yes to the table's repository, and only to the address it has now", samYes.status >= 400 && wrongYes.status >= 400 && mayaYes.status < 300
    && sql(`select use_repo from public.connections where id = '${conn.maya}'`) === "https://github.com/team/app", { samYes, wrongYes, mayaYes });
  const askedId = sql(`insert into public.messages (table_id, chat_id, member_id, body) values ('${tableId}', '${chatId}', '${mayaId}', 'where is it') returning id`).split(/\r?\n/)[0];
  const lookId = sql(`insert into public.jobs (table_id, member_id, kind, chat_id, question_id) values ('${tableId}', '${mayaId}', 'look', '${chatId}', '${askedId}') returning id`).split(/\r?\n/)[0];
  const claimed = (await anon("runner_claim", { token: device.maya, lane: "light" })).body;
  check("each job carries the table's repository and where its person lets it push", claimed?.repo === "https://github.com/team/app" && claimed?.use_repo === "https://github.com/team/app" && claimed?.push_anywhere === false && claimed?.in_folder === true,
    { repo: claimed?.repo, push: claimed?.push_anywhere, kind: claimed?.kind });
  sql(`update public.jobs set status = 'done' where id = '${lookId}'`);

  // The address changes and changes back: the yes was to the old one, and it is not given back by itself.
  await rpc(tok.maya, "set_table_repo", { t: tableId, url: "https://github.com/team/other" });
  await rpc(tok.maya, "set_table_repo", { t: tableId, url: "https://github.com/team/app" });
  check("a changed repository needs its person's yes again", sql(`select coalesce(use_repo, 'none') from public.connections where id = '${conn.maya}'`) === "none");

  // What a connection says it reads is kept only as a plain address and the folder's own name.
  await anon("runner_report", { token: device.maya, limits: { ai: "claude", reads: { repo: "https://maya:tok@github.com/team/app", folder: "C:\\Users\\maya\\app", known: true } } });
  const bad = JSON.parse(sql(`select limits -> 'reads' from public.connections where id = '${conn.maya}'`) || "null");
  await anon("runner_report", { token: device.maya, limits: { ai: "claude", reads: { repo: "https://github.com/team/app", folder: "app", known: false } } });
  const good = JSON.parse(sql(`select limits -> 'reads' from public.connections where id = '${conn.maya}'`) || "null");
  check("what it reads is shown without a sign-in or a whole path", bad?.repo === null && bad?.folder === null
    && good?.repo === "https://github.com/team/app" && good?.folder === "app" && good?.known === false, { bad, good });
  await rpc(tok.maya, "set_full_claude", { conn: conn.maya, full_on: false });
  const early = await anon("runner_job_key", { token: device.maya, job });
  check("no key for a connection that is not set to full Claude Code", early.status >= 400, early);

  const samTurns = await rpc(tok.sam, "set_full_claude", { conn: conn.maya, full_on: true });
  const elenaTurns = await rpc(tok.elena, "set_full_claude", { conn: conn.maya, full_on: true });
  check("nobody else can turn on someone's full Claude Code", samTurns.status >= 400 && elenaTurns.status >= 400, { samTurns, elenaTurns });
  const mayaTurns = await rpc(tok.maya, "set_full_claude", { conn: conn.maya, full_on: true });
  check("its person turns it on", mayaTurns.status < 300 && sql(`select full_claude from public.connections where id = '${conn.maya}'`) === "t", mayaTurns);

  const wrongJob = await anon("runner_job_key", { token: device.sam, job });
  check("a connection gets no key for someone else's job", wrongJob.status >= 400, wrongJob);
  const key = (await anon("runner_job_key", { token: device.maya, job })).body;
  check("its connection gets a key for its own running job, stored only as a fingerprint",
    typeof key === "string" && key.length === 48 && sql(`select approval_key from public.jobs where id = '${job}'`) !== key, key);

  const asked = await anon("runner_ask_approval", { key, tool: "Bash", summary: "npm test" });
  const a = asked.body;
  check("the key asks its person", typeof a === "string" && asked.status < 300, asked);
  const forged = await anon("runner_ask_approval", { key: "0".repeat(48), tool: "Bash", summary: "rm -rf /" });
  check("a made-up key asks nothing", forged.status >= 400, forged);
  const leaked = await anon("runner_ask_approval", { key, tool: "Bash", summary: "export KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }); // scan:fake
  check("a key in a request is hidden before anyone sees it", leaked.status < 300 && !sql(`select summary from public.approvals where id = '${leaked.body}'`).includes("sk-ant-api03"), leaked);

  const hers = await rest(tok.maya, `approvals?select=id,summary,status&table_id=eq.${tableId}`);
  const his = await rest(tok.sam, `approvals?select=id,summary&table_id=eq.${tableId}`);
  const client = await rest(tok.elena, `approvals?select=id,summary&table_id=eq.${tableId}`);
  check("Maya sees her own Claude's requests", Array.isArray(hers.body) && hers.body.some((r) => r.id === a && r.summary === "npm test"), hers);
  check("a teammate and a client see none of them", Array.isArray(his.body) && his.body.length === 0 && Array.isArray(client.body) && client.body.length === 0, { his, client });

  const samSays = await rpc(tok.sam, "decide_approval", { a, allow: true, always_allow: false });
  check("only the person whose Claude asked can answer", samSays.status >= 400 && sql(`select status from public.approvals where id = '${a}'`) === "waiting", samSays);
  const waiting = (await anon("runner_approval", { key, a })).body;
  check("until then it waits", waiting?.status === "waiting", waiting);
  const mayaSays = await rpc(tok.maya, "decide_approval", { a, allow: true, always_allow: true });
  const now = (await anon("runner_approval", { key, a })).body;
  check("her answer reaches her Claude, always-allow included", mayaSays.status < 300 && now?.status === "allowed" && now?.always === true, { mayaSays, now });
  const twice = await rpc(tok.maya, "decide_approval", { a, allow: false, always_allow: false });
  check("an answer is given once", twice.status >= 400, twice);

  // Nobody answers for hours: it waits for her, as Claude Code at home does, while its job runs.
  const late = (await anon("runner_ask_approval", { key, tool: "Bash", summary: "npm run build", why: "Build the app to check it compiles" })).body;
  sql(`update public.approvals set created_at = now() - interval '3 hours' where id = '${late}'`);
  const still = (await anon("runner_approval", { key, a: late })).body;
  check("a request nobody has answered for hours still waits for her", still?.status === "waiting", still);
  check("and says why in one plain line", sql(`select why from public.approvals where id = '${late}'`) === "Build the app to check it compiles");
  const lateSays = await rpc(tok.maya, "decide_approval", { a: late, allow: true, always_allow: false });
  check("her answer when she comes back still counts", lateSays.status < 300 && (await anon("runner_approval", { key, a: late })).body?.status === "allowed", lateSays);

  // A Claude that asks and asks cannot bury its person in requests.
  sql(`update public.approvals set status = 'denied' where job_id = '${job}' and status = 'waiting'`);
  const flood = [];
  for (let i = 0; i < 6; i++) flood.push(await anon("runner_ask_approval", { key, tool: "Bash", summary: `echo ${i}` }));
  check("at most five requests wait for one job at a time", flood.slice(0, 5).every((r) => r.status < 300) && flood[5].status >= 400, flood.map((r) => r.status));
  sql(`update public.approvals set status = 'denied' where id in (${flood.filter((r) => r.status < 300).map((r) => `'${r.body}'`).join(",")})`);

  // Her connection restarts mid-wait and takes the job up again: what the earlier run asked ends, so no card is left
  // whose answer nobody would read, and nothing piles up toward the limit.
  const before = (await anon("runner_ask_approval", { key, tool: "Bash", summary: "npm run e2e" })).body;
  const again = (await anon("runner_job_key", { token: device.maya, job })).body;
  check("a job taken up again ends what its earlier run was waiting on", typeof again === "string" && sql(`select status from public.approvals where id = '${before}'`) === "expired");
  const oldKey = await anon("runner_ask_approval", { key, tool: "Bash", summary: "anything" });
  check("and the earlier run's key asks nothing more", oldKey.status >= 400, oldKey);
  // She turns her full Claude Code off while it waits: the request ends with it.
  const offWait = (await anon("runner_ask_approval", { key: again, tool: "Bash", summary: "npm run deploy-preview" })).body;
  await rpc(tok.maya, "set_full_claude", { conn: conn.maya, full_on: false });
  check("turning full Claude Code off ends what it was waiting on", sql(`select status from public.approvals where id = '${offWait}'`) === "expired");
  await rpc(tok.maya, "set_full_claude", { conn: conn.maya, full_on: true });
  const key2 = again;

  // Her Claude asks her a question with choices: a card only she answers, with words.
  const oneChoice = await anon("runner_ask_question", { key: key2, question: "Pick one", options: [{ label: "Only" }] });
  check("a question needs at least two choices", oneChoice.status >= 400, oneChoice);
  const qid = (await anon("runner_ask_question", { key: key2, question: "Which colour?", options: [{ label: "Red" }, { label: "Blue", about: "the darker one" }] })).body;
  const samAnswers = await rpc(tok.sam, "answer_question", { a: qid, words: "Red" });
  const asAllow = await rpc(tok.maya, "decide_approval", { a: qid, allow: true, always_allow: false });
  check("only she answers her Claude's question, and with words, not allow or deny", samAnswers.status >= 400 && asAllow.status >= 400, { samAnswers, asAllow });
  const mayaAnswers = await rpc(tok.maya, "answer_question", { a: qid, words: "Blue" });
  const heard = (await anon("runner_approval", { key: key2, a: qid })).body;
  check("her answer goes back to her Claude", mayaAnswers.status < 300 && heard?.status === "allowed" && heard?.answer === "Blue", { mayaAnswers, heard });

  // What she says while her own request runs goes into that run, and the listener leaves it to it.
  const chat2 = sql(`insert into public.chats (table_id, name) values ('${tableId}', 'Header') returning id`).split(/\r?\n/)[0];
  const m1 = sql(`insert into public.messages (table_id, chat_id, member_id, body) values ('${tableId}', '${chat2}', '${mayaId}', 'make the header bigger') returning id`).split(/\r?\n/)[0];
  const work = sql(`insert into public.jobs (table_id, member_id, kind, chat_id, question_id, status, started_at, lease_until) values ('${tableId}', '${mayaId}', 'answer', '${chat2}', '${m1}', 'running', now(), now() + interval '10 minutes') returning id`).split(/\r?\n/)[0];
  const samId = sql(`select id from public.members where table_id = '${tableId}' and display_name = 'Sam Ali'`);
  const m2 = sql(`insert into public.messages (table_id, chat_id, member_id, body) values ('${tableId}', '${chat2}', '${mayaId}', 'can you also make it blue while you are at it?') returning id`).split(/\r?\n/)[0];
  sql(`insert into public.messages (table_id, chat_id, member_id, body) values ('${tableId}', '${chat2}', '${samId}', 'what does the footer do on phones these days?')`);
  const got = (await anon("runner_inbox", { token: device.maya, job: work, open: true })).body;
  check("her new message goes into her own run, and only hers", Array.isArray(got) && got.length === 1 && got[0].id === m2, got);
  const again2 = (await anon("runner_inbox", { token: device.maya, job: work, open: true })).body;
  check("each is handed over once", Array.isArray(again2) && again2.length === 0, again2);
  const samsInbox = await anon("runner_inbox", { token: device.sam, job: work, open: true });
  check("nobody else's connection can take her run's messages", samsInbox.status >= 400, samsInbox);
  sql(`delete from public.jobs where chat_id = '${chat2}' and kind = 'listen'`);
  sql(`update public.listens set due_at = now() - interval '1 second' where chat_id = '${chat2}'`);
  sql(`select public.listen_now()`);
  const listenFor = (who) => sql(`select count(*) from public.jobs j join public.messages q on q.id = j.question_id where j.chat_id = '${chat2}' and j.kind = 'listen' and q.member_id = '${who}'`);
  check("while her run takes her words, the listener leaves them to it and still hears Sam", listenFor(mayaId) === "0" && listenFor(samId) === "1", { maya: listenFor(mayaId), sam: listenFor(samId) });
  // The run ends without having read it: it goes back to be heard as usual.
  // A message asked outright with Ctrl+Enter is a request of its own, never also handed into the run.
  const m3 = sql(`insert into public.messages (table_id, chat_id, member_id, body) values ('${tableId}', '${chat2}', '${mayaId}', 'and check the spacing too please') returning id`).split(/\r?\n/)[0];
  sql(`insert into public.jobs (table_id, member_id, kind, chat_id, question_id, status) values ('${tableId}', '${mayaId}', 'answer', '${chat2}', '${m3}', 'skipped')`);
  const outright = (await anon("runner_inbox", { token: device.maya, job: work, open: true })).body;
  check("a message asked outright is never also handed into the run", Array.isArray(outright) && outright.length === 0, outright);
  sql(`delete from public.jobs where question_id = '${m3}'`);
  sql(`delete from public.messages where id = '${m3}'`);
  // The listener goes round again while her run still takes her words: Sam's message, already heard, is not heard twice.
  sql(`update public.listens set due_at = now() - interval '1 second' where chat_id = '${chat2}'`);
  sql(`select public.listen_now()`);
  check("a teammate's message is heard once, however often the listener goes round", listenFor(samId) === "1", listenFor(samId));
  await anon("runner_inbox", { token: device.maya, job: work, open: false, seen: [] });
  sql(`update public.jobs set status = 'done' where id = '${work}'`);
  sql(`delete from public.jobs where chat_id = '${chat2}' and kind = 'listen'`);
  sql(`update public.listens set due_at = now() - interval '1 second' where chat_id = '${chat2}'`);
  sql(`select public.listen_now()`);
  check("what her run never read is heard once it ends", listenFor(mayaId) === "1" && sql(`select count(*) from public.delivered_messages where message_id = '${m2}'`) === "0");
  // Her connection dies mid-run, so the run never says what it read: what it was handed is heard as usual.
  sql(`delete from public.jobs where chat_id = '${chat2}' and kind = 'listen'`);
  const work2 = sql(`insert into public.jobs (table_id, member_id, kind, chat_id, question_id, status, started_at, lease_until) values ('${tableId}', '${mayaId}', 'answer', '${chat2}', '${m1}', 'running', now(), now() + interval '10 minutes') returning id`).split(/\r?\n/)[0];
  const m4 = sql(`insert into public.messages (table_id, chat_id, member_id, body) values ('${tableId}', '${chat2}', '${mayaId}', 'could you also bump the version number?') returning id`).split(/\r?\n/)[0];
  const got4 = (await anon("runner_inbox", { token: device.maya, job: work2, open: true })).body;
  sql(`update public.jobs set status = 'failed', taking = false where id = '${work2}'`);
  sql(`update public.listens set due_at = now() - interval '1 second' where chat_id = '${chat2}'`);
  sql(`select public.listen_now()`);
  const heardM4 = sql(`select count(*) from public.jobs where chat_id = '${chat2}' and kind = 'listen' and question_id = '${m4}'`);
  check("a run that died without reading what it was handed gives it back to be heard", Array.isArray(got4) && got4.some((m) => m.id === m4) && heardM4 === "1", { got4, heardM4 });
  sql(`delete from public.jobs where chat_id = '${chat2}' and kind = 'listen'`);

  // Her Claude puts a file on its answer: uploaded into its own job's place with nothing but the job's key, then on the answer.
  const prefix = (await anon("runner_upload_slot", { key: key2 })).body;
  check("a running job gets a place of its own to upload into", typeof prefix === "string" && prefix.startsWith(`${tableId}/ai-`), prefix);
  const object = `${prefix}${crypto.randomUUID()}-shot.png`;
  const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
  const up = await fetch(`${API}/storage/v1/object/attachments/${object}`, { method: "POST", headers: { apikey: KEY, "Content-Type": "image/png" }, body: PNG });
  const elsewhere = await fetch(`${API}/storage/v1/object/attachments/${tableId}/ai-${"0".repeat(32)}/x-shot.png`, { method: "POST", headers: { apikey: KEY, "Content-Type": "image/png" }, body: PNG });
  check("it uploads there, and nowhere a job's key did not open", up.ok && !elsewhere.ok, { up: up.status, elsewhere: elsewhere.status });
  const notItsPlace = await anon("runner_attach", { key: key2, path: `${tableId}/${mayaId}/${crypto.randomUUID()}-x.png`, name: "x.png" });
  const named = await anon("runner_attach", { key: key2, path: object, name: "shot.png" });
  check("only a file in its own place can be named to the job", notItsPlace.status >= 400 && named.status < 300, { notItsPlace, named });
  const answerMsg = sql(`insert into public.messages (table_id, chat_id, member_id, body, by_ai, kind) values ('${tableId}', '${chatId}', '${mayaId}', 'Here it is.', true, 'answer') returning id`).split(/\r?\n/)[0];
  sql(`update public.jobs set result_message_id = '${answerMsg}' where id = '${job}'`);
  const placed = (await anon("runner_attach_answer", { token: device.maya, job })).body;
  const onAnswer = JSON.parse(sql(`select meta -> 'files' from public.messages where id = '${answerMsg}'`) || "[]");
  check("once its answer is written, the file is on it", placed === 1 && onAnswer.length === 1 && onAnswer[0].name === "shot.png" && onAnswer[0].kind === "image", { placed, onAnswer });
  const teamSees = await rest(tok.sam, `attachments?select=id&message_id=eq.${answerMsg}`);
  const clientSees = await rest(tok.elena, `attachments?select=id&message_id=eq.${answerMsg}`);
  check("the team sees it, a client does not", teamSees.body?.length === 1 && Array.isArray(clientSees.body) && clientSees.body.length === 0, { teamSees: teamSees.body, clientSees: clientSees.body });

  // Text she pasted is marked where it sits, on her own message only, and reaches her AI marked.
  const pastedMsg = sql(`insert into public.messages (table_id, chat_id, member_id, body) values ('${tableId}', '${chatId}', '${mayaId}', 'see this: LOG LINE ONE') returning id`).split(/\r?\n/)[0];
  const samMarks = await rpc(tok.sam, "mark_pasted", { m: pastedMsg, ranges: [[0, 3]] });
  const tooLong = await rpc(tok.maya, "mark_pasted", { m: pastedMsg, ranges: [[10, 999]] });
  const marks = await rpc(tok.maya, "mark_pasted", { m: pastedMsg, ranges: [[10, 12]] });
  const kept = JSON.parse(sql(`select coalesce(meta -> 'pasted', 'null') from public.messages where id = '${pastedMsg}'`));
  check("she marks what she pasted in her own message, only where it fits", tooLong.status < 300 && marks.status < 300 && JSON.stringify(kept) === "[[10,12]]", { kept });
  check("nobody else can mark her message", samMarks.status >= 400, samMarks);
  // Her browser is hers to turn on, and reaches her connection with each job.
  const samBrowser = await rpc(tok.sam, "set_browser", { conn: conn.maya, on_: true });
  const mayaBrowser = await rpc(tok.maya, "set_browser", { conn: conn.maya, on_: true });
  check("only she turns her AI's browser on", samBrowser.status >= 400 && mayaBrowser.status < 300 && sql(`select browser from public.connections where id = '${conn.maya}'`) === "t", { samBrowser, mayaBrowser });
  const lookP = sql(`insert into public.jobs (table_id, member_id, kind, chat_id, question_id) values ('${tableId}', '${mayaId}', 'look', '${chatId}', '${pastedMsg}') returning id`).split(/\r?\n/)[0];
  const claimedP = (await anon("runner_claim", { token: device.maya, lane: "light" })).body;
  check("each job carries her browser switch and where her question was pasted", claimedP?.browser === true && JSON.stringify(claimedP?.question_pasted) === "[[10,12]]", { browser: claimedP?.browser, pasted: claimedP?.question_pasted, kind: claimedP?.kind });
  sql(`update public.jobs set status = 'done' where id = '${lookP}'`);

  // The job ends: its key dies with it, and nothing of it waits any more.
  const open = (await anon("runner_ask_approval", { key: key2, tool: "Bash", summary: "npm run lint" })).body;
  sql(`update public.jobs set status = 'done' where id = '${job}'`);
  const after = await anon("runner_ask_approval", { key: key2, tool: "Bash", summary: "anything" });
  check("when its job ends the key asks nothing", after.status >= 400, after);
  check("and what still waited for it is closed", sql(`select status from public.approvals where id = '${open}'`) === "expired");

  // Turned off again: no new keys.
  await rpc(tok.maya, "set_full_claude", { conn: conn.maya, full_on: false });
  const job2 = sql(`insert into public.jobs (table_id, member_id, kind, chat_id, status, started_at) values ('${tableId}', '${mayaId}', 'look', '${chatId}', 'running', now()) returning id`).split(/\r?\n/)[0];
  const off = await anon("runner_job_key", { token: device.maya, job: job2 });
  check("turned off, it gets no key", off.status >= 400, off);
  sql(`update public.jobs set status = 'done' where id = '${job2}'`);
} catch (e) {
  check("the run did not crash", false, e.stack || e.message);
} finally {
  await browser.close();
}
console.log(JSON.stringify({ checks: results }, null, 2));
const failed = Object.values(results).filter((v) => v !== "pass").length;
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
