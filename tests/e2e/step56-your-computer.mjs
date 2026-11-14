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

  await page.click("[data-testid=open-terminal]");
  await page.fill("[data-testid=term-line]", "echo typed-in-longtable");
  await page.press("[data-testid=term-line]", "Enter");
  check("a line typed in the terminal runs on their computer", await until(async () => (await page.locator("[data-testid=term-out]").textContent())?.split("\n").some((l) => l.trim() === "typed-in-longtable")));
  await page.click("[data-testid=computer] [aria-label=Close]");
  check("the panel closes", (await page.locator("[data-testid=computer]").count()) === 0);

  const before = sql(`select count(*) from public.messages where table_id = '${T}'`);
  await page.fill("textarea[aria-label='Message the table']", "!echo from-the-box");
  await page.press("textarea[aria-label='Message the table']", "Enter");
  check("\"!\" in the box runs it in their terminal", await until(async () => (await page.locator("[data-testid=term-out]").textContent().catch(() => ""))?.split("\n").some((l) => l.trim() === "from-the-box")));
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
