// Live cursors on pages (16 Oct 2026): two people with the same page open see each other's named pointer, the words
// people commented on are lit in the page, and someone writing a comment is shown. Only the team hears any of it.
//
//   node --experimental-websocket tests/e2e/step37-live-cursors.mjs

import { execFileSync } from "node:child_process";
import { accessToken, API, inviteLink, join as joinTable, KEY, launch, listen, rest, rpc, sleep, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 400)}`; };
const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
const anon = async (fn, args) => (await fetch(`${API}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(args) })).json().catch(() => null);

const PAGE = `<!doctype html><html><head><title>Plan</title></head><body style="margin:0;padding:24px;font-family:system-ui">
<h1>Launch plan</h1><p>Week one is setup. Week two is the launch itself.</p><div style="height:300px;background:#eef"></div></body></html>`;

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Cursors", "Maya Stone");
  const { tableId, page: maya } = owner;
  const sam = await joinTable(browser, await inviteLink(maya, "developer"), `sam-${run}@example.test`, "Sam Ali");
  const elena = await joinTable(browser, await inviteLink(maya, "client"), `elena-${run}@example.test`, "Elena");
  const tok = { maya: await accessToken(owner.context), sam: await accessToken(sam.context), elena: await accessToken(elena.context) };
  const code = (await rpc(tok.maya, "start_pairing", { t: tableId, ai_kind: "claude" })).body;
  const device = (await anon("pair_connection", { code, device_label: "cursors" })).token;
  sql(`update public.jobs set status = 'skipped' where table_id = '${tableId}' and kind = 'intro'`);
  await anon("runner_hello", { token: device });
  const general = (await rest(tok.maya, `chats?select=id&table_id=eq.${tableId}&is_general=is.true`)).body[0].id;
  await rpc(tok.maya, "ask_table", { c: general, body: "Plan page please" });
  let job = null;
  for (let i = 0; i < 30 && !job; i++) { for (const lane of ["heavy", "light"]) { const j = await anon("runner_claim", { token: device, lane }); if (j?.job_id) { job = j; break; } } if (!job) await sleep(400); }
  const pageId = await anon("runner_page", { token: device, job: job.job_id, page: { title: "Launch plan", html: PAGE } });
  await anon("runner_finish", { token: device, job: job.job_id, answer: "Here it is.", info: { sources: [] } });
  await rpc(tok.sam, "comment_page", { p: pageId, body: "Can launch move up?", anchor: "Week two is the launch itself." });

  // The wall around the channel.
  const topic = `cursor:${tableId}`;
  const samEar = await listen(tok.sam, topic);
  const elenaEar = await listen(tok.elena, topic);
  const other = await startTable(browser, `other-${run}@example.test`, "Elsewhere", "Olga");
  const otherEar = await listen(await accessToken(other.context), topic);
  check("the team may listen on the table's cursor channel", samEar.status === "SUBSCRIBED", samEar.status);
  check("a client may not", elenaEar.status !== "SUBSCRIBED", elenaEar.status);
  check("nor anyone at another table", otherEar.status !== "SUBSCRIBED", otherEar.status);
  for (const e of [samEar, elenaEar, otherEar]) await e.stop().catch(() => {});

  // Both open the page.
  for (const p of [maya, sam.page]) {
    await p.setViewportSize({ width: 1400, height: 900 });
    await p.reload();
    await p.waitForSelector("[data-testid=page-card]", { timeout: 20000 });
    await p.click("[data-testid=page-card]");
    await p.waitForSelector("[data-testid=page-frame]");
  }
  await sleep(2500);
  const mayaFrame = maya.frameLocator("[data-testid=page-frame]");
  check("the words someone commented on are lit in the page", (await mayaFrame.locator("mark[data-lt-mark]").textContent({ timeout: 5000 }).catch(() => "")).includes("Week two"));

  // Sam moves over the page.
  const box = await sam.page.locator("[data-testid=page-frame]").boundingBox();
  for (let i = 0; i < 8; i++) { await sam.page.mouse.move(box.x + 100 + i * 20, box.y + 120 + i * 10); await sleep(80); }
  let label = "";
  for (let i = 0; i < 25 && !label; i++) { label = await mayaFrame.locator("[data-lt-cursor] span").first().textContent({ timeout: 300 }).catch(() => ""); await sleep(200); }
  check("Maya sees Sam's pointer on the page, with his name", label === "Sam", label);
  if (process.env.SCREENSHOTS) { await sam.page.click("[data-testid=page-comments-toggle]"); await sam.page.fill("[data-testid=page-comment-box]", "Thinking"); await sleep(1200); await maya.screenshot({ path: `${process.env.SCREENSHOTS}/pages-cursor.png` }); await sam.page.fill("[data-testid=page-comment-box]", ""); }
  const samSelf = await sam.page.frameLocator("[data-testid=page-frame]").locator("[data-lt-cursor]").count();
  check("nobody sees their own pointer drawn twice", samSelf === 0, samSelf);

  // Sam writes a comment.
  if (!(await sam.page.locator("[data-testid=page-comment-box]").count())) await sam.page.click("[data-testid=page-comments-toggle]");
  await sam.page.fill("[data-testid=page-comment-box]", "Thinking about it");
  let writing = "";
  for (let i = 0; i < 20 && !writing; i++) { writing = await maya.locator("[data-testid=page-writing]").textContent({ timeout: 300 }).catch(() => ""); await sleep(200); }
  check("Maya sees that Sam is writing a comment", /Sam is writing a comment/.test(writing), writing);

  // Clicking the lit words in the page brings its comment forward.
  await mayaFrame.locator("mark[data-lt-mark]").click();
  await sleep(500);
  const lit = await maya.locator("[data-testid=page-comment][class*=lit]").count();
  check("pressing the lit words brings their comment forward", lit === 1, lit);

  // Sam closes the page: his pointer goes from Maya's.
  await sam.page.click("[data-testid=page-window] button[aria-label=Close]");
  let gone = false;
  for (let i = 0; i < 25 && !gone; i++) { gone = (await mayaFrame.locator("[data-lt-cursor]").count()) === 0; await sleep(200); }
  check("when Sam closes it, his pointer goes", gone);
} catch (e) {
  results.error = String(e?.stack || e).slice(0, 900);
} finally {
  await browser.close();
}
const failed = Object.entries(results).filter(([, v]) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
