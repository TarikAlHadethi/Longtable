// The table thinking: from the moment someone says something the table will hear, its mark goes round under the
// message until a reply or an AI's work line takes over; never for talk it will not answer.
//
//   node --experimental-websocket tests/e2e/step43-thinking.mjs

import { execFileSync } from "node:child_process";
import { API, KEY, accessToken, launch, rpc, startTable, sleep } from "./lib.mjs";
const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
const run = Date.now().toString(36);
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 300)}`; };
const browser = await launch();
try {
const o = await startTable(browser, `think-${run}@example.test`, "Fernhill Dental", "Maya Stone");
const tok = await accessToken(o.context);
const code = (await rpc(tok, "start_pairing", { t: o.tableId, ai_kind: "claude" })).body;
const device = (await (await fetch(`${API}/rest/v1/rpc/pair_connection`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify({ code, device_label: "x" }) })).json()).token;
sql(`update public.jobs set status='skipped' where table_id='${o.tableId}' and kind='intro'`);
sql(`update public.connections set last_seen=now() where table_id='${o.tableId}'`);
await o.page.reload(); await sleep(2500);
await o.page.locator("textarea").first().fill("claude are you there?");
await o.page.keyboard.press("Enter");
await sleep(400);
const t0 = await o.page.locator("[data-testid=thinking]").count();
await sleep(8000); sql(`update public.connections set last_seen=now() where table_id='${o.tableId}'`);
const t1 = await o.page.locator("[data-testid=thinking]").count();
const listen = sql(`select status from public.jobs where table_id='${o.tableId}' and kind='listen'`);
sql(`update public.jobs set status='done' where table_id='${o.tableId}' and kind='listen'`);
await sleep(5000);
const t2 = await o.page.locator("[data-testid=thinking]").count();
await o.page.locator("textarea").first().fill("ok cool"); await o.page.keyboard.press("Enter"); await sleep(600);
const t3 = await o.page.locator("[data-testid=thinking]").count();
// A room where the AIs only listen never answers, so it never shows the table thinking; one where they answer only
// when named shows it only when they are named.
const general = sql(`select id from public.chats where table_id='${o.tableId}' and is_general`);
sql(`update public.jobs set status='done' where table_id='${o.tableId}' and kind='listen' and status <> 'done'`);
sql(`update public.chats set answers='silent' where id='${general}'`);
await o.page.reload(); await sleep(2500);
await o.page.locator("textarea").first().fill("claude can you check the booking page?"); await o.page.keyboard.press("Enter"); await sleep(600);
const silentRoom = await o.page.locator("[data-testid=thinking]").count();
await sleep(15000); // changing a room's settings takes a while; what was said before is not part of the next ask
sql(`update public.chats set answers='named' where id='${general}'`);
await o.page.reload(); await sleep(2500);
await o.page.locator("textarea").first().fill("what should we do about the booking page tomorrow?"); await o.page.keyboard.press("Enter"); await sleep(600);
const unnamed = await o.page.locator("[data-testid=thinking]").count();
sql(`update public.jobs set status='done' where table_id='${o.tableId}' and kind='listen' and status <> 'done'`);
await o.page.locator("textarea").first().fill("claude what should we do about the booking page?"); await o.page.keyboard.press("Enter"); await sleep(600);
const named = await o.page.locator("[data-testid=thinking]").count();
check("a listen-only room never shows the table thinking", silentRoom === 0, silentRoom);
check("a room that answers only when named shows nothing for an unnamed question", unnamed === 0, unnamed);
check("and shows the table thinking when the AI is named", named === 1, named);
check("the table shows it is thinking the moment a question is sent", t0 === 1, t0);
check("and keeps showing it while the listener has it", t1 === 1 && listen === "queued", { t1, listen });
check("it goes when the table has heard and chosen to say nothing", t2 === 0, t2);
check("small talk between people afterwards shows no thinking", t3 === 0, t3);
} catch (e) { check("the run did not crash", false, e.stack || e.message); }
await browser.close();
console.log(JSON.stringify({ checks: results }, null, 2));
const failed = Object.values(results).filter((v) => v !== "pass").length;
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
