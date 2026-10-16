// The access sweep (18 Oct 2026): who may see, use or reach what, against the database with stand-in connections.
//
//   node --experimental-websocket tests/e2e/step34-access-sweep.mjs

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
  const owner = await startTable(browser, `owner-${run}@example.test`, "Sweep", "Maya Stone");
  const { tableId } = owner;
  const sam = await joinTable(browser, await inviteLink(owner.page, "developer"), `sam-${run}@example.test`, "Sam Ali");
  const elena = await joinTable(browser, await inviteLink(owner.page, "client"), `elena-${run}@example.test`, "Elena");
  const priya = await joinTable(browser, await inviteLink(owner.page, "client"), `priya-${run}@example.test`, "Priya");
  const tok = { maya: await accessToken(owner.context), sam: await accessToken(sam.context), elena: await accessToken(elena.context), priya: await accessToken(priya.context) };
  const ids = Object.fromEntries(sql(`select display_name || '=' || id from public.members where table_id = '${tableId}'`).split("\n").map((l) => l.split("=")));
  const general = (await rest(tok.maya, `chats?select=id&table_id=eq.${tableId}&is_general=is.true`)).body[0].id;

  // A question to clients is only ever about one client's own request.
  const opts = [{ label: "Ask them", recommended: true, client_words: "Text or email?", asks_client: true, replies: ["Text", "Email"] }, { label: "Wait", recommended: false, client_words: "We will wait." }];
  const general_q = await rpc(tok.maya, "create_decision", { c: general, title: "Reminders", context: "", origin: "", options: opts, tells: true, request: null });
  check("a question to every client at once is refused", general_q.status >= 400, general_q);
  sql(`insert into public.client_updates (table_id, body, replies) values ('${tableId}', 'Old style question for all', '{Yes,No}')`);
  const oldId = sql(`select id from public.client_updates where table_id = '${tableId}' and body = 'Old style question for all'`);
  const reply = await rpc(tok.elena, "client_reply", { u: oldId, choice: 0 });
  check("and a reply to one that is not about the client's own request is refused", reply.status >= 400 && sql(`select coalesce(answer, '') from public.client_updates where id = '${oldId}'`) === "", reply);

  // A client sees the team and themselves, never another client.
  const seen = (await rest(tok.elena, `members?select=display_name&table_id=eq.${tableId}`)).body.map((m) => m.display_name).sort();
  check("a client sees the team and themselves only", JSON.stringify(seen) === JSON.stringify(["Elena", "Maya Stone", "Sam Ali"]), seen);
  const teamSeen = (await rest(tok.sam, `members?select=display_name&table_id=eq.${tableId}`)).body.length;
  check("the team still sees everyone", teamSeen === 4, teamSeen);

  // A client's assistant hears of the team's work only where it is the one real client.
  sql(`insert into public.tasks (table_id, chat_id, title, branch, status) values ('${tableId}', '${general}', 'Priya CSV export', 'longtable/priya-csv-${run.slice(-4)}ab', 'working')`);
  sql(`insert into public.client_lines (table_id, member_id, who, body) values ('${tableId}', '${ids.Elena}', 'client', 'what is under way?')`);
  const line = sql(`select id from public.client_lines where table_id = '${tableId}' and member_id = '${ids.Elena}' order by created_at desc limit 1`);
  const cj = sql(`insert into public.jobs (table_id, member_id, kind, line_id, status) values ('${tableId}', '${ids.Elena}', 'client', '${line}', 'skipped') returning id`).split(/\s/)[0];
  const payload = () => JSON.parse(sql(`select public.client_job_payload(j) from public.jobs j where j.id = '${cj}'`));
  sql(`insert into public.tasks (table_id, chat_id, title, branch, status) values ('${tableId}', '${general}', 'Faster search', 'longtable/faster-search-${run.slice(-4)}cd', 'done')`);
  check("Elena's assistant is never told of work named after another client", !JSON.stringify(payload().work).includes("Priya CSV"), payload().work);
  check("but still hears of the team's work that names nobody", JSON.stringify(payload().work).includes("Faster search"), payload().work);
  sql(`update public.members set removed_at = now() where id = '${ids.Priya}'`);
  check("work named after a client who has left stays hidden too", !JSON.stringify(payload().work).includes("Priya CSV"), payload().work);
  sql(`update public.members set removed_at = null where id = '${ids.Priya}'`);

  // Owner-only settings.
  const repo = await rpc(tok.sam, "set_table_repo", { t: tableId, repo: "https://github.com/someone/else" });
  check("a developer cannot change where the table's code lives", repo.status >= 400, repo);

  // Keys of more kinds are hidden.
  const hidden = sql(`select public.hide_secrets('a sk-proj-abcdefghijklmnopqrstuvwx b sk_live_abcdefghijklmnopqrst c xoxb-1234567890-abcdef d AIzaSyA1234567890abcdefghijklmnopqrstuvw')`); // scan:fake
  check("OpenAI, Stripe, Slack and Google keys are hidden", !/sk-proj-|sk_live_|xoxb-|AIzaSy/.test(hidden), hidden);

  // Rights nobody uses are gone.
  const wide = sql(`select count(*) from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated') and privilege_type in ('TRUNCATE', 'INSERT', 'UPDATE', 'DELETE') and not (table_name = 'messages' and privilege_type = 'INSERT') and table_name in ('messages', 'members', 'tables', 'activity', 'requests', 'client_updates')`);
  check("nobody may write or empty the tables straight", wide === "0", wide);

  // Shared files stop reaching the other AIs when sharing is switched off.
  const devices = {};
  for (const [who, t] of [["maya", tok.maya], ["sam", tok.sam]]) {
    const code = (await rpc(t, "start_pairing", { t: tableId, ai_kind: "claude" })).body;
    devices[who] = (await anon("pair_connection", { code, device_label: "sweep" })).body.token;
    await anon("runner_hello", { token: devices[who] });
  }
  sql(`update public.jobs set status = 'skipped' where table_id = '${tableId}'`);
  await rpc(tok.maya, "ask_table", { c: general, body: "Look at my notes folder please" });
  const q = sql(`select id from public.messages where table_id = '${tableId}' and body = 'Look at my notes folder please'`);
  sql(`insert into public.round_materials (table_id, question_id, member_id, name, body) values ('${tableId}', '${q}', '${ids["Maya Stone"]}', 'notes.md', 'SHARED-TEXT-77')`);
  const samJob = async () => { for (let i = 0; i < 20; i++) { for (const lane of ["light", "heavy"]) { const j = (await anon("runner_claim", { token: devices.sam, lane })).body; if (j?.job_id) return j; } } return null; };
  const before = await samJob();
  check("with sharing on, Sam's AI gets what Maya shared", JSON.stringify(before?.materials ?? []).includes("SHARED-TEXT-77"), before?.kind);
  if (before) sql(`update public.jobs set status = 'queued', lease_until = null where id = '${before.job_id}'`);
  sql(`update public.connections set share_paths = false where member_id = '${ids["Maya Stone"]}' and revoked_at is null`);
  const after = await samJob();
  check("switched off, it no longer does", !!after && !JSON.stringify(after.materials ?? []).includes("SHARED-TEXT-77"), after?.kind);

  // Deleting a client's account takes what they were told with them, never to every client.
  const req = sql(`insert into public.requests (table_id, member_id, title, body) values ('${tableId}', '${ids.Priya}', 'A print button', 'Please add a print button') returning id`).split(/\s/)[0];
  sql(`insert into public.client_updates (table_id, request_id, body) values ('${tableId}', '${req}', 'PRIVATE-TO-PRIYA')`);
  sql(`delete from auth.users where email = 'priya-${run}@example.test'`);
  const leaked = (await rest(tok.elena, `client_updates?select=body&table_id=eq.${tableId}`)).body.map((u) => u.body);
  check("when a client's account is deleted, what they were told does not reach another client", !leaked.includes("PRIVATE-TO-PRIYA") && sql(`select count(*) from public.client_updates where body = 'PRIVATE-TO-PRIYA'`) === "0", leaked);
} catch (e) {
  results.error = String(e?.stack || e).slice(0, 900);
} finally {
  await browser.close();
}
const failed = Object.entries(results).filter(([, v]) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
