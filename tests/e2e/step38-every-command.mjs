// Everything behind "/" (16 Oct 2026): every Claude Code command shows, and each does its nearest real thing at the
// table: runs, opens a screen, changes a setting of the person's own AI, or says what it means here. Nothing that
// steers a person's own AI is ever sent to the chat. Stand-in connection, real screens.
//
//   node --experimental-websocket tests/e2e/step38-every-command.mjs

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

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Every command", "Maya Stone");
  const { tableId, page } = owner;
  const sam = await joinTable(browser, await inviteLink(page, "developer"), `sam-${run}@example.test`, "Sam Ali");
  const tok = { maya: await accessToken(owner.context), sam: await accessToken(sam.context) };
  const code = (await rpc(tok.maya, "start_pairing", { t: tableId, ai_kind: "claude" })).body;
  const device = (await anon("pair_connection", { code, device_label: "slash" })).body.token;
  sql(`update public.jobs set status = 'skipped' where table_id = '${tableId}' and kind = 'intro'`);
  await anon("runner_hello", { token: device });
  // Her own command, one the table runs in its own words, and Claude Code's own names, by name only.
  const list = [{ name: "ship-clinic", about: "Ship the clinic site", kind: "command" }, { name: "review", about: "Read code for bugs", kind: "builtin" },
    ...["compact", "model", "effort", "fast", "usage", "clear", "rename", "mcp", "brand-new-thing"].map((name) => ({ name, about: "", kind: "builtin" })),
    ...Array.from({ length: 200 }, (_, i) => ({ name: `x${i}`, about: "", kind: "builtin" }))];
  const told = await anon("runner_commands", { token: device, list });
  check("the table keeps a long list (Claude Code's own names too)", told.body >= 200, told.body);
  const connId = sql(`select id from public.connections where table_id = '${tableId}' and revoked_at is null`);

  // Settings of her own AI: only hers, only real levels; the claim carries them to her connection.
  check("Sam cannot change how Maya's AI works", (await rpc(tok.sam, "set_ai_speed", { conn: connId, effort: "max", fast: true })).status >= 400);
  check("a level Claude Code does not have is refused", (await rpc(tok.maya, "set_ai_speed", { conn: connId, effort: "turbo" })).status >= 400);
  const general = (await rest(tok.maya, `chats?select=id&table_id=eq.${tableId}&is_general=is.true`)).body[0].id;

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.reload();
  await page.waitForSelector("textarea");
  const box = page.locator("textarea").first();
  const count = async () => Number(sql(`select count(*) from public.messages where chat_id = '${general}'`));
  const before = await count();

  check("with no handouts yet, the sidebar has no Handouts section", (await page.locator("[data-testid=handouts]").count()) === 0);
  await box.fill("/");
  await page.waitForSelector("[data-testid=slash-menu]");
  const menu = await page.textContent("[data-testid=slash-menu]");
  check("typing / shows her own, the table's and Claude Code's own", ["/ship-clinic", "/review", "/compact", "/model", "/effort", "/fast", "/usage", "/clear", "/mcp", "/loop", "/brand-new-thing"].every((n) => menu.includes(n)), menu.slice(0, 400));
  check("each says what it does here", /Happens by itself here/.test(menu) && /Pick the model your Claude uses/.test(menu) && /Not at the table yet/.test(menu));

  // Says what it means, sends nothing.
  await box.fill("/compact");
  await box.press("Enter");
  await sleep(600);
  check("/compact says what it means here and sends nothing", /compacts it by itself/.test(await page.textContent("[role=status]").catch(() => "")) && (await count()) === before);

  // Opens her AI's window.
  await box.fill("/model");
  await box.press("Enter");
  await page.waitForSelector("[data-testid=ai-window]", { timeout: 5000 }).catch(() => {});
  check("/model opens her AI's window, where the model is picked", (await page.locator("[data-testid=ai-window]").count()) === 1 && (await count()) === before);
  check("the window has effort and fast mode", (await page.locator("#opt-effort").count()) === 1 && (await page.locator("[data-testid=opt-fast]").count()) === 1);
  // Our own menu, not the browser's: open it and pick.
  await page.click("[data-testid=ai-window] button[aria-haspopup=listbox]");
  await page.click("[data-testid=ai-window] [role=option]:has(span:text-is('High'))");
  await sleep(800);
  check("effort chosen in the window is kept", sql(`select effort from public.connections where id = '${connId}'`) === "high");
  await page.click("[data-testid=ai-window] button:has-text('Close')");

  // Settings by typing.
  await box.fill("/effort high");
  await box.press("Enter");
  await sleep(800);
  check("/effort high sets it, and sends nothing", sql(`select effort from public.connections where id = '${connId}'`) === "high" && (await count()) === before);
  await box.fill("/fast on");
  await box.press("Enter");
  await sleep(800);
  check("/fast on switches fast mode on", sql(`select fast from public.connections where id = '${connId}'`) === "t");
  await rpc(tok.maya, "ask_table", { c: general, body: "what is in the readme?" });
  let job = null;
  for (let i = 0; i < 30 && !job; i++) { for (const lane of ["heavy", "light"]) { const j = (await anon("runner_claim", { token: device, lane })).body; if (j?.job_id) { job = j; break; } } if (!job) await sleep(300); }
  check("her connection is told her effort and fast mode with each job", job?.effort === "high" && job?.fast === true, job && { effort: job.effort, fast: job.fast });
  await anon("runner_finish", { token: device, job: job.job_id, answer: "It says hello.", info: { sources: [] } });
  await anon("runner_report", { token: device, limits: { ai: "claude", fast: "off", fast_why: "preference" } });
  await page.click("[data-testid=me-menu]").catch(() => {});
  await page.keyboard.press("Escape");
  await box.fill("/model");
  await box.press("Enter");
  await page.waitForSelector("[data-testid=ai-window]");
  await sleep(1500);
  check("when her account does not allow fast mode, the window does not offer it", (await page.locator("[data-testid=ai-window] [data-testid=opt-fast]").count()) === 0);
  await page.click("[data-testid=ai-window] button:has-text('Close')");

  // Chats.
  await box.fill("/clear Plans");
  await box.press("Enter");
  await sleep(1500);
  check("/clear starts a new chat", sql(`select count(*) from public.chats where table_id = '${tableId}' and name = 'Plans'`) === "1");
  await box.fill("/rename Launch plans");
  await box.press("Enter");
  await sleep(1200);
  check("/rename renames this chat", sql(`select count(*) from public.chats where table_id = '${tableId}' and name = 'Launch plans'`) === "1");

  // Runs: hers, and the table's own words, go on as a message.
  const plansChat = sql(`select id from public.chats where table_id = '${tableId}' and name = 'Launch plans'`);
  await box.fill("/review the login page");
  await box.press("Enter");
  await sleep(1500);
  check("/review is sent, for her Claude to run", sql(`select count(*) from public.messages where chat_id = '${plansChat}' and body = '/review the login page'`) === "1");

  // Like texting: two of her messages in a row sit under each other, her name and picture said once.
  await box.fill("first of two");
  await box.press("Enter");
  await sleep(700);
  await box.fill("second of two");
  await box.press("Enter");
  await page.waitForFunction(() => [...document.querySelectorAll("[data-mid]")].some((el) => el.textContent.includes("second of two")), null, { timeout: 8000 });
  // Her /review just before is the start of the same run: it alone carries her name; the two after it do not.
  const run2 = await page.evaluate(() => { const els = [...document.querySelectorAll("[data-mid]")]; const at = (w) => els.find((e) => e.textContent.includes(w))?.hasAttribute("data-follows"); return { start: at("/review the login page"), a: at("first of two"), b: at("second of two") }; });
  check("messages in a row sit under each other, her name said once at the start", run2.start === false && run2.a === true && run2.b === true, run2);

  // Usage.
  await box.fill("/usage");
  await box.press("Enter");
  await page.waitForURL(/\/usage$/, { timeout: 10000 }).catch(() => {});
  check("/usage opens the Usage page", page.url().endsWith("/usage"), page.url());
} catch (e) {
  results.error = String(e?.stack || e).slice(0, 900);
} finally {
  await browser.close();
}
const failed = Object.entries(results).filter(([, v]) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
