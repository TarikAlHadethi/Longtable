// A person's own commands and skills stay theirs (18 Oct 2026), against the database with stand-in connections.
//   Only the person reads their own list; a teammate, a client and the team's live channel never see it; and an AI
//   that is not the asker's own is told only the name typed in the chat, never what the command is for. Commands
//   every Claude has built in are the same for everyone and are still described.
//
//   node --experimental-websocket tests/e2e/step33-own-commands.mjs

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
// The columns the team's screens read (CONNECTION_COLUMNS in the web app).
const CONNECTION_COLUMNS = "id,member_id,kind,last_seen,revoked_at,created_at,limits,model_choice,open_paths,share_paths";
const SECRET_LINE = "Deploy the clinic site with the house checklist";

const browser = await launch();
let pulse = null;
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Own commands", "Maya Stone");
  const { tableId } = owner;
  const sam = await joinTable(browser, await inviteLink(owner.page, "developer"), `sam-${run}@example.test`, "Sam Ali");
  const elena = await joinTable(browser, await inviteLink(owner.page, "client"), `elena-${run}@example.test`, "Elena");
  const tok = { maya: await accessToken(owner.context), sam: await accessToken(sam.context), elena: await accessToken(elena.context) };
  const device = {};
  for (const [who, t] of [["maya", tok.maya], ["sam", tok.sam]]) {
    const code = (await rpc(t, "start_pairing", { t: tableId, ai_kind: "claude" })).body;
    device[who] = (await anon("pair_connection", { code, device_label: "own" })).body.token;
  }
  sql(`update public.jobs set status = 'skipped' where table_id = '${tableId}' and kind = 'intro'`);
  const hello = () => Promise.all(Object.values(device).map((d) => anon("runner_hello", { token: d })));
  await hello();
  pulse = setInterval(hello, 8000);

  // The team's live channel, listening before Maya's list arrives.
  const ear = await listen(tok.sam, `team:${tableId}`);
  const told = await anon("runner_commands", { token: device.maya, list: [
    { name: "ship-clinic", about: SECRET_LINE, kind: "command" },
    { name: "security-review", about: "Look over the code for security problems", kind: "builtin" },
  ] });
  check("Maya's connection tells the table her list", told.body === 2, told);
  await sleep(1500);

  const hers = (await rpc(tok.maya, "my_commands", { t: tableId })).body;
  check("Maya reads her own list", Array.isArray(hers) && hers.some((c) => c.name === "ship-clinic" && c.about === SECRET_LINE), hers);
  const samsView = (await rpc(tok.sam, "my_commands", { t: tableId })).body;
  check("Sam asking for his own list gets his, not Maya's", Array.isArray(samsView) && !JSON.stringify(samsView).includes("ship-clinic"), samsView);
  const elenaView = (await rpc(tok.elena, "my_commands", { t: tableId })).body;
  check("a client gets nothing of Maya's", !JSON.stringify(elenaView ?? "").includes("ship-clinic"), elenaView);
  const direct = await rest(tok.sam, `connections?select=commands&table_id=eq.${tableId}`);
  check("Sam cannot read anyone's list straight from the database", direct.status >= 400 && !JSON.stringify(direct.body).includes("ship-clinic"), direct);
  const ownDirect = await rest(tok.maya, `connections?select=commands&table_id=eq.${tableId}`);
  check("not even Maya reads it that way: only through her own list", ownDirect.status >= 400, ownDirect.status);
  const screens = await rest(tok.sam, `connections?select=${CONNECTION_COLUMNS.replace(/\s/g, "")}&table_id=eq.${tableId}`);
  check("the team's screens still load everyone's connections", screens.status === 200 && screens.body.length === 2 && !JSON.stringify(screens.body).includes("ship-clinic"), screens.status);
  check("the team's live channel heard the connection change", ear.heard.some((m) => m?.table === "connections"), ear.heard.map((m) => m?.table));
  check("and never carried the list", !JSON.stringify(ear.heard).includes("ship-clinic") && !JSON.stringify(ear.heard).includes(SECRET_LINE));
  await ear.stop();

  // Maya runs her own command at the table. Sam's AI gives its view: it gets the name she typed, never what it is for.
  const general = (await rest(tok.maya, `chats?select=id&table_id=eq.${tableId}&is_general=is.true`)).body[0].id;
  const claims = async (body) => {
    await rpc(tok.maya, "ask_table", { c: general, body });
    const got = { maya: null, sam: null };
    for (let i = 0; i < 40 && (!got.maya || !got.sam); i++) {
      for (const who of ["maya", "sam"]) {
        if (got[who]) continue;
        for (const lane of ["light", "heavy"]) {
          const j = (await anon("runner_claim", { token: device[who], lane })).body;
          if (j?.job_id && j.question === body) got[who] = j;
          if (j?.job_id) await anon("runner_finish", { token: device[who], job: j.job_id, answer: "done", info: { view: "done", mine: "all of it", handoffs: [] } });
          if (got[who]) break;
        }
      }
      if (!got.maya || !got.sam) await sleep(400);
    }
    return got;
  };
  const own = await claims("/ship-clinic the booking page");
  check("Maya's own AI is told it is hers and what it is for", own.maya?.command?.mine === true && own.maya.command.about === SECRET_LINE, own.maya?.command);
  check("Sam's AI is told only the name she typed", own.sam?.command?.name === "ship-clinic" && own.sam.command.mine === false && !("about" in own.sam.command), own.sam?.command);
  check("nothing in Sam's AI's job holds what her command is for", !!own.sam && !JSON.stringify(own.sam).includes(SECRET_LINE));
  await sleep(1500);
  const built = await claims("/security-review the sign-in page");
  check("a built-in command is described to any AI", built.sam?.command?.name === "security-review" && /security/i.test(built.sam.command.about || ""), built.sam?.command);

  // Sam types Maya's command: it is not his, so nothing of hers comes with it.
  await rpc(tok.sam, "ask_table", { c: general, body: "/ship-clinic now" });
  let samsJob = null;
  for (let i = 0; i < 30 && !samsJob; i++) {
    for (const who of ["maya", "sam"]) for (const lane of ["light", "heavy"]) {
      const j = (await anon("runner_claim", { token: device[who], lane })).body;
      if (j?.job_id && j.question === "/ship-clinic now") samsJob = samsJob ?? j;
      if (j?.job_id) await anon("runner_finish", { token: device[who], job: j.job_id, answer: "fine", info: { view: "fine", mine: "all", handoffs: [] } });
    }
    if (!samsJob) await sleep(400);
  }
  check("Sam typing Maya's command runs nothing of hers", !!samsJob && !samsJob.command && !JSON.stringify(samsJob).includes(SECRET_LINE), samsJob?.command);

  // A list belongs to its connection: connecting again (another Claude sign-in) starts empty, Disconnect empties it.
  const oldDevice = device.maya;
  const code = (await rpc(tok.maya, "start_pairing", { t: tableId, ai_kind: "claude" })).body;
  device.maya = (await anon("pair_connection", { code, device_label: "another account" })).body.token;
  await anon("runner_hello", { token: device.maya });
  const afterReconnect = (await rpc(tok.maya, "my_commands", { t: tableId })).body;
  check("connecting again starts with no commands", Array.isArray(afterReconnect) && afterReconnect.length === 0, afterReconnect);
  check("the ended connection keeps none of them", sql(`select count(*) from public.connections where table_id = '${tableId}' and revoked_at is not null and commands <> '[]'::jsonb`) === "0");
  const stale = await anon("runner_commands", { token: oldDevice, list: [{ name: "ship-clinic", about: SECRET_LINE, kind: "command" }] });
  check("the old connection cannot put its list back", stale.status >= 400 && (await rpc(tok.maya, "my_commands", { t: tableId })).body.length === 0, stale);
  await anon("runner_commands", { token: device.maya, list: [{ name: "fresh-one", about: "From the new sign-in", kind: "command" }] });
  check("the new connection's own list shows", (await rpc(tok.maya, "my_commands", { t: tableId })).body.some((c) => c.name === "fresh-one"));
  const connId = sql(`select id from public.connections where table_id = '${tableId}' and member_id = (select id from public.members where table_id = '${tableId}' and display_name = 'Maya Stone') and revoked_at is null`);
  await rpc(tok.maya, "disconnect", { conn: connId });
  const afterDisconnect = (await rpc(tok.maya, "my_commands", { t: tableId })).body;
  check("Disconnect empties the list", Array.isArray(afterDisconnect) && afterDisconnect.length === 0 && sql(`select commands::text from public.connections where id = '${connId}'`) === "[]", afterDisconnect);
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
