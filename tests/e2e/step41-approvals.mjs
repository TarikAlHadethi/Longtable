// A person's full Claude Code at the table, against the database with stand-in connections: the switch is theirs
// alone and off until they turn it on; their Claude's requests reach only them; only they answer; a job's key asks
// only about that job and dies with it; a request nobody answers expires as a no.
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

  check("full Claude Code is off until its person turns it on", sql(`select bool_and(not full_claude) from public.connections where table_id = '${tableId}'`) === "t");
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

  // Nobody answers: after ten minutes it is a no.
  const late = (await anon("runner_ask_approval", { key, tool: "Bash", summary: "npm run build" })).body;
  sql(`update public.approvals set created_at = now() - interval '11 minutes' where id = '${late}'`);
  const expired = (await anon("runner_approval", { key, a: late })).body;
  check("a request nobody answers in ten minutes expires as a no", expired?.status === "expired", expired);
  const stale = (await anon("runner_ask_approval", { key, tool: "Bash", summary: "npm run e2e" })).body;
  sql(`update public.approvals set created_at = now() - interval '11 minutes' where id = '${stale}'`);
  const staleSays = await rpc(tok.maya, "decide_approval", { a: stale, allow: true, always_allow: false });
  check("an answer after ten minutes is refused, even before Claude has looked again", staleSays.status >= 400 && sql(`select status from public.approvals where id = '${stale}'`) !== "allowed", staleSays);

  // A Claude that asks and asks cannot bury its person in requests.
  sql(`update public.approvals set status = 'denied' where job_id = '${job}' and status = 'waiting'`);
  const flood = [];
  for (let i = 0; i < 6; i++) flood.push(await anon("runner_ask_approval", { key, tool: "Bash", summary: `echo ${i}` }));
  check("at most five requests wait for one job at a time", flood.slice(0, 5).every((r) => r.status < 300) && flood[5].status >= 400, flood.map((r) => r.status));
  sql(`update public.approvals set status = 'denied' where id in (${flood.filter((r) => r.status < 300).map((r) => `'${r.body}'`).join(",")})`);

  // The job ends: its key dies with it, and nothing of it waits any more.
  const open = (await anon("runner_ask_approval", { key, tool: "Bash", summary: "npm run lint" })).body;
  sql(`update public.jobs set status = 'done' where id = '${job}'`);
  const after = await anon("runner_ask_approval", { key, tool: "Bash", summary: "anything" });
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
