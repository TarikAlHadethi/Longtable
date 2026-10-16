// Pages (18 Oct 2026): an AI at the table makes a page; the team opens it in a locked frame, comments, goes back a
// version, keeps shared values; nobody else reaches any of it. Stand-in connection, real screens.
//
//   node --experimental-websocket tests/e2e/step35-pages.mjs

import { execFileSync } from "node:child_process";
import { accessToken, API, inviteLink, join as joinTable, KEY, launch, rest, rpc, sleep, startTable } from "./lib.mjs";

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

// A page that tries everything it must not do, and uses the one thing it may: shared values.
const PAGE_HTML = `<!doctype html><html><head><title>Probe</title></head><body><h1 id="h">Launch plan</h1><p id="out">waiting</p>
<script>
(async function(){
  var r = [];
  try { r.push("parent:" + (parent.document ? "reached" : "none")); } catch (e) { r.push("parent:blocked"); }
  try { localStorage.setItem("x","1"); r.push("storage:reached"); } catch (e) { r.push("storage:blocked"); }
  try { await fetch("https://example.com/"); r.push("fetch:reached"); } catch (e) { r.push("fetch:blocked"); }
  try { document.cookie = "a=1"; r.push("cookie:" + (document.cookie ? "reached" : "blocked")); } catch (e) { r.push("cookie:blocked"); }
  await longtable.set("votes", 3);
  r.push("votes:" + (await longtable.get("votes")));
  r.push("me:" + longtable.me);
  document.getElementById("out").textContent = r.join(" ");
})();
</script></body></html>`;

const browser = await launch();
let pulse = null;
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Pages", "Maya Stone");
  const { tableId, page } = owner;
  if (process.env.DEBUG) { page.on("console", (m) => console.log("console:", m.text().slice(0, 300))); page.on("pageerror", (e) => console.log("pageerror:", e.message)); }
  const sam = await joinTable(browser, await inviteLink(page, "developer"), `sam-${run}@example.test`, "Sam Ali");
  const elena = await joinTable(browser, await inviteLink(page, "client"), `elena-${run}@example.test`, "Elena");
  const tok = { maya: await accessToken(owner.context), sam: await accessToken(sam.context), elena: await accessToken(elena.context) };
  const code = (await rpc(tok.maya, "start_pairing", { t: tableId, ai_kind: "claude" })).body;
  const device = (await anon("pair_connection", { code, device_label: "pages" })).body.token;
  sql(`update public.jobs set status = 'skipped' where table_id = '${tableId}' and kind = 'intro'`);
  pulse = setInterval(() => anon("runner_hello", { token: device }), 8000);
  await anon("runner_hello", { token: device });
  const general = (await rest(tok.maya, `chats?select=id&table_id=eq.${tableId}&is_general=is.true`)).body[0].id;

  await rpc(tok.maya, "ask_table", { c: general, body: "Make me a launch plan page" });
  let job = null;
  for (let i = 0; i < 30 && !job; i++) { for (const lane of ["heavy", "light"]) { const j = (await anon("runner_claim", { token: device, lane })).body; if (j?.job_id) { job = j; break; } } if (!job) await sleep(400); }
  check("the AI gets a job it may make a page from", !!job && ["answer", "look", "work", "combine"].includes(job.kind), job?.kind);
  const made = await anon("runner_page", { token: device, job: job.job_id, page: { title: "Launch plan", about: "Week by week", icon: "plan", html: PAGE_HTML.replace("Launch plan</h1>", "Launch plan sk-ant-api03-ABCDEFGHIJKLMNOP</h1>") } }); // scan:fake
  check("it makes the page", made.status === 200 && typeof made.body === "string", made);
  const pageId = made.body;
  check("a key in a page is hidden before it is kept", !sql(`select html from public.page_versions where page_id = '${pageId}'`).includes("sk-ant-api03"));
  await anon("runner_finish", { token: device, job: job.job_id, answer: "Here is the plan as a page.", info: { sources: [] } });

  // The wall.
  check("the team reads it", (await rest(tok.sam, `pages?select=id&id=eq.${pageId}`)).body.length === 1);
  const clientReads = await Promise.all(["pages", "page_versions", "page_comments", "page_state"].map((t) => rest(tok.elena, `${t}?select=*&table_id=eq.${tableId}`)));
  check("a client reads nothing of any page", clientReads.every((r) => Array.isArray(r.body) && r.body.length === 0), clientReads.map((r) => r.body?.length));
  check("a client cannot comment or keep values on one", (await rpc(tok.elena, "comment_page", { p: pageId, body: "hi" })).status >= 400
    && (await rpc(tok.elena, "set_page_state", { p: pageId, key: "x", value: 1 })).status >= 400);
  const other = await startTable(browser, `other-${run}@example.test`, "Elsewhere", "Olga");
  const otherTok = await accessToken(other.context);
  check("someone at another table reaches nothing", (await rest(otherTok, `pages?select=id&id=eq.${pageId}`)).body.length === 0
    && (await rpc(otherTok, "comment_page", { p: pageId, body: "hi" })).status >= 400 && (await rpc(otherTok, "delete_page", { p: pageId })).status >= 400);
  const stale = await anon("runner_page", { token: device, job: job.job_id, page: { title: "Late", html: "<p>late</p>" } });
  check("a finished job cannot make another page", stale.status >= 400, stale);

  // Comments, versions, deleting.
  const c1 = (await rpc(tok.sam, "comment_page", { p: pageId, body: "Week 2 is too tight", anchor: "Launch plan" })).body;
  const reply = await rpc(tok.maya, "comment_page", { p: pageId, body: "Agreed", parent: c1 });
  check("people comment on words in it, and reply", typeof c1 === "string" && reply.status === 200 && sql(`select anchor from public.page_comments where id = '${c1}'`) === "Launch plan");
  check("a developer cannot take away the owner's reply", (await rpc(tok.sam, "delete_page_comment", { cm: reply.body })).status >= 400);
  check("the owner can take away anyone's", (await rpc(tok.maya, "delete_page_comment", { cm: c1 })).status < 300);
  check("a comment can be resolved", (await rpc(tok.sam, "resolve_page_comment", { cm: reply.body, done: true })).status < 300);
  const before = Number(sql(`select count(*) from public.messages where chat_id = '${general}'`));
  await rpc(tok.sam, "comment_page", { p: pageId, body: "Make the title green", to_ai: true });
  const asked = sql(`select body from public.messages where chat_id = '${general}' order by created_at desc limit 1`);
  check("a comment sent to the AIs asks the table to change the page", Number(sql(`select count(*) from public.messages where chat_id = '${general}'`)) === before + 1 && asked.includes("On the handout \"Launch plan\"") && asked.includes("Make the title green"), asked);
  let next = null;
  for (let i = 0; i < 30 && !next; i++) { for (const lane of ["heavy", "light"]) { const j = (await anon("runner_claim", { token: device, lane })).body; if (j?.job_id) { next = j; break; } } if (!next) await sleep(400); }
  check("that job is handed the page whole, with what was said on it", next?.pages?.[0]?.id === pageId && next.pages[0].html.includes("Launch plan") && JSON.stringify(next.pages[0].comments).includes("Make the title green"), next?.pages?.[0]?.title);
  const v2 = await anon("runner_page", { token: device, job: next.job_id, page: { title: "Launch plan", html: PAGE_HTML.replace("Launch plan</h1>", "Launch plan, in green</h1>"), update: pageId, note: "green title" } });
  check("the AI changes it as a new version", v2.body === pageId && sql(`select version from public.pages where id = '${pageId}'`) === "2");
  await anon("runner_finish", { token: device, job: next.job_id, answer: "Made the title green.", info: { sources: [] } });
  check("going back to version 1 makes a version 3 holding it", (await rpc(tok.sam, "restore_page_version", { p: pageId, n: 1 })).body === 3
    && !sql(`select html from public.page_versions where page_id = '${pageId}' and n = 3`).includes("in green"));
  check("anyone on the team renames it", (await rpc(tok.sam, "rename_page", { p: pageId, title: "Launch plan", about: "Week by week, agreed" })).status < 300
    && sql(`select about from public.pages where id = '${pageId}'`) === "Week by week, agreed");
  check("each person pins it for themselves only", (await rpc(tok.sam, "pin_page", { p: pageId, pinned: true })).status < 300
    && (await rest(tok.sam, `page_pins?select=page_id`)).body.length === 1 && (await rest(tok.maya, `page_pins?select=page_id`)).body.length === 0);
  check("values are limited in size", (await rpc(tok.sam, "set_page_state", { p: pageId, key: "big", value: "x".repeat(70000) })).status >= 400);
  check("a developer cannot delete a page another person's AI made", (await rpc(tok.sam, "delete_page", { p: pageId })).status >= 400);

  // The screens: the card under the answer, the window, the locked frame.
  await page.reload();
  await page.waitForSelector("[data-testid=page-card]", { timeout: 20000 });
  check("the answer carries a card for its page", (await page.textContent("[data-testid=page-card]")).includes("Launch plan"));
  await page.click("[data-testid=page-card]");
  await page.waitForSelector("[data-testid=page-frame]", { timeout: 15000 });
  const sandbox = await page.getAttribute("[data-testid=page-frame]", "sandbox");
  check("the frame has no origin of its own", !!sandbox && !sandbox.includes("allow-same-origin"), sandbox);
  const frame = page.frameLocator("[data-testid=page-frame]");
  let out = "";
  for (let i = 0; i < 30 && !/votes:/.test(out); i++) { out = await frame.locator("#out").textContent().catch(() => ""); await sleep(300); }
  check("inside the frame the page cannot reach the room, its storage, the network or cookies", /parent:blocked/.test(out) && /storage:blocked/.test(out) && /fetch:blocked/.test(out) && /cookie:blocked/.test(out), out);
  check("it keeps a shared value through Longtable, as the person looking", /votes:3/.test(out) && /me:Maya/.test(out) && sql(`select value::text || ' ' || (updated_by = (select id from public.members where table_id = '${tableId}' and display_name = 'Maya Stone'))::text from public.page_state where page_id = '${pageId}' and key = 'votes'`) === "3 true", out);
  const inside = page.frames().find((f) => f !== page.mainFrame() && f.parentFrame() === page.mainFrame());
  await inside.evaluate(() => { window.__stillHere = true; });
  await sleep(9000);
  check("the open page is not reloaded while the room refreshes around it", await inside.evaluate(() => window.__stillHere === true).catch(() => false));
  check("the window shows its comments", (await page.locator("[data-testid=page-comment]").count()) >= 1);
  await page.fill("[data-testid=page-comment-box]", "Looks right now");
  await page.click("[data-testid=page-window] button:has-text('Comment')");
  await sleep(1500);
  check("a comment written in the window is kept", sql(`select count(*) from public.page_comments where page_id = '${pageId}' and body = 'Looks right now'`) === "1");
  await page.click("[data-testid=page-window] button[aria-label=Close]");
  check("the sidebar's Handouts section has it", (await page.textContent("[data-testid=handouts]")).includes("Launch plan"));
  check("the owner deletes it, versions and comments with it", (await rpc(tok.maya, "delete_page", { p: pageId })).status < 300
    && sql(`select count(*) from public.page_versions where page_id = '${pageId}'`) === "0" && sql(`select count(*) from public.page_comments where page_id = '${pageId}'`) === "0");
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
