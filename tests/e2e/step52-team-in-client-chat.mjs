// A person on the team writing in a client's chat, from the client's side of the table: it reaches the client's page
// under their own name, live, the team's assistant is handed it, and a client answering that person is left to them.
// Who may write is the database's: owners and developers given the Clients switch, never a client. Fake connection,
// no AI.
//
//   node --experimental-websocket tests/e2e/step52-team-in-client-chat.mjs

import { execFileSync } from "node:child_process";
import { API, APP, KEY, accessToken, inviteLink, join as joinTable, launch, rpc, sleep, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 300)}`; };
const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
const anon = async (fn, args) => { const r = await fetch(`${API}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(args) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const ok = (r) => r.status < 300;
const until = async (fn, ms = 15000) => { for (let i = 0; i < ms / 250; i++) { if (await fn()) return true; await sleep(250); } return false; };
const browser = await launch();
try {
  const owner = await startTable(browser, `maya-${run}@example.test`, "Fernhill Dental", "Maya Stone");
  const t = owner.tableId;
  const dev = await joinTable(browser, await inviteLink(owner.page, "developer"), `sam-${run}@example.test`, "Sam Ali");
  const elena = await joinTable(browser, await inviteLink(owner.page, "client"), `elena-${run}@example.test`, "Elena Ruiz");
  const other = await startTable(browser, `other-${run}@example.test`, "Other Table", "Olive Green");
  const [ot, dt, et, xt] = await Promise.all([owner, dev, elena, other].map((p) => accessToken(p.context)));
  const client = sql(`select id from public.members where table_id = '${t}' and role = 'client'`);
  const samId = sql(`select id from public.members where table_id = '${t}' and display_name = 'Sam Ali'`);
  const lines = () => sql(`select count(*) from public.client_lines where member_id = '${client}'`);

  // Who may write
  check("the client cannot write as the team", !ok(await rpc(et, "team_say", { m: client, words: "hi" })));
  check("someone at another table cannot", !ok(await rpc(xt, "team_say", { m: client, words: "hi" })));
  check("a developer without the switch cannot", !ok(await rpc(dt, "team_say", { m: client, words: "hi" })));
  check("nothing was written by any of them", lines() === "0", lines());
  check("the owner cannot write to someone who is not a client", !ok(await rpc(ot, "team_say", { m: samId, words: "hi" })));
  check("an empty message is refused", !ok(await rpc(ot, "team_say", { m: client, words: "   " })));
  check("a very long one is refused", !ok(await rpc(ot, "team_say", { m: client, words: "x".repeat(4001) })));
  sql(`update public.members set can_clients = true where id = '${samId}'`);
  check("a developer given the switch can", ok(await rpc(dt, "team_say", { m: client, words: "Sam here, welcome." })));
  sql(`update public.members set can_clients = false where id = '${samId}'`);
  const key = ["sk", "ant", "api03", "abcdefghijklmnopqrstuvwxyz012345"].join("-"); // scan:fake
  await rpc(ot, "team_say", { m: client, words: `the key is ${key}` });
  check("a key is hidden before the client could read it", !sql(`select string_agg(body, ' ') from public.client_lines where member_id = '${client}'`).includes(key));
  check("it is logged, without the words", sql(`select count(*) from public.activity where table_id = '${t}' and action = 'client.team_said' and details::text not like '%welcome%'`) === "2");

  // On both screens
  await elena.page.goto(`${APP}/t/${t}`);
  await owner.page.goto(`${APP}/t/${t}?side=client`);
  await owner.page.waitForSelector("[data-testid=client-box]");
  check("the owner has a box on the client's side", await owner.page.isEnabled("[data-testid=client-box]"));
  await dev.page.goto(`${APP}/t/${t}?side=client`);
  await dev.page.waitForSelector("[data-testid=client-box]");
  check("a developer without the switch does not", await dev.page.isDisabled("[data-testid=client-box]"));
  await owner.page.fill("[data-testid=client-box]", "Hi Elena, does Tuesday work for you?");
  await owner.page.keyboard.press("Enter");
  const seenBy = (page, words) => until(async () => (await page.locator("[data-testid=team-line]", { hasText: words }).count()) > 0);
  check("it shows on the owner's side", await seenBy(owner.page, "does Tuesday work"));
  check("and on the client's page", await seenBy(elena.page, "does Tuesday work"));
  check("under their name", (await elena.page.locator("[data-testid=team-line]", { hasText: "does Tuesday work" }).locator("[data-testid=team-person]").textContent()).includes("Maya"));
  check("a client's box stays their own", await elena.page.isEnabled("[data-testid=client-box]") && !(await elena.page.locator("[data-testid=viewing]").count()));
  await elena.page.fill("[data-testid=client-box]", "Tuesday is fine, thanks Maya");
  await elena.page.keyboard.press("Enter");
  check("the owner sees the client's answer", await until(async () => (await owner.page.locator("[data-testid=client-chat]").textContent()).includes("Tuesday is fine")));

  // What the assistant is handed. Elena's words queued a job only with a team AI on, so one is made here.
  sql(`update public.client_lines set waiting = false where member_id = '${client}'`);
  const code = (await rpc(ot, "start_pairing", { t, ai_kind: "claude" })).body;
  const device = (await anon("pair_connection", { code, device_label: "maya" })).body.token;
  sql(`update public.jobs set status = 'skipped' where table_id = '${t}' and kind <> 'client'`);
  sql(`update public.jobs set status = 'skipped' where table_id = '${t}' and kind = 'client'`);
  sql(`update public.connections set last_seen = now() where table_id = '${t}'`);
  await rpc(et, "client_say", { t, body: "see you then", files: [] });
  const claim = async () => { for (let i = 0; i < 40; i++) { const r = (await anon("runner_claim", { token: device, lane: "light" })).body; if (r?.kind === "client") return r; await sleep(250); } return null; };
  const job = await claim();
  check("the assistant is handed the person's line, with their name", job?.history?.some((l) => l.who === "team" && l.name === "Maya Stone" && l.body.includes("does Tuesday work")), job?.history);
  check("and told a person is talking", job?.team_talking === true, job?.team_talking);

  // Left to them
  const before = lines();
  check("staying quiet is taken", ok(await anon("runner_finish", { token: device, job: job.job_id, answer: "", info: { quiet: true, pass_on: false } })));
  check("nothing is said", lines() === before, lines());
  check("nothing goes to the team", sql(`select count(*) from public.requests where member_id = '${client}' and body = 'see you then'`) === "0");
  check("the line is marked, so the page stops thinking", sql(`select quiet from public.client_lines where member_id = '${client}' and body = 'see you then'`) === "t");
  check("the job is done", sql(`select status from public.jobs where id = '${job.job_id}'`) === "done");
  check("the client's page is not left thinking", await until(async () => (await elena.page.locator("[data-testid=thinking]").count()) === 0));

  // Words waiting for an AI are answered by the person, so nothing tells the client to wait or answers them later
  sql(`insert into public.client_lines (table_id, member_id, who, body, by_table, waiting) values ('${t}', '${client}', 'client', 'one line waiting', true, true)`);
  await rpc(ot, "team_say", { m: client, words: "Got it, I am on it." });
  check("a person answering ends the wait", sql(`select waiting from public.client_lines where member_id = '${client}' and body = 'one line waiting'`) === "f");

  // An old conversation is not a person talking, and quiet is then not taken
  sql(`update public.client_lines set created_at = now() - interval '2 hours' where member_id = '${client}' and who = 'team'`);
  await rpc(et, "client_say", { t, body: "one more thing", files: [] });
  const later = await claim();
  check("after a while nobody is talking", later?.team_talking === false, later?.team_talking);
  const said = lines();
  await anon("runner_finish", { token: device, job: later.job_id, answer: "", info: { quiet: true, pass_on: false } });
  check("and a quiet then still answers the client", Number(lines()) > Number(said), lines());

  // The owner trying the test client answers it as themselves too
  await rpc(ot, "add_test_client", { t });
  await owner.page.goto(`${APP}/t/${t}?side=client`);
  await owner.page.locator("[data-testid=viewing] button", { hasText: "Test" }).first().click().catch(() => {});
  const testId = sql(`select id from public.members where table_id = '${t}' and test`);
  await owner.page.waitForSelector("[data-testid=write-as]");
  await owner.page.click("[data-testid=write-as]");
  await owner.page.fill("[data-testid=client-box]", "Answering the test client");
  await owner.page.keyboard.press("Enter");
  check("the owner can answer the test client as themselves", await until(() => sql(`select count(*) from public.client_lines where member_id = '${testId}' and who = 'team' and from_name = 'Maya Stone'`) === "1"));

  // "Elena wrote" under People, until they have opened the chat
  const badge = (page) => page.locator("[data-testid=wrote-badge]", { hasText: "Elena wrote" });
  await owner.page.goto(`${APP}/t/${t}?side=client`);
  await owner.page.waitForSelector("[data-testid=client-chat]");
  await owner.page.click("[data-testid=table-portal]");
  await owner.page.waitForSelector("[data-testid=me-menu]");
  await owner.page.waitForSelector("[data-live]");
  await dev.page.goto(`${APP}/t/${t}`);
  await dev.page.waitForSelector("[data-live]");
  await until(async () => (await badge(owner.page).count()) === 0, 4000);
  if (await badge(owner.page).count()) { sql(`update public.client_chat_reads set read_at = now() where client_id = '${client}'`); await owner.page.reload(); await owner.page.waitForSelector("[data-live]"); }
  check("nothing new, no marker", (await badge(owner.page).count()) === 0);
  await rpc(et, "client_say", { t, body: "are you there?", files: [] });
  check("the client writing shows under People, live", await until(async () => (await badge(owner.page).count()) === 1));
  check("the tab counts it", await until(async () => /^\(1\) /.test(await owner.page.title()), 4000), await owner.page.title());
  check("a developer without the switch has no marker", (await dev.page.locator("[data-testid=wrote-badge]").count()) === 0);
  check("nor can they read it", ((await rpc(dt, "clients_wrote", { t })).body ?? []).length === 0);
  check("a client reads nothing from it", ((await rpc(et, "clients_wrote", { t })).body ?? []).length === 0);
  check("nor does another table", ((await rpc(xt, "clients_wrote", { t })).body ?? []).length === 0);
  check("the client cannot mark it read", !ok(await rpc(et, "client_chat_read", { m: client, upto: new Date().toISOString() })));
  check("nor can the developer", !ok(await rpc(dt, "client_chat_read", { m: client, upto: new Date().toISOString() })));
  const direct = await fetch(`${API}/rest/v1/client_chat_reads?select=*`, { headers: { apikey: KEY, Authorization: `Bearer ${ot}` } });
  check("where someone has read to is not readable directly", direct.status >= 400, direct.status);
  await badge(owner.page).click();
  check("pressing it opens that client's chat", await until(async () => (await owner.page.locator("[data-testid=client-chat]").textContent().catch(() => "")).includes("are you there?")));
  await owner.page.click("[data-testid=table-portal]");
  await owner.page.waitForSelector("[data-testid=me-menu]");
  check("back at the table it is gone", (await badge(owner.page).count()) === 0);
  check("and the tab's count with it", await until(async () => !/^\(\d+\) /.test(await owner.page.title()), 4000), await owner.page.title());
  await sleep(500);
  await owner.page.reload();
  await owner.page.waitForSelector("[data-live]");
  await sleep(800);
  check("and stays gone after a reload, on any device", (await badge(owner.page).count()) === 0);
  sql(`insert into public.client_lines (table_id, member_id, who, body, by_table) values ('${t}', '${client}', 'client', 'private words to my own assistant', false)`);
  await sleep(1500);
  check("a line to the client's own assistant never shows", (await badge(owner.page).count()) === 0);
  sql(`insert into public.client_lines (table_id, member_id, who, body, by_table) values ('${t}', '${client}', 'team', 'from the team', true)`);
  await sleep(1000);
  check("the team's own line is no news", (await badge(owner.page).count()) === 0);
  await rpc(et, "client_say", { t, body: "one last thing", files: [] });
  check("writing again brings it back", await until(async () => (await badge(owner.page).count()) === 1));
} finally {
  await browser.close();
}
let failed = 0;
for (const [name, r] of Object.entries(results)) { console.log(`${r === "pass" ? "pass" : "FAIL"}  ${name}${r === "pass" ? "" : ` ${r}`}`); if (r !== "pass") failed++; }
console.log(`\n${failed ? `${failed} failed` : `all ${Object.keys(results).length} passed`}`);
process.exit(failed ? 1 : 0);
