// A chat no AI hears ("No AI"), against the database with stand-in connections and on the screen: what is said
// there is never heard, never noted, never handed to any AI's job (its own chat's history, related messages from
// other chats, messages passed to a running job), not even after the room is changed back; no job can be made for
// it; asking there only says; General cannot be off; it never takes clients' requests; the room shows no thinking.
//
//   node --experimental-websocket tests/e2e/step53-no-ai.mjs

import { execFileSync } from "node:child_process";
import { accessToken, API, inviteLink, join as joinTable, KEY, launch, rest, rpc, sleep, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 400)}`; };
const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
const sqlFails = (q) => { try { sql(q); return ""; } catch (e) { return String(e.stderr || e.message); } };
const anon = async (fn, args) => {
  const res = await fetch(`${API}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
};
const ok = (r) => r.status < 300;
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(400); } return v; };
const SECRET = `zebrafig${run}`;

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Quiet", "Maya Stone");
  const T = owner.tableId;
  const sam = await joinTable(browser, await inviteLink(owner.page, "developer"), `sam-${run}@example.test`, "Sam Ali");
  const tok = { maya: await accessToken(owner.context), sam: await accessToken(sam.context) };
  const device = {};
  for (const [who, t] of [["maya", tok.maya], ["sam", tok.sam]]) {
    const code = (await rpc(t, "start_pairing", { t: T, ai_kind: "claude" })).body;
    device[who] = (await anon("pair_connection", { code, device_label: "quiet" })).body.token;
    await anon("runner_hello", { token: device[who] });
  }
  sql(`update public.jobs set status = 'skipped' where table_id = '${T}' and kind = 'intro'`);
  const general = sql(`select id from public.chats where table_id = '${T}' and is_general`);
  const mayaId = sql(`select id from public.members where table_id = '${T}' and display_name = 'Maya Stone'`);
  // A plain message goes in the way the room sends one.
  const say = (c, body) => rest(tok.maya, "messages", { method: "POST", body: JSON.stringify({ table_id: T, chat_id: c, member_id: mayaId, body }) });
  const setup = (c, answers, notes = false) => rpc(tok.maya, "setup_chat", { c, chat_name: "Priv", chat_about: "", who: "everyone", people: [], take_notes: notes, ai_answers: answers });

  // ---- set up exactly as picked
  const made = await rpc(tok.maya, "make_chat", { t: T, chat_name: "Priv", chat_about: "", who: "everyone", people: [], take_notes: true, ai_answers: "off" });
  const priv = made.body;
  check("a room set to no AI is saved as no AI, with no note-taker", ok(made) && sql(`select answers || notes::text from public.chats where id = '${priv}'`) === "offfalse", made.body);
  const gen = await setup(general, "off");
  check("General cannot be a room no AI hears", gen.status >= 400 && sql(`select answers from public.chats where id = '${general}'`) !== "off", gen.body);

  // ---- nothing said there is heard
  const said = await say(priv, `the flamingo key is ${SECRET}, can you check it?`);
  const asked = await rpc(tok.maya, "ask_table", { c: priv, body: `@claude is the flamingo key ${SECRET} right?` });
  check("asking there only says: the message is kept, no work starts", ok(asked) && asked.body?.answered_by === null, asked.body);
  await sleep(4000);
  check("every message there is marked for no AI", sql(`select count(*) filter (where not no_ai) || '/' || count(*) from public.messages where chat_id = '${priv}'`) === "0/2", sql(`select no_ai from public.messages where chat_id = '${priv}'`));
  check("nothing is waiting to hear it, and no job was made for it", sql(`select count(*) from public.listens where chat_id = '${priv}'`) === "0" && sql(`select count(*) from public.jobs where chat_id = '${priv}'`) === "0", { said: said.status });
  const tripped = sqlFails(`insert into public.jobs (table_id, chat_id, member_id, kind) select '${T}', '${priv}', id, 'listen' from public.members where table_id = '${T}' and display_name = 'Maya Stone'`);
  check("no path can make an AI job for it", /no AI hears this chat/.test(tripped), tripped);
  sql(`update public.messages set no_ai = false where chat_id = '${priv}'`);
  check("the mark cannot be taken off", sql(`select bool_and(no_ai)::text from public.messages where chat_id = '${priv}'`) === "true");

  // ---- changed back, what was said while it was off still never reaches an AI
  check("changing the room back is allowed", ok(await setup(priv, "normal")));
  const later = await say(priv, "hello again everyone");
  check("what is said after it is changed back is heard as usual", ok(later) && sql(`select no_ai::text from public.messages where chat_id = '${priv}' order by created_at desc limit 1`) === "false");
  // The questions share words with what was said while it was off, so a related-message search would find it.
  await rpc(tok.maya, "ask_table", { c: priv, body: "what did I say about the flamingo key earlier here?" });
  await rpc(tok.maya, "ask_table", { c: general, body: "where is the flamingo key written down?" });
  const claims = [];
  await until(async () => {
    for (const who of ["maya", "sam"]) for (const lane of ["heavy", "light"]) {
      const j = (await anon("runner_claim", { token: device[who], lane })).body;
      if (j?.job_id) claims.push(j);
    }
    return claims.length >= 2;
  }, 30000);
  const inContext = claims.filter((j) => JSON.stringify([j.history, j.related]).includes(SECRET));
  // The control: the same jobs do get what was said after it was changed back, so the search above really ran.
  const seesLater = claims.some((j) => JSON.stringify(j.history ?? []).includes("hello again everyone"));
  check("no AI job is handed what was said while it was off, in its chat or from another", claims.length >= 2 && inContext.length === 0 && seesLater, { claims: claims.length, kinds: claims.map((j) => j.kind), inContext: inContext.length, seesLater });

  // ---- open work ends when a room is turned off, and a no-AI room never takes clients' requests
  const busy = await rpc(tok.maya, "ask_table", { c: priv, body: "one more thing to look at please" });
  const openBefore = Number(sql(`select count(*) from public.jobs where chat_id = '${priv}' and status in ('queued', 'running', 'waiting')`));
  check("turning it off again works", ok(await setup(priv, "off")));
  check("turning it off ends the work open in it", openBefore > 0 && sql(`select count(*) from public.jobs where chat_id = '${priv}' and status in ('queued', 'running', 'waiting')`) === "0", { busy: busy.status, openBefore });
  check("turning it off marks everything said there for no AI, for good", sql(`select bool_and(no_ai)::text from public.messages where chat_id = '${priv}'`) === "true");
  const routed = sqlFails(`update public.tables set client_chat = '${priv}' where id = '${T}'`);
  check("clients' requests can never go to it", /cannot go to a chat no AI hears/.test(routed), routed);

  // ---- the screen: no thinking, and it says so
  await owner.page.goto(`${owner.page.url().split("?")[0]}?c=${priv}`);
  await owner.page.waitForSelector('[data-testid="no-ai"]', { timeout: 15000 });
  await owner.page.fill("textarea", "listen for anything that needs keys, can you put them in here?");
  await owner.page.keyboard.press("Enter");
  await sleep(2500);
  const thinking = await owner.page.locator("text=Thinking").count();
  check("the room shows no thinking and says no AI hears it", thinking === 0 && (await owner.page.locator('[data-testid="no-ai"]').count()) === 1, { thinking });
} finally {
  await browser.close();
}

const failed = Object.entries(results).filter(([, v]) => v !== "pass");
for (const [k, v] of Object.entries(results)) console.log(`${v === "pass" ? "pass" : "FAIL"}  ${k}${v === "pass" ? "" : "  " + v.slice(5)}`);
console.log(`\n${Object.keys(results).length - failed.length} of ${Object.keys(results).length} passed`);
process.exit(failed.length ? 1 : 0);
