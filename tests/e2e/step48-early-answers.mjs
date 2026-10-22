// The answer starts with the listener: a message plainly for the AI gets its asker's own Claude started beside the
// listener; when the listener says look, that run is the look (no second one); when it says anything else, the early
// run is stopped and its connection is told within a beat. Fake connections, no AI.
//
//   node --experimental-websocket tests/e2e/step48-early-answers.mjs

import { execFileSync } from "node:child_process";
import { API, KEY, accessToken, inviteLink, join, launch, rpc, startTable, sleep } from "./lib.mjs";

const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
const anon = async (fn, args) => { const r = await fetch(`${API}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(args) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const run = Date.now().toString(36);
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 300)}`; };
const browser = await launch();
try {
  const o = await startTable(browser, `early-${run}@example.test`, "Fernhill Dental", "Maya Stone");
  const sam = await join(browser, await inviteLink(o.page, "developer"), `early-sam-${run}@example.test`, "Sam Lee");
  const t = o.tableId;
  const device = {};
  for (const [who, ctx] of [["maya", o.context], ["sam", sam.context]]) {
    const code = (await rpc(await accessToken(ctx), "start_pairing", { t, ai_kind: "claude" })).body;
    device[who] = (await anon("pair_connection", { code, device_label: who })).body.token;
  }
  sql(`update public.jobs set status = 'skipped' where table_id = '${t}' and kind = 'intro'`);
  const general = sql(`select id from public.chats where table_id = '${t}' and is_general`);
  const maya = sql(`select id from public.members where table_id = '${t}' and display_name = 'Maya Stone'`);
  const samId = sql(`select id from public.members where table_id = '${t}' and display_name = 'Sam Lee'`);
  const on = () => sql(`update public.connections set last_seen = now() where table_id = '${t}'`);
  const say = (who, body) => sql(`insert into public.messages (table_id, chat_id, member_id, body) values ('${t}', '${general}', '${who}', '${body.replace(/'/g, "''")}') returning id`).split("\n")[0];
  const jobsOn = (m) => sql(`select string_agg(kind || ':' || status || ':' || early, ',' order by kind) from public.jobs where question_id = '${m}'`);
  const settle = async (m) => { for (let i = 0; i < 20; i++) { await sleep(500); if (sql(`select count(*) from public.jobs where question_id = '${m}' and kind = 'listen'`) !== "0") return; } };
  const finishListen = async (m, act) => {
    const id = sql(`select id from public.jobs where question_id = '${m}' and kind = 'listen'`);
    const owner = sql(`select member_id from public.jobs where id = '${id}'`) === maya ? device.maya : device.sam;
    sql(`update public.jobs set status = 'running', started_at = now(), lease_until = now() + interval '1 minute', connection_id = (select id from public.connections where member_id = (select member_id from public.jobs where id = '${id}') and revoked_at is null limit 1) where id = '${id}'`);
    return anon("runner_finish", { token: owner, job: id, answer: act === "reply" ? "Hello." : "", info: { act } });
  };

  // 1. A question for the AI, said by Maya with her Claude on: the listener and her early look start together.
  on();
  const q1 = say(maya, "claude, what does the booking page do?");
  await settle(q1);
  check("a message for the AI starts the asker's own Claude beside the listener", jobsOn(q1) === "listen:queued:false,look:queued:true", jobsOn(q1));
  check("the early look is the asker's own", sql(`select member_id from public.jobs where question_id = '${q1}' and kind = 'look'`) === maya);
  await finishListen(q1, "look");
  check("when the listener says look, that early run is the look: no second one", sql(`select count(*) from public.jobs where question_id = '${q1}' and kind = 'look'`) === "1", jobsOn(q1));

  // 2. A question the listener decides is not for the AI: the early run is stopped, and its heartbeat hears so.
  await sleep(1500); on();
  sql(`update public.jobs set status = 'done' where question_id = '${q1}'`);
  const q2 = say(maya, "is everyone around tomorrow?");
  await settle(q2);
  const early2 = sql(`select id from public.jobs where question_id = '${q2}' and kind = 'look' and early`);
  check("a plain question to the room starts an early run too", !!early2, jobsOn(q2));
  sql(`update public.jobs set status = 'running', started_at = now(), lease_until = now() + interval '1 minute' where id = '${early2}'`);
  await finishListen(q2, "silent");
  check("when the listener says silent, the early run is stopped", sql(`select status || ':' || coalesce(error, '') from public.jobs where id = '${early2}'`) === "skipped:not needed", jobsOn(q2));
  check("and its connection's next beat says stop", (await anon("runner_beat", { token: device.maya, job: early2, note: "reading" })).body === false);

  // 3. A question to someone else at the table is theirs: no early run.
  await sleep(1500); on();
  const q3 = say(maya, "Sam, did you push the fix?");
  await settle(q3);
  check("a question that names someone else at the table starts no early run", sql(`select count(*) from public.jobs where question_id = '${q3}' and kind = 'look'`) === "0", jobsOn(q3));
  sql(`update public.jobs set status = 'done' where question_id = '${q3}'`);

  // 4. Work: the early run is stopped and the round starts as before.
  await sleep(1500); on();
  const q4 = say(maya, "claude please add a cancel button to the booking page");
  await settle(q4);
  check("a request for work starts an early run as well", sql(`select count(*) from public.jobs where question_id = '${q4}' and kind = 'look' and early`) === "1", jobsOn(q4));
  await finishListen(q4, "work");
  check("when the listener says work, the early run is stopped and the work starts", sql(`select status from public.jobs where question_id = '${q4}' and kind = 'look'`) === "skipped"
    && sql(`select count(*) from public.jobs where question_id = '${q4}' and kind not in ('listen', 'look')`) !== "0", jobsOn(q4));

  // 5. With the asker's Claude off, nothing starts early.
  await sleep(1500);
  sql(`update public.jobs set status = 'skipped' where table_id = '${t}' and status in ('queued', 'running', 'waiting')`);
  sql(`update public.connections set last_seen = now() - interval '5 minutes' where member_id = '${samId}'`);
  sql(`update public.connections set last_seen = now() where member_id = '${maya}'`);
  const q5 = say(samId, "claude what changed today?");
  await settle(q5);
  check("with the asker's own Claude off, nothing starts early", sql(`select count(*) from public.jobs where question_id = '${q5}' and kind = 'look'`) === "0", jobsOn(q5));
} catch (e) { check("the run did not crash", false, e.stack || e.message); }
await browser.close();
console.log(JSON.stringify({ checks: results }, null, 2));
const failed = Object.values(results).filter((v) => v !== "pass").length;
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
