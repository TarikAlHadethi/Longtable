// Pictures of pages: the card under an answer, an open page with comments (light, dark, phone), and the Pages list.
// A stand-in connection makes the page. Writes PNGs to the folder in SCREENSHOTS.
//
//   SCREENSHOTS=<folder> node --experimental-websocket tests/e2e/look-pages.mjs

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { accessToken, API, inviteLink, join as joinTable, KEY, launch, rest, rpc, sleep, startTable } from "./lib.mjs";

const out = process.env.SCREENSHOTS;
if (!out) throw new Error("Set SCREENSHOTS to a folder.");
const run = Date.now().toString(36);
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "")}`.slice(0, 400); };
const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
const anon = async (fn, args) => (await fetch(`${API}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(args) })).json().catch(() => null);

const PAGE = `<!doctype html><html><head><title>Hosting</title><style>
:root{color-scheme:light dark;--bg:#fbfaf7;--ink:#2b2a27;--line:#e4e1da;--accent:#2f6b5e}
@media (prefers-color-scheme:dark){:root{--bg:#1d2321;--ink:#eeece6;--line:#343b38;--accent:#8fd1bf}}
body{margin:0;padding:32px 20px;font-family:system-ui,sans-serif;background:var(--bg);color:var(--ink)}
h1{font-size:22px;margin:0 0 6px}p{margin:0 0 18px;opacity:.75}
table{border-collapse:collapse;width:100%;max-width:640px}td,th{border-bottom:1px solid var(--line);padding:10px 8px;text-align:left}
th{font-weight:600}.v{display:inline-block;margin-top:18px;padding:8px 14px;border-radius:999px;border:1px solid var(--line);cursor:pointer;background:none;color:inherit}
</style></head><body><h1>Hosting, side by side</h1><p>Price, speed and ease for the three we looked at.</p>
<table><tr><th>Host</th><th>Price</th><th>Speed</th><th>Ease</th></tr><tr><td>Vercel</td><td>Free to start</td><td>Fast</td><td>Easiest</td></tr>
<tr><td>Netlify</td><td>Free to start</td><td>Fast</td><td>Easy</td></tr><tr><td>Render</td><td>From $7</td><td>Good</td><td>Easy</td></tr></table>
<button class="v" id="vote">Vote for Vercel: <span id="n">0</span></button>
<script>longtable.get("votes").then(function(v){document.getElementById("n").textContent=v||0});
document.getElementById("vote").onclick=async function(){var v=(await longtable.get("votes"))||0;await longtable.set("votes",v+1);document.getElementById("n").textContent=v+1;};
longtable.on(function(k,v){if(k==="votes")document.getElementById("n").textContent=v;});</script></body></html>`;

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Fernhill site", "Maya Stone");
  const { tableId, page } = owner;
  const sam = await joinTable(browser, await inviteLink(page, "developer"), `sam-${run}@example.test`, "Sam Ali");
  const tok = { maya: await accessToken(owner.context), sam: await accessToken(sam.context) };
  const code = (await rpc(tok.maya, "start_pairing", { t: tableId, ai_kind: "claude" })).body;
  const device = (await anon("pair_connection", { code, device_label: "look" })).token;
  sql(`update public.jobs set status = 'skipped' where table_id = '${tableId}' and kind = 'intro'`);
  await anon("runner_hello", { token: device });
  const general = (await rest(tok.maya, `chats?select=id&table_id=eq.${tableId}&is_general=is.true`)).body[0].id;
  await rpc(tok.maya, "ask_table", { c: general, body: "Can you put the hosting options side by side as a page?" });
  let job = null;
  for (let i = 0; i < 30 && !job; i++) { for (const lane of ["heavy", "light"]) { const j = await anon("runner_claim", { token: device, lane }); if (j?.job_id) { job = j; break; } } if (!job) await sleep(400); }
  const pageId = await anon("runner_page", { token: device, job: job.job_id, page: { title: "Hosting, side by side", about: "Price, speed and ease for Vercel, Netlify and Render", icon: "table", html: PAGE } });
  await anon("runner_finish", { token: device, job: job.job_id, answer: "Here they are side by side. Vercel is the easiest to start with; Render costs a little from the start.", info: { sources: [] } });
  await rpc(tok.sam, "comment_page", { p: pageId, body: "Render has a free tier for static sites too.", anchor: "From $7" });
  const c = sql(`select id from public.page_comments where page_id = '${pageId}' limit 1`);
  await rpc(tok.maya, "comment_page", { p: pageId, body: "Good catch, I will ask for it to be added.", parent: c });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await page.waitForSelector("[data-testid=page-card]", { timeout: 20000 });
  await sleep(600);
  await page.screenshot({ path: join(out, "pages-card.png") });
  await page.click("[data-testid=page-card]");
  await page.waitForSelector("[data-testid=page-frame]");
  await sleep(1500);
  await page.frameLocator("[data-testid=page-frame]").locator("#vote").click();
  await sleep(1200);
  await page.screenshot({ path: join(out, "pages-window.png") });
  check("pressing the page's own button keeps a shared value", sql(`select value::text from public.page_state where page_id = '${pageId}' and key = 'votes'`) === "1");
  await page.emulateMedia({ colorScheme: "dark" });
  await sleep(800);
  await page.screenshot({ path: join(out, "pages-window-dark.png") });
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(800);
  await page.screenshot({ path: join(out, "pages-window-phone.png") });
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check("nothing scrolls sideways on a phone", !sideways);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.click("[data-testid=page-window] button[aria-label=Close]");
  await page.click("[data-testid=pages-link]");
  await sleep(500);
  await page.screenshot({ path: join(out, "pages-list.png") });
} catch (e) {
  results.error = String(e?.stack || e).slice(0, 900);
} finally {
  await browser.close();
}
const failed = Object.entries(results).filter(([, v]) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
