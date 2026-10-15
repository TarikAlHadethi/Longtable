// The design choices of 16 Oct 2026 (group 4), against the database and the screens, with stand-in connections.
//   Ten connect codes an hour per person. A copy is given only with both ticks, and who ticked is kept.
//   A GitHub delivery sent twice posts once. A message's time is the server's. A repository address with a sign-in
//   in it is refused. An account that made a table can be deleted; the table stays.
//   200 MB of attachments per person per table. The owner may remove any of the table's files; nobody else may
//   remove someone else's.
//   Code in an answer is shown as code: a "#" line inside it is not made a heading.
//
//   node --experimental-websocket tests/e2e/step31-design.mjs

import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { accessToken, API, APP, inviteLink, join as joinTable, KEY, launch, rest, rpc, sleep, startTable } from "./lib.mjs";

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
// Storage, as a person: upload, sign, remove.
const store = async (token, method, path, body, type = "text/plain") => {
  const res = await fetch(`${API}/storage/v1/object/${path}`, { method, headers: { apikey: KEY, Authorization: `Bearer ${token}`, "Content-Type": type }, body });
  const text = await res.text();
  let out = null;
  try { out = JSON.parse(text); } catch { out = text; }
  return { status: res.status, body: out };
};

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Design", "Maya");
  const { tableId } = owner;
  const dev = await joinTable(browser, await inviteLink(owner.page, "developer"), `dev-${run}@example.test`, "Sam");
  const token = await accessToken(owner.context);
  const devToken = await accessToken(dev.context);
  const people = (await rest(token, `members?select=id,display_name,user_id&table_id=eq.${tableId}`)).body;
  const maya = people.find((m) => m.display_name === "Maya");
  const sam = people.find((m) => m.display_name === "Sam");
  const general = (await rest(token, `chats?select=id&table_id=eq.${tableId}&is_general=is.true`)).body[0].id;

  // ---- Ten connect codes an hour
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push(await rpc(devToken, "start_pairing", { t: tableId, ai_kind: "claude" }));
  check("ten connect codes an hour are made, the eleventh is refused in words", codes.slice(0, 10).every((c) => c.status < 300) && codes[10].status >= 400 && /ten connect codes/.test(JSON.stringify(codes[10].body)), codes[10]);

  // ---- A message's time is the server's
  const old = await rest(token, "messages", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ table_id: tableId, chat_id: general, member_id: maya.id, body: "from the past", created_at: "2001-01-01T00:00:00Z" }) });
  const at = new Date(old.body?.[0]?.created_at || 0).getTime();
  check("a message written with a made-up time gets the server's time", Math.abs(at - Date.now()) < 120000, old.body);

  // ---- A repository address with a sign-in in it is refused
  const withSecret = await rpc(token, "set_table_repo", { t: tableId, url: "https://maya:ghp_madeUp123@github.com/acme/app.git" }); // scan:fake
  const plain = await rpc(token, "set_table_repo", { t: tableId, url: "https://github.com/acme/app.git" });
  const ssh = await rpc(token, "set_table_repo", { t: tableId, url: "git@github.com:acme/app.git" });
  check("a repository address with a sign-in in it is refused, a plain one and git@ are kept", withSecret.status >= 400 && /sign-in in it/.test(JSON.stringify(withSecret.body)) && plain.status < 300 && ssh.status < 300, [withSecret.body, plain.status, ssh.status]);

  // ---- A GitHub delivery sent twice posts once
  const secret = (await rpc(token, "connect_github", { t: tableId })).body;
  const payload = JSON.stringify({ ref: "refs/heads/main", repository: { full_name: "acme/app", default_branch: "main" }, pusher: { name: "Sam" }, commits: [{ id: "a" }], head_commit: { message: `Replay check ${run}` } });
  const signature = "sha256=" + createHmac("sha256", secret || "x").update(payload).digest("hex");
  const first = await anon("github_event", { t: tableId, signature, event: "push", payload, delivery: `d-${run}` });
  const again = await anon("github_event", { t: tableId, signature, event: "push", payload, delivery: `d-${run}` });
  const lines = (await rest(token, `messages?select=id&table_id=eq.${tableId}&body=like.*Replay check ${run}*`)).body.length;
  check("a GitHub delivery sent a second time is ignored, so it posts once", !!secret && first.body === "posted" && again.body === "ignored" && lines === 1, [first.body, again.body, lines]);

  // ---- 200 MB of attachments per person per table, and who may remove a file
  const path = (who, name) => `attachments/${tableId}/${who.id}/${crypto.randomUUID()}-${name}`;
  const mine = path(sam, "note.txt");
  const up = await store(devToken, "POST", mine, "a small note");
  const signed = await fetch(`${API}/storage/v1/object/sign/${mine}`, { method: "POST", headers: { apikey: KEY, Authorization: `Bearer ${devToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 3600 }) }).then((r) => r.json());
  const file = { path: mine.replace(/^attachments\//, ""), name: "note.txt", mime: "text/plain", size: 12, url: `${API}/storage/v1${signed.signedURL}` };
  sql(`insert into public.attachments (table_id, member_id, message_id, path, name, mime, size, kind)
       values ('${tableId}', '${sam.id}', null, '${tableId}/${sam.id}/${crypto.randomUUID()}-big.bin', 'big.bin', 'application/octet-stream', ${200 * 1024 * 1024 - 5}, 'file')`);
  const over = await rpc(devToken, "send_with_files", { c: general, body: "one more", files: [file] });
  check("past 200 MB of attachments at a table, the next one is refused in words", up.status < 300 && over.status >= 400 && /200 MB/.test(JSON.stringify(over.body)), [up.status, over.body]);
  const byDev = await store(devToken, "DELETE", `attachments`, JSON.stringify({ prefixes: [] }), "application/json");
  void byDev;
  const mayasFile = path(maya, "plan.txt");
  await store(token, "POST", mayasFile, "the owner's plan");
  const devRemoves = await fetch(`${API}/storage/v1/object/attachments`, { method: "DELETE", headers: { apikey: KEY, Authorization: `Bearer ${devToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: [mayasFile.replace(/^attachments\//, "")] }) }).then((r) => r.json());
  const stillThere = sql(`select count(*) from storage.objects where bucket_id = 'attachments' and name = '${mayasFile.replace(/^attachments\//, "")}'`);
  check("someone else's file cannot be removed by a developer", stillThere === "1", devRemoves);
  const ownerRemoves = await fetch(`${API}/storage/v1/object/attachments`, { method: "DELETE", headers: { apikey: KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: [mine.replace(/^attachments\//, "")] }) }).then((r) => r.json());
  const goneNow = sql(`select count(*) from storage.objects where bucket_id = 'attachments' and name = '${mine.replace(/^attachments\//, "")}'`);
  check("the owner may remove any file of the table", goneNow === "0", ownerRemoves);

  // ---- Code in an answer is shown as code
  const code = (await rpc(token, "start_pairing", { t: tableId, ai_kind: "claude" })).body;
  const device = (await anon("pair_connection", { code, device_label: "design" })).body.token;
  sql(`update public.jobs set status = 'skipped' where table_id = '${tableId}' and kind = 'intro'`);
  await anon("runner_hello", { token: device });
  await rpc(token, "ask_table", { c: general, body: "Show me the start of the config" });
  let job = null;
  for (let i = 0; i < 30 && !job; i++) { const j = (await anon("runner_claim", { token: device, lane: "heavy" })).body; if (j?.job_id) job = j; else await sleep(500); }
  await anon("runner_finish", { token: device, job: job.job_id, answer: "Here it is:\n\n```\n# not a heading\n- not a bullet\nconst x = 1;\n```\n\nThat is all.", info: { read: "main @ abc1234" } });
  const p = owner.page;
  await p.goto(`${APP}/t/${tableId}?c=general`);
  const block = await p.waitForSelector("[data-ai='true'] pre.code-block", { timeout: 20000 }).then((el) => el.textContent()).catch(() => null);
  const heading = await p.locator("[data-ai='true'] strong:has-text('not a heading')").count();
  check("code in an answer is shown as code, its # and - lines as written", !!block && block.includes("# not a heading") && block.includes("- not a bullet") && heading === 0, block);

  // ---- A copy is given only with both ticks, and who ticked is kept
  const client = await joinTable(browser, await inviteLink(owner.page, "client"), `client-${run}@example.test`, "Elena");
  void client;
  const elena = (await rest(token, `members?select=id&table_id=eq.${tableId}&display_name=eq.Elena`)).body[0];
  sql(`insert into public.sandboxes (member_id, table_id, mode, branch, url) values ('${elena.id}', '${tableId}', 'chat', 'longtable/sandbox-elena', 'https://elena.example.test')`);
  const one = await rpc(token, "set_client_sandbox", { m: elena.id, enabled: true, made_up_data: true });
  const both = await rpc(token, "set_client_sandbox", { m: elena.id, enabled: true, made_up_data: true, no_real_keys: true });
  const kept = sql(`select ticked_by::text = '${maya.id}' and ticked_at is not null from public.sandboxes where member_id = '${elena.id}'`);
  check("a copy is not given with one tick, is with both, and who ticked is kept", one.status >= 400 && both.status < 300 && kept === "t", [one.body, both.status, kept]);

  // ---- An account that made a table can be deleted; the table stays
  const other = await startTable(browser, `leaver-${run}@example.test`, "Left behind", "Lee");
  const leaver = sql(`select created_by from public.tables where id = '${other.tableId}'`);
  const del = (() => { try { sql(`delete from auth.users where id = '${leaver}'`); return "ok"; } catch (e) { return String(e.message).slice(0, 200); } })();
  const after = sql(`select coalesce(created_by::text, 'none') from public.tables where id = '${other.tableId}'`);
  check("an account that made a table can be deleted, and the table stays without the link", del === "ok" && after === "none", [del, after]);
} catch (e) {
  results.error = String(e?.stack || e).slice(0, 900);
} finally {
  await browser.close();
}
const failed = Object.entries(results).filter(([, v]) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
