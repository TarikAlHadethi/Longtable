// The wall, at its edges: what is left behind when a seat is taken away, and what one client's side may carry of
// another's. A removed person can do nothing more, a removed test client leaves nothing for real clients to read,
// one client's words never ride into another client's assistant, and what a client said to an assistant of their
// own stays out of the team's. Fake connections hold each step still: no AI is asked anything.
//
//   node --experimental-websocket tests/e2e/step25-wall.mjs

import { execFileSync } from "node:child_process";
import { accessToken, API, inviteLink, join as joinTable, KEY, launch, rest, rpc, sleep, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "")}`.slice(0, 700); };
const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
const anon = async (fn, args) => { const r = await fetch(`${API}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(args) }); return { status: r.status, body: await r.json().catch(() => null) }; };

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Booking app", "Maya");
  const table = owner.tableId;
  const sam = await joinTable(browser, await inviteLink(owner.page, "developer"), `sam-${run}@example.test`, "Sam");
  const lee = await joinTable(browser, await inviteLink(owner.page, "developer"), `lee-${run}@example.test`, "Lee");
  const elena = await joinTable(browser, await inviteLink(owner.page, "client"), `elena-${run}@example.test`, "Elena Ruiz");
  const priya = await joinTable(browser, await inviteLink(owner.page, "client"), `priya-${run}@example.test`, "Priya Shah");
  const tokens = { Maya: await accessToken(owner.context), Sam: await accessToken(sam.context), Lee: await accessToken(lee.context), Elena: await accessToken(elena.context), Priya: await accessToken(priya.context) };
  const members = (await rest(tokens.Maya, `members?select=id,display_name&table_id=eq.${table}`)).body;
  const id = (name) => members.find((m) => m.display_name.startsWith(name)).id;
  const chat = (await rest(tokens.Maya, `chats?select=id&table_id=eq.${table}`)).body[0].id;
  const device = {};
  const pair = async (name) => {
    const code = (await rpc(tokens[name], "start_pairing", { t: table, ai_kind: "claude" })).body;
    device[name] = (await anon("pair_connection", { code, device_label: "wall" })).body.token;
    sql(`update public.jobs set status = 'skipped' where table_id = '${table}' and kind = 'intro'`);
  };
  const pulse = setInterval(() => { for (const d of Object.values(device)) anon("runner_hello", { token: d }); }, 8000);
  const take = async (name, lane) => { for (let i = 0; i < 40; i++) { const j = (await anon("runner_claim", { token: device[name], lane })).body; if (j?.job_id) return j; await sleep(500); } return null; };
  const fin = (name, job, answer, info) => anon("runner_finish", { token: device[name], job: job.job_id, answer, info });

  // ---- a test client that is taken off leaves nothing behind for real clients
  await rpc(tokens.Maya, "add_test_client", { t: table });
  const asked = await rpc(tokens.Maya, "client_say", { t: table, body: "Trying it out: could the title be bigger?" });
  const request = asked.body?.request;
  const decision = (await rpc(tokens.Maya, "create_decision", { c: chat, title: "A bigger title", context: "", origin: "test", affects_client: true, request,
    options: [{ label: "Yes", client_words: "We will make the title bigger.", recommended: true }, { label: "No", client_words: "The title stays as it is." }] })).body;
  const before = (await rest(tokens.Elena, `client_updates?select=body&table_id=eq.${table}`)).body;
  await rpc(tokens.Maya, "remove_test_client", { t: table });
  const after = (await rest(tokens.Elena, `client_updates?select=body&table_id=eq.${table}`)).body;
  check("a real client reads nothing that was said to the test client, before it is taken off or after", !!request && !!decision && before.length === 0 && after.length === 0, { asked: asked.body, decision, before, after });
  const open = sql(`select count(*) from public.decisions where table_id = '${table}' and affects_client and status = 'open'`);
  check("and no decision about the test client's request is left waiting to be told to every client", open === "0", open);

  // ---- a person taken off the table can do nothing more
  const code = (await rpc(tokens.Lee, "start_pairing", { t: table, ai_kind: "claude" })).body;
  await rpc(tokens.Maya, "remove_member", { m: id("Lee") });
  const late = await anon("pair_connection", { code, device_label: "late" });
  check("a connect code made before someone was taken off no longer connects anything", late.status >= 400 && !late.body?.token, { status: late.status, token: !!late.body?.token });

  // ---- what a client said to an assistant of their own is not handed to the team's
  await pair("Elena");
  await anon("runner_hello", { token: device.Elena });
  const own = await rpc(tokens.Elena, "client_say", { t: table, body: "Between us: the budget is the thing I worry about." });
  const hers = await take("Elena", "light");
  await fin("Elena", hers, "Understood, that stays with me.", { pass_on: false });
  const conn = sql(`select id from public.connections where member_id = '${id("Elena")}' and revoked_at is null`);
  await rpc(tokens.Elena, "disconnect", { conn });
  delete device.Elena;
  await pair("Sam");
  await anon("runner_hello", { token: device.Sam });
  await rpc(tokens.Elena, "client_say", { t: table, body: "Where are we on the booking page?" });
  const desk = await take("Sam", "light");
  check("the team's assistant is not handed what a client said to an assistant of their own", !!own.body?.line && !!hers && desk?.kind === "client" && desk.for_team === true
    && !JSON.stringify(desk.history).includes("budget"), desk && { kind: desk.kind, history: desk.history });
  await fin("Sam", desk, "The team is on it.", { pass_on: false });

  // ---- one client's words do not ride into another client's assistant
  const taskId = sql(`insert into public.tasks (table_id, chat_id, member_id, title, branch, status, reference) values ('${table}', '${chat}', '${id("Maya")}',
    'From Priya: make the price list private to me', 'longtable/from-priya-${run}', 'done', '{"client":"Priya Shah","words":"make the price list private to me"}') returning id`).split("\n")[0];
  sql(`insert into public.tasks (table_id, chat_id, member_id, title, branch, status) values ('${table}', '${chat}', '${id("Maya")}', 'Faster search', 'longtable/faster-search-${run}', 'done')`);
  await rpc(tokens.Elena, "client_say", { t: table, body: "What has been finished lately?" });
  const desk2 = await take("Sam", "light");
  const titles = (desk2?.work || []).map((w) => w.title);
  check("a client hears what the team finished, but never work that came from another client's own words", !!taskId && titles.includes("Faster search") && !titles.some((x) => /Priya|price list/.test(x)), titles);
  await fin("Sam", desk2, "Search is faster now.", { pass_on: false });

  clearInterval(pulse);
} catch (e) {
  check("the run did not crash", false, e.stack || String(e));
} finally {
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
process.exit(Object.values(results).some((v) => v !== "pass") ? 1 : 0);
