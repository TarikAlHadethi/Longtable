// The last known faults of the bug sweep (17 Oct 2026), against the database with stand-in connections.
//   D12: a listen holds its job 90 seconds at most, and a failed listen is not tried again.
//   D13: a client's page hears live, on its own channel, that the team's assistant is answering it.
//   D14: a plan handing work to a first name two teammates share gives it to neither; a full name finds the one.
//
//   node --experimental-websocket tests/e2e/step32-last-faults.mjs

import { execFileSync } from "node:child_process";
import { accessToken, API, inviteLink, join as joinTable, KEY, launch, listen, rest, rpc, sleep, startTable } from "./lib.mjs";

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
let pulse = null;
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Last faults", "Maya Stone");
  const { tableId } = owner;
  const samA = await joinTable(browser, await inviteLink(owner.page, "developer"), `sama-${run}@example.test`, "Sam Ali");
  const samB = await joinTable(browser, await inviteLink(owner.page, "developer"), `samb-${run}@example.test`, "Sam Berg");
  const elena = await joinTable(browser, await inviteLink(owner.page, "client"), `elena-${run}@example.test`, "Elena");
  const tok = { maya: await accessToken(owner.context), a: await accessToken(samA.context), b: await accessToken(samB.context), elena: await accessToken(elena.context) };
  const ids = Object.fromEntries((await rest(tok.maya, `members?select=id,display_name&table_id=eq.${tableId}`)).body.map((m) => [m.display_name, m.id]));
  const device = {};
  for (const [who, t] of [["maya", tok.maya], ["a", tok.a], ["b", tok.b]]) {
    const code = (await rpc(t, "start_pairing", { t: tableId, ai_kind: "claude" })).body;
    device[who] = (await anon("pair_connection", { code, device_label: "last" })).body.token;
  }
  sql(`update public.jobs set status = 'skipped' where table_id = '${tableId}' and kind = 'intro'`);
  const hello = () => Promise.all(Object.values(device).map((d) => anon("runner_hello", { token: d })));
  await hello();
  pulse = setInterval(hello, 8000);
  const general = (await rest(tok.maya, `chats?select=id&table_id=eq.${tableId}&is_general=is.true`)).body[0].id;

  // ---- D12: a listen's lease, and no second try
  sql(`insert into public.jobs (table_id, chat_id, member_id, kind, question_id)
       select '${tableId}', '${general}', '${ids["Maya Stone"]}', 'listen', (select id from public.messages where chat_id = '${general}' order by created_at desc limit 1)`);
  let listenJob = null;
  for (let i = 0; i < 20 && !listenJob; i++) { const j = (await anon("runner_claim", { token: device.maya, lane: "light" })).body; if (j?.kind === "listen") listenJob = j; else await sleep(300); }
  const lease = listenJob ? Number(sql(`select extract(epoch from lease_until - now())::int from public.jobs where id = '${listenJob.job_id}'`)) : -1;
  check("a listen holds its job 90 seconds at most", listenJob && lease > 0 && lease <= 90, { lease, kind: listenJob?.kind });
  if (listenJob) await anon("runner_fail", { token: device.maya, job: listenJob.job_id, reason: "the model did not answer" });
  const after = listenJob ? sql(`select status from public.jobs where id = '${listenJob.job_id}'`) : "";
  check("a failed listen is not tried again", after === "failed", after);

  // ---- D14: a first name two people share is nobody in particular
  await rpc(tok.maya, "ask_table", { c: general, body: "Split the booking page between us" });
  let plan = null;
  for (let i = 0; i < 60 && !plan; i++) {
    const j = (await anon("runner_claim", { token: device.maya, lane: "light" })).body;
    if (j?.kind === "plan") plan = j;
    else if (j?.job_id) await anon("runner_finish", { token: device.maya, job: j.job_id, answer: "fine", info: {} });
    else { for (const d of [device.a, device.b]) { const v = (await anon("runner_claim", { token: d, lane: "light" })).body; if (v?.job_id) await anon("runner_finish", { token: d, job: v.job_id, answer: "a view", info: {} }); } await sleep(500); }
  }
  check("Maya's ask starts with a plan", !!plan, plan);
  if (plan) {
    await anon("runner_finish", { token: device.maya, job: plan.job_id, answer: "the plan", info: { mine: "the header", handoffs: [{ to: "Sam", what: "the form" }, { to: "Sam Berg", what: "the footer" }] } });
    const parts = JSON.parse(sql(`select coalesce(outcome -> 'parts', '[]') from public.jobs where id = '${plan.job_id}'`) || "[]");
    const to = (who) => parts.filter((p) => p.member === ids[who]).map((p) => p.brief).join(" | ");
    check("a part for \"Sam\", which two people are called, goes to neither of them and stays with the lead", !to("Sam Ali").includes("the form") && !to("Sam Berg").includes("the form") && to("Maya Stone").includes("the form"), parts);
    check("a part for a full name goes to that one person", to("Sam Berg").includes("the footer") && !to("Sam Ali").includes("the footer"), parts);
  }

  // ---- D13: a client hears live that the team's assistant is answering
  const ear = await listen(tok.elena, `client:${tableId}:${ids.Elena}`);
  check("the client can listen on their own channel", ear.status === "SUBSCRIBED", ear.status);
  await rpc(tok.elena, "client_say", { t: tableId, body: "Where are we on the booking page?", files: [] });
  await sleep(2500);
  const heardJob = ear.heard.find((m) => m?.table === "jobs" && m?.record?.kind === "client");
  check("the client's page hears live that their question is being answered", !!heardJob && heardJob.record.member_id === ids.Elena, ear.heard.map((m) => m?.table));
  check("and hears nothing of the team's own work on that channel", !ear.heard.some((m) => m?.table === "jobs" && m?.record?.kind !== "client"));
  check("what it hears is only which job, its kind and its state", !!heardJob && Object.keys(heardJob.record).every((k) => ["id", "kind", "status", "member_id", "created_at"].includes(k)), heardJob?.record);
  await ear.stop();
} catch (e) {
  results.error = String(e?.stack || e).slice(0, 900);
} finally {
  if (pulse) clearInterval(pulse);
  await browser.close();
}
const failed = Object.entries(results).filter(([, v]) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
