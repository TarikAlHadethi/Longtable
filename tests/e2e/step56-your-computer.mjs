// A person's own computer from their own page, and Bypass. The table keeps where their connection's bridge listens and
// its key only for their own full Claude Code, hands it to them alone (never a teammate, never on a live channel, never
// for a client's or a ChatGPT connection, gone when full Claude Code is off); Bypass is theirs to pick. On the screen:
// Terminal and Browser under the box, a line typed in the terminal runs on their computer, and "!" in the box runs there
// too without reaching the chat. The bridge is the connection's real one, started here. No AI.
//
//   node --experimental-websocket tests/e2e/step56-your-computer.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessToken, API, APP, KEY, inviteLink, join as joinTable, launch, listen, rest, rpc, sleep, startTable } from "./lib.mjs";
import { bridgeKey, startBridge } from "../../packages/connect/src/local.mjs";
import { Browser } from "../../packages/connect/src/browser.mjs";

const run = Date.now().toString(36);
const win = process.platform === "win32";
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 300)}`; };
const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
const anon = async (fn, args) => {
  const res = await fetch(`${API}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(300); } return v; };
const pair = async (tok, T, kind) => {
  const code = (await rpc(tok, "start_pairing", { t: T, ai_kind: kind })).body;
  const device = (await anon("pair_connection", { code, device_label: kind })).body.token;
  await anon("runner_hello", { token: device });
  return device;
};

const scratch = mkdtempSync(join(tmpdir(), "longtable-computer-"));
const browser = await launch();
let bridge = null;
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Computer", "Maya Stone");
  const T = owner.tableId;
  const sam = await joinTable(browser, await inviteLink(owner.page, "developer"), `sam-${run}@example.test`, "Sam Ali");
  const elena = await joinTable(browser, await inviteLink(owner.page, "client"), `elena-${run}@example.test`, "Elena Ruiz");
  const tok = { maya: await accessToken(owner.context), sam: await accessToken(sam.context), elena: await accessToken(elena.context) };
  const device = await pair(tok.maya, T, "claude");
  const conn = sql(`select c.id from public.connections c join public.members m on m.id = c.member_id where c.table_id = '${T}' and m.display_name = 'Maya Stone' and c.revoked_at is null`);

  // Where the bridge listens: kept for their own full Claude Code, handed only to them.
  const key = bridgeKey();
  const bad = await anon("runner_local", { token: device, port: 80, key });
  check("a bridge needs a real port and key", bad.status >= 400 && (await anon("runner_local", { token: device, port: 40000, key: "short" })).status >= 400);
  const samHears = await listen(tok.sam, `team:${T}`);
  check("its own full Claude Code may open one", (await anon("runner_local", { token: device, port: 40000, key })).body === true);
  const mine = (await rpc(tok.maya, "my_local", { t: T })).body;
  check("its person gets where it listens and the key", mine?.port === 40000 && mine?.key === key, mine);
  check("a teammate gets nothing of it", (await rpc(tok.sam, "my_local", { t: T })).body === null);
  check("nobody reads the key from the table", (await rest(tok.sam, `connections?select=local&table_id=eq.${T}`)).status >= 400
    && (await rest(tok.maya, `connections?select=local&table_id=eq.${T}`)).status >= 400);
  await sleep(1500);
  check("the live channel never carries it", samHears.heard.length > 0 && !JSON.stringify(samHears.heard).includes(key), samHears.heard.length);
  await samHears.stop();
  check("signed out, nothing", (await anon("my_local", { t: T })).status >= 400);

  // A client's connection, and full Claude Code off, get no bridge.
  const clientDevice = await pair(tok.elena, T, "claude");
  check("a client's connection may not open one", (await anon("runner_local", { token: clientDevice, port: 40001, key: bridgeKey() })).body === false);
  await rpc(tok.maya, "set_full_claude", { conn, full_on: false });
  check("full Claude Code off: closed, and forgotten", (await anon("runner_local", { token: device, port: 40000, key })).body === false
    && (await rpc(tok.maya, "my_local", { t: T })).body === null && sql(`select local is null from public.connections where id = '${conn}'`) === "t");
  await rpc(tok.maya, "set_full_claude", { conn, full_on: true });

  // Bypass: theirs to pick, and only theirs.
  check("Bypass can be picked", (await rpc(tok.maya, "set_ai_mode", { conn, mode: "bypass" })).status < 300 && sql(`select mode from public.connections where id = '${conn}'`) === "bypass");
  check("not by a teammate", (await rpc(tok.sam, "set_ai_mode", { conn, mode: "manual" })).status >= 400);
  check("and no made-up mode", (await rpc(tok.maya, "set_ai_mode", { conn, mode: "yolo" })).status >= 400);
  await rpc(tok.maya, "set_ai_mode", { conn, mode: "auto" });

  // The screen, with the connection's real bridge on this computer.
  const seat = { table_id: T, local: { key: bridgeKey(), allowed: true }, terminalFolder: scratch };
  bridge = await startBridge({ app: APP, seats: [seat], home: scratch, browser: new Browser(join(scratch, "home"), () => {}), log: () => {} });
  check("the real bridge is allowed", (await anon("runner_local", { token: device, port: bridge.port, key: seat.local.key })).body === true);
  const page = owner.page;
  const general = sql(`select id from public.chats where table_id = '${T}' and name = 'General'`);
  await page.goto(`${APP}/t/${T}?c=${general}`);
  await page.waitForSelector("[data-testid=open-terminal]");
  await page.click("[data-testid=mode-pick]");
  check("the mode menu offers Bypass", (await page.locator("[role=option]", { hasText: "Bypass" }).count()) === 1);
  await page.keyboard.press("Escape");

  // The terminal: a real one, in a window of its own, opened from its icon under the box.
  check("the terminal and browser are icons under the box", (await page.locator("[data-testid=open-terminal] svg").count()) === 1 && (await page.locator("[data-testid=open-browser] svg").count()) === 1
    && ((await page.locator("[data-testid=open-terminal]").textContent()) || "").trim() === "");
  const screen = () => page.locator("[data-testid=term-out] .xterm-rows").innerText().catch(() => "");
  const shows = (word) => until(async () => (await screen()).split("\n").some((l) => l.trim() === word), 20000);
  await page.click("[data-testid=open-terminal]");
  await page.waitForSelector("[data-testid=term-out] .xterm-rows");
  await sleep(2500);
  await page.click("[data-testid=term-out]");
  await page.keyboard.type(win ? "echo ('typed-in'+'-longtable')" : "echo 'typed-in''-longtable'");
  await page.keyboard.press("Enter");
  check("what is typed in the terminal runs in their real shell", await shows("typed-in-longtable"), (await screen()).slice(-300));
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  check("arrow keys reach the shell (Up brings the last command back)", await until(async () => (await screen()).split("\n").filter((l) => l.trim() === "typed-in-longtable").length >= 2, 15000));

  // A window of its own, moved by its top bar.
  const box = async (sel) => page.locator(sel).boundingBox();
  const termWin = "[data-testid=window-terminal]";
  const was = await box(termWin);
  await page.mouse.move(was.x + 120, was.y + 18);
  await page.mouse.down();
  await page.mouse.move(was.x - 80, was.y + 120, { steps: 6 });
  await page.mouse.up();
  const now = await box(termWin);
  check("the window moves where it is dragged", Math.abs(now.x - (was.x - 200)) < 4 && Math.abs(now.y - (was.y + 102)) < 4, { was, now });

  // The browser in a window of its own; the two put together as tabs of one window, and taken apart again.
  await page.click("[data-testid=open-browser]");
  await page.waitForSelector("[data-testid=window-browser]");
  check("the browser opens in its own window, beside the terminal", (await page.locator("[data-testid^=window-]").count()) === 2);
  await page.click("[data-testid=window-browser] [data-testid=combine]");
  check("put together, they are tabs of one window", await until(async () => (await page.locator("[data-testid^=window-]").count()) === 1 && (await page.locator("[data-testid=tab-browser]").count()) === 1 && (await page.locator("[data-testid=tab-terminal]").count()) === 1));
  await page.click("[data-testid=tab-terminal]");
  check("the terminal keeps its screen as a tab", await shows("typed-in-longtable"));
  await page.click("[data-testid=separate-browser]");
  check("taken apart, each has its own window again", await until(async () => (await page.locator("[data-testid=window-terminal]").count()) === 1 && (await page.locator("[data-testid=window-browser]").count()) === 1));

  // Tabs in the browser, with no limit: past ten it says so, and still opens more.
  await until(async () => (await page.locator("[data-testid=browser-tab]").count()) >= 1, 20000);
  for (let i = 0; i < 11; i++) { await page.click("[data-testid=browser-newtab]"); await sleep(150); }
  check("past ten tabs it warns, and opens them all the same", await until(async () => (await page.locator("[data-testid=browser-tab]").count()) === 12 && (await page.locator("[data-testid=many-tabs]").count()) === 1, 20000),
    await page.locator("[data-testid=browser-tab]").count());
  await page.click("[data-testid=window-browser] [data-testid=close-window]");

  // Closing the terminal ends its shell; the next one starts clean. "!" in the box runs there and never reaches the chat.
  await page.click("[data-testid=window-terminal] [data-testid=close-window]");
  check("the window closes", (await page.locator("[data-testid^=window-]").count()) === 0);
  const before = sql(`select count(*) from public.messages where table_id = '${T}'`);
  await page.fill("textarea[aria-label='Message the table']", win ? "!echo ('from'+'-the-box')" : "!echo 'from''-the-box'");
  await page.press("textarea[aria-label='Message the table']", "Enter");
  check("\"!\" in the box opens the terminal and runs it there", await shows("from-the-box"), (await screen()).slice(-300));
  check("the shell was new: what was typed before is gone", !(await screen()).includes("typed-in-longtable"));
  check("and nothing reaches the chat", sql(`select count(*) from public.messages where table_id = '${T}'`) === before && (await page.inputValue("textarea[aria-label='Message the table']")) === "");

  // A teammate has no way to it.
  await sam.page.goto(`${APP}/t/${T}?c=${general}`);
  await sam.page.waitForSelector("[data-testid=messages]");
  check("a teammate sees no Terminal of theirs", (await sam.page.locator("[data-testid=open-terminal]").count()) === 0);
} finally {
  bridge?.close();
  await browser.close();
  try { rmSync(scratch, { recursive: true, force: true }); } catch {}
}

const failed = Object.entries(results).filter(([, v]) => v !== "pass");
for (const [k, v] of Object.entries(results)) console.log(`${v === "pass" ? "pass" : "FAIL"}  ${k}${v === "pass" ? "" : "  " + v.slice(5)}`);
console.log(`\n${Object.keys(results).length - failed.length} of ${Object.keys(results).length} passed`);
process.exit(failed.length ? 1 : 0);
