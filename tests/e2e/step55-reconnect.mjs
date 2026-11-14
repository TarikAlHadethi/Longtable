// The reconnect window, on the screen: opening Longtable with your own AI off shows it, with your AI fresh it does
// not; Reconnect runs the line and, once the connection is heard from again, says it is back with confetti and the
// sound; Close leaves it be and it does not come back in that tab; a computer without the reconnect link is waited for.
//
//   node --experimental-websocket tests/e2e/step55-reconnect.mjs

import { execFileSync } from "node:child_process";
import { accessToken, API, APP, KEY, launch, rpc, sleep, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 300)}`; };
const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
const anon = async (fn, args) => {
  const res = await fetch(`${API}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(300); } return v; };
const stage = (page) => page.locator("[data-testid=reconnect]").getAttribute("data-stage").catch(() => null);

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Reconnect", "Maya Stone");
  const T = owner.tableId;
  const code = (await rpc(await accessToken(owner.context), "start_pairing", { t: T, ai_kind: "claude" })).body;
  const device = (await anon("pair_connection", { code, device_label: "maya" })).body.token;
  await anon("runner_hello", { token: device });
  const conn = sql(`select id from public.connections where table_id = '${T}' and revoked_at is null`);
  const page = owner.page;
  // The link itself is not followed: on a computer where longtable:// is registered, the browser's "Open Longtable?"
  // prompt would take every later click. The window's own part (pressing it, waiting, hearing it back) is what is tested.
  await owner.context.addInitScript(() => document.addEventListener("click", (e) => {
    if (e.target instanceof Element && e.target.closest("a[href^='longtable:']")) e.preventDefault();
  }, true));
  const open = async () => { await page.goto(`${APP}/t/${T}`); await page.waitForSelector("[data-testid=messages]", { state: "attached" }); await sleep(1500); };

  await open();
  check("with your AI on, no window", (await page.locator("[data-testid=reconnect]").count()) === 0);

  // Away: the computer has not been heard from, and it has the reconnect link.
  sql(`update public.connections set last_seen = now() - interval '2 hours', limits = coalesce(limits, '{}') || '{"wake": true}' where id = '${conn}'`);
  await open();
  check("coming back with your AI off shows the window", (await stage(page)) === "off" && (await page.locator("[data-testid=reconnect]").textContent()).includes("Claude Code disconnected"));
  await page.click("[data-testid=reconnect-go]");
  await sleep(500);
  check("Reconnect runs the line across the window", (await stage(page)) === "waking" && (await page.locator("[data-testid=reconnect] [data-on]").count()) === 1 && page.url().startsWith(APP), page.url());
  const before = await page.evaluate(() => window.__ltChimes ?? 0);
  sql(`update public.connections set last_seen = now() where id = '${conn}'`);
  check("once it is heard from again, it says it is back", await until(async () => (await stage(page)) === "back"), await stage(page));
  check("with confetti and the sound", (await page.locator("[data-testid=reconnect] [aria-hidden=true] i").count()) > 20 && (await page.evaluate(() => window.__ltChimes ?? 0)) > before);
  check("and the window goes by itself", await until(async () => (await page.locator("[data-testid=reconnect]").count()) === 0, 8000));

  // Close leaves it be, and it does not come back in that tab.
  sql(`update public.connections set last_seen = now() - interval '2 hours' where id = '${conn}'`);
  await page.evaluate(() => sessionStorage.clear());
  await open();
  check("off again: the window", (await stage(page)) === "off");
  await page.click("[data-testid=reconnect-close]");
  check("Close shuts it", await until(async () => (await page.locator("[data-testid=reconnect]").count()) === 0, 3000));
  await open();
  check("and it does not come back in that tab", (await page.locator("[data-testid=reconnect]").count()) === 0);

  // A computer whose connection has no reconnect link (an older version) is waited for.
  sql(`update public.connections set limits = limits - 'wake' where id = '${conn}'`);
  await page.evaluate(() => sessionStorage.clear());
  await open();
  await page.click("[data-testid=reconnect-go]");
  await sleep(2500);
  check("without the link, it waits for the computer and says so", (await stage(page)) === "waking" && (await page.locator("[data-testid=reconnect]").textContent()).includes("starts by itself"));
} finally {
  await browser.close();
}

const failed = Object.entries(results).filter(([, v]) => v !== "pass");
for (const [k, v] of Object.entries(results)) console.log(`${v === "pass" ? "pass" : "FAIL"}  ${k}${v === "pass" ? "" : "  " + v.slice(5)}`);
console.log(`\n${Object.keys(results).length - failed.length} of ${Object.keys(results).length} passed`);
process.exit(failed.length ? 1 : 0);
