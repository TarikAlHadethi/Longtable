// Loose ends around connections, with no AI asked anything. A client's question is not dropped when the AI that was
// answering it is disconnected or its person is taken off the table: it goes on to the team. What one connection
// shares for a request stays a few files however many times it calls. And someone taken off the table cannot be
// chosen to write the table's answer.
//
//   node --experimental-websocket tests/e2e/step27-loose-ends.mjs

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
  const tokens = { Maya: await accessToken(owner.context), Sam: await accessToken(sam.context), Lee: await accessToken(lee.context), Elena: await accessToken(elena.context) };
  const members = (await rest(tokens.Maya, `members?select=id,display_name&table_id=eq.${table}`)).body;
  const id = (name) => members.find((m) => m.display_name.startsWith(name)).id;
  const chat = (await rest(tokens.Maya, `chats?select=id&table_id=eq.${table}`)).body[0].id;
  const device = {};
  const pair = async (name) => {
    const code = (await rpc(tokens[name], "start_pairing", { t: table, ai_kind: "claude" })).body;
    device[name] = (await anon("pair_connection", { code, device_label: "ends" })).body.token;
    sql(`update public.jobs set status = 'skipped' where table_id = '${table}' and kind = 'intro'`);
    await anon("runner_hello", { token: device[name] });
  };
  const take = async (name, lane) => { for (let i = 0; i < 40; i++) { const j = (await anon("runner_claim", { token: device[name], lane })).body; if (j?.job_id) return j; await sleep(500); } return null; };
  const fin = (name, job, answer, info) => anon("runner_finish", { token: device[name], job: job.job_id, answer, info });
  const asked = async () => (await rest(tokens.Maya, `requests?select=body&table_id=eq.${table}&member_id=eq.${id("Elena")}`)).body.map((r) => r.body);
  const told = () => sql(`select count(*) from public.client_lines where member_id = '${id("Elena")}' and who = 'assistant' and request_id is not null`);

  // ---- a client's question outlives the AI that was answering it
  await pair("Sam");
  await rpc(tokens.Elena, "client_say", { t: table, body: "Could invoices go out on the first of the month?" });
  const conn = sql(`select id from public.connections where member_id = '${id("Sam")}' and revoked_at is null`);
  await rpc(tokens.Sam, "disconnect", { conn });
  delete device.Sam;
  check("a client's question goes on to the team when the AI answering it is disconnected", (await asked()).some((b) => /first of the month/.test(b)) && told() === "1", { asked: await asked(), told: told() });
  await pair("Lee");
  await rpc(tokens.Elena, "client_say", { t: table, body: "And could the logo be a little larger?" });
  await rpc(tokens.Maya, "remove_member", { m: id("Lee") });
  delete device.Lee;
  check("and when the person whose AI was answering is taken off the table", (await asked()).some((b) => /logo be a little larger/.test(b)) && told() === "2", { asked: await asked(), told: told() });

  // ---- what one connection shares for a request stays a few files, however many times it calls
  await pair("Maya");
  await rpc(tokens.Maya, "ask_table", { c: chat, body: 'Summarise the notes in "C:\\Users\\maya\\notes"' });
  const job = await take("Maya", "heavy") ?? await take("Maya", "light");
  for (let call = 0; call < 5; call++) await anon("runner_share", { token: device.Maya, job: job.job_id, files: Array.from({ length: 4 }, (_, i) => ({ name: `C:\\Users\\maya\\notes\\${call}-${i}.md`, body: "A note." })) });
  const kept = sql(`select count(*) from public.round_materials where table_id = '${table}'`);
  const again = await anon("runner_share", { token: device.Maya, job: job.job_id, files: [{ name: "C:\\Users\\maya\\notes\\0-0.md", body: "A newer note." }] });
  check("no more than eight shared files are kept for one request, and one already shared can still be replaced", kept === "8" && again.body === 1
    && sql(`select count(*) from public.round_materials where table_id = '${table}'`) === "8", { kept, again: again.body });
  await fin("Maya", job, "Done.", {});

  // ---- someone taken off the table is not chosen to write its answer
  const seat = await rpc(tokens.Maya, "set_final_seat", { t: table, seat: id("Lee"), offline: "wait" });
  check("someone taken off the table cannot be picked to write the table's answer", seat.status >= 400, seat);
} catch (e) {
  check("the run did not crash", false, e.stack || String(e));
} finally {
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
process.exit(Object.values(results).some((v) => v !== "pass") ? 1 : 0);
