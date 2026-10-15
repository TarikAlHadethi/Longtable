// The known faults left open by the bug sweep and the chaos run, fixed in 20261016100000_known_faults_group_one.sql.
// Played against the database with stand-in connections, as sim-rounds does; no real AI.
//   D11: two hand-overs at once, and a hand-over racing the removal of the same person, leave exactly one owner.
//   D10: a round whose lead is taken off hands its next step to someone still at the table.
//   A lead step still "waiting" in a round that already has its answer is closed, even with its computer on.
//   D8: what a connection sends (files read, model, sources, confidence, usage, a leaving reason) is kept cleaned.
//
//   node --experimental-websocket tests/e2e/step29-known-faults.mjs

import { execFileSync } from "node:child_process";
import { accessToken, API, inviteLink, join as joinTable, KEY, launch, rest, rpc, sleep, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = { checks: {} };
const check = (name, ok, detail) => { results.checks[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 400)}`; };
const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
const anon = async (fn, args) => {
  const res = await fetch(`${API}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
};
async function until(fn, ms = 20000, every = 500) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}

// Made-up secrets: none of them may be kept.
const FAKE_KEY = "sk-ant-api03-" + "Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lz9Xc"; // scan:fake
const FAKE_GH = "ghp_" + "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2"; // scan:fake

const browser = await launch();
const people = {};
let pulse = null;
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Known faults", "Maya");
  const table = owner.tableId;
  people.Maya = owner;
  people.Sam = await joinTable(browser, await inviteLink(owner.page, "developer"), `sam-${run}@example.test`, "Sam");
  people.Lee = await joinTable(browser, await inviteLink(owner.page, "developer"), `lee-${run}@example.test`, "Lee");
  people.Kai = await joinTable(browser, await inviteLink(owner.page, "developer"), `kai-${run}@example.test`, "Kai");
  for (const p of Object.values(people)) p.token = await accessToken(p.context);
  for (const m of (await rest(people.Maya.token, `members?select=id,display_name&table_id=eq.${table}`)).body) people[m.display_name].id = m.id;
  const owners = () => JSON.parse(sql(`select coalesce(json_agg(json_build_object('id', id, 'removed', removed_at is not null)), '[]') from public.members where table_id = '${table}' and role = 'owner'`));
  const ownerName = () => Object.keys(people).find((n) => people[n].id === owners()[0]?.id);

  async function pair(name) {
    const code = (await rpc(people[name].token, "start_pairing", { t: table, ai_kind: "claude" })).body;
    people[name].device = (await anon("pair_connection", { code, device_label: "known" })).body.token;
    sql(`update public.jobs set status = 'skipped' where table_id = '${table}' and kind = 'intro' and status in ('queued','running')`);
  }
  const awake = new Set();
  pulse = setInterval(() => { for (const n of awake) if (people[n].device) anon("runner_hello", { token: people[n].device }).catch(() => {}); }, 8000);
  const online = async (...names) => { for (const n of names) { awake.add(n); await anon("runner_hello", { token: people[n].device }); } };
  const jobsOf = (where) => JSON.parse(sql(`select coalesce(json_agg(x order by x.created_at), '[]') from (select id, kind, status, member_id, round, created_at from public.jobs where table_id = '${table}' and ${where}) x`));
  const chat = async (n) => (await rpc(people.Maya.token, "create_chat", { t: table, chat_name: `k${n}-${run}` })).body;

  // ---- D11: one owner, whatever arrives at the same moment
  check("the database holds one owner per table", sql(`select count(*) from pg_indexes where indexname = 'members_one_owner'`) === "1");
  let twoOwners = 0, removedOwner = 0, tries = 0;
  for (let i = 0; i < 6; i++) {
    const from = ownerName();
    const [a, b] = await Promise.all([
      rpc(people[from].token, "transfer_ownership", { m: people[from === "Sam" ? "Lee" : "Sam"].id }),
      rpc(people[from].token, "transfer_ownership", { m: people[from === "Kai" ? "Lee" : "Kai"].id }),
    ]);
    tries++;
    const now = owners();
    if (now.length !== 1) twoOwners++;
    if ([a, b].filter((r) => r.status < 300).length !== 1) twoOwners++;
  }
  check("two hand-overs sent at the same moment leave exactly one owner, every time", twoOwners === 0, { twoOwners, tries, owners: owners() });
  // Back to Maya, the way an owner hands it on.
  if (ownerName() !== "Maya") await rpc(people[ownerName()].token, "transfer_ownership", { m: people.Maya.id });
  check("the table can be handed back", ownerName() === "Maya", owners());
  // A hand-over racing the removal of the same person: Kai either becomes the owner or is taken off, never both.
  const [give, take] = await Promise.all([
    rpc(people.Maya.token, "transfer_ownership", { m: people.Kai.id }),
    rpc(people.Maya.token, "remove_member", { m: people.Kai.id }),
  ]);
  const after = owners();
  if (after.some((o) => o.removed)) removedOwner++;
  check("a hand-over racing the removal of the same person leaves one owner who is still at the table", after.length === 1 && removedOwner === 0, { give: give.status, take: take.status, after });
  if (ownerName() === "Kai") await rpc(people.Kai.token, "transfer_ownership", { m: people.Maya.id });
  check("one of the two went through and the other was refused", [give, take].filter((r) => r.status < 300).length === 1, [give.status, take.status, give.body, take.body]);
  check("the owner is Maya again before the rounds", ownerName() === "Maya", owners());

  await pair("Maya");
  await pair("Sam");
  await online("Maya", "Sam");

  // ---- A lead step still waiting in a round that already has its answer is closed, its computer on or not
  const c1 = await chat(1);
  const r1 = (await rpc(people.Sam.token, "ask_table", { c: c1, body: "Add a price list to the booking page" })).body;
  const waiting = jobsOf(`round = '${r1.round}' and kind in ('plan','work') and status = 'waiting'`);
  check("Sam's ask starts a round led by Sam's Claude, waiting its turn", waiting.length === 1 && waiting[0].member_id === people.Sam.id, waiting);
  sql(`insert into public.jobs (table_id, chat_id, member_id, question_id, kind, round, task_id, status, finished_at)
       select table_id, chat_id, '${people.Maya.id}', question_id, 'combine', round, task_id, 'done', now() from public.jobs where id = '${waiting[0].id}'`);
  sql(`select public.close_failed_tasks()`);
  const closed = jobsOf(`id = '${waiting[0].id}'`)[0];
  check("a lead step waiting in a round that already has its answer is closed at once, though its computer is on", closed?.status === "skipped", closed);

  // ---- D10: a round whose lead is taken off goes on with someone still at the table
  const c2 = await chat(2);
  const r2 = (await rpc(people.Sam.token, "ask_table", { c: c2, body: "Rewrite the booking form's date check" })).body;
  const lead = jobsOf(`round = '${r2.round}' and kind in ('plan','work')`);
  check("the second round is led by Sam's Claude too", lead.length === 1 && lead[0].member_id === people.Sam.id, lead);
  const removedAt = new Date().toISOString();
  const off = await rpc(people.Maya.token, "remove_member", { m: people.Sam.id });
  awake.delete("Sam");
  check("Sam is taken off", off.status < 300, off.body);
  const next = await until(() => { const js = jobsOf(`round = '${r2.round}' and created_at > '${removedAt}'`); return js.length ? js : null; }, 15000);
  check("the round's next step goes to someone still at the table, not to Sam", !!next && next.every((j) => j.member_id === people.Maya.id), next);
  check("and nothing of the round is left waiting for Sam", jobsOf(`round = '${r2.round}' and member_id = '${people.Sam.id}' and status in ('queued','running','waiting')`).length === 0);
  // A plan's part meant for someone taken off goes to the lead.
  sql(`update public.jobs set status = 'skipped' where round = '${r2.round}' and status in ('queued','running','waiting')`);
  const c3 = await chat(3);
  const lee = await pair("Lee").then(() => online("Lee"));
  const r3 = (await rpc(people.Maya.token, "ask_table", { c: c3, body: "Split the settings page into two" })).body;
  const plan = await until(() => jobsOf(`round = '${r3.round}' and kind = 'plan' and status = 'queued'`)[0], 120000, 1000);
  check("with two Claudes on, Maya's ask starts with a plan", !!plan, jobsOf(`round = '${r3.round}'`));
  if (plan) {
    sql(`update public.jobs set status = 'done', finished_at = now(), outcome = jsonb_build_object('parts', jsonb_build_array(
           jsonb_build_object('member', '${people.Maya.id}', 'brief', 'the first half'),
           jsonb_build_object('member', '${people.Sam.id}', 'brief', 'the second half'))) where id = '${plan.id}'`);
    sql(`select public.advance_round('${r3.round}')`);
    const works = jobsOf(`round = '${r3.round}' and kind = 'work'`);
    check("a plan's part meant for someone taken off goes to the lead instead", works.length === 2 && works.every((w) => w.member_id === people.Maya.id), works);
  }
  void lee;

  // ---- D8: what a connection sends is kept cleaned
  sql(`update public.jobs set status = 'skipped' where table_id = '${table}' and status in ('queued','running','waiting')`);
  sql(`update public.connections set revoked_at = now() where member_id = '${people.Lee.id}' and revoked_at is null`);
  awake.delete("Lee");
  const c4 = await chat(4);
  await rpc(people.Maya.token, "ask_table", { c: c4, body: "Where is the price shown?" });
  const job = await until(async () => { const j = (await anon("runner_claim", { token: people.Maya.device, lane: "heavy" })).body; return j && j.job_id ? j : null; }, 15000);
  check("Maya's Claude gets the answer to do", !!job, job);
  if (job) {
    await anon("runner_finish", { token: people.Maya.device, job: job.job_id, answer: "It is shown on the booking page.", info: {
      read: `main @ abc1234 ${FAKE_KEY}`, model: `opus ${FAKE_GH}`, confidence: `high ${FAKE_KEY}`,
      sources: ["booking/page.tsx", `https://maya:hunter2@example.test/${FAKE_KEY}`, 42], usage: { input: 1200, output: 80, note: FAKE_KEY, nested: { x: 1 } } } });
    const kept = JSON.parse(sql(`select json_build_object('meta', m.meta, 'usage', j.usage, 'result', t.result) from public.jobs j join public.messages m on m.id = j.result_message_id left join public.tasks t on t.id = j.task_id where j.id = '${job.job_id}'`) || "null");
    const text = JSON.stringify(kept);
    check("the answer is kept", !!kept?.meta, kept);
    check("no key, token or sign-in from what the connection sent is kept", !/sk-ant-|ghp_|hunter2|Qw8Er7Ty6Ui5|Ab1Cd2Ef3Gh4/.test(text), text.slice(0, 400));
    check("the files read, the model and the sources are still there, cleaned", /abc1234/.test(kept.meta.read) && /opus/.test(kept.meta.model) && kept.meta.sources.includes("booking/page.tsx") && kept.meta.sources.length === 2, kept.meta);
    check("usage keeps numbers only", JSON.stringify(kept.usage) === JSON.stringify({ input: 1200, output: 80 }), kept.usage);
  }
  sql(`insert into public.jobs (table_id, member_id, kind) values ('${table}', '${people.Maya.id}', 'intro')`);
  await anon("runner_leave", { token: people.Maya.device, reason: `could not sign in with ${FAKE_KEY}` });
  const why = sql(`select error from public.jobs where table_id = '${table}' and member_id = '${people.Maya.id}' and kind = 'intro' order by created_at desc limit 1`);
  check("a leaving connection's reason is kept with its secrets hidden", /could not sign in/.test(why) && !/sk-ant-|Qw8Er7Ty6Ui5/.test(why), why);
} catch (e) {
  results.error = String(e?.stack || e).slice(0, 900);
} finally {
  if (pulse) clearInterval(pulse);
  await browser.close();
}
const failed = Object.values(results.checks).filter((v) => v !== "pass").length + (results.error ? 1 : 0);
console.log(JSON.stringify(results, null, 2));
console.log(`${Object.keys(results.checks).length - (failed - (results.error ? 1 : 0))} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
