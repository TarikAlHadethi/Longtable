// A person's own computer from their own page, and Bypass. The table keeps where their connection's bridge listens and
// its key only for their own full Claude Code, hands it to them alone (never a teammate, never on a live channel, never
// for a client's or a ChatGPT connection, gone when full Claude Code is off); Bypass is theirs to pick. On the screen:
// a Terminal icon under the box, a line typed in the terminal runs on their computer, and "!" in the box runs there
// too without reaching the chat. The bridge is the connection's real one, started here. No AI.
//
//   node --experimental-websocket tests/db/your-computer.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessToken, API, APP, KEY, inviteLink, join as joinTable, launch, listen, rest, rpc, sleep, startTable } from "../lib.mjs";
import { bridgeKey, startBridge } from "../../packages/connect/src/local.mjs";

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

  // Their AI's browser is theirs alone: a teammate's question that lands on their AI never runs as their full Claude
  // Code, so it never gets the browser; their own question does.
  await rpc(tok.maya, "set_browser", { conn, on_: true });
  const generalChat = sql(`select id from public.chats where table_id = '${T}' and name = 'General'`);
  const claimFor = async (from) => {
    const q = sql(`select id from public.messages where table_id = '${T}' and body = '${from}' order by created_at desc limit 1`);
    for (let i = 0; i < 6; i++) {
      const j = (await anon("runner_claim", { token: device, lane: null })).body;
      if (!j) break;
      if (j.question === from) return j;
      sql(`update public.jobs set status = 'done' where id = '${j.job_id}'`);
    }
    return { question: q, none: true };
  };
  await rpc(tok.sam, "ask_table", { c: generalChat, body: "sam asks: open example.com in the browser", files: [] });
  const samJob = await until(() => claimFor("sam asks: open example.com in the browser"), 8000);
  check("a teammate's question on their AI never runs as their full Claude Code (so never with their browser)", samJob && !samJob.none && samJob.full === false, samJob);
  if (samJob?.job_id) sql(`update public.jobs set status = 'done' where id = '${samJob.job_id}'`);
  await rpc(tok.maya, "ask_table", { c: generalChat, body: "maya asks: check the home page", files: [] });
  const mayaJob = await until(() => claimFor("maya asks: check the home page"), 8000);
  check("their own question does, with their browser", mayaJob && !mayaJob.none && mayaJob.full === true && mayaJob.browser === true, mayaJob);
  if (mayaJob?.job_id) sql(`update public.jobs set status = 'done' where id = '${mayaJob.job_id}'`);
  await rpc(tok.maya, "set_browser", { conn, on_: false });

  // Bypass: theirs to pick, and only theirs.
  check("Bypass can be picked", (await rpc(tok.maya, "set_ai_mode", { conn, mode: "bypass" })).status < 300 && sql(`select mode from public.connections where id = '${conn}'`) === "bypass");
  check("not by a teammate", (await rpc(tok.sam, "set_ai_mode", { conn, mode: "manual" })).status >= 400);
  check("and no made-up mode", (await rpc(tok.maya, "set_ai_mode", { conn, mode: "yolo" })).status >= 400);
  await rpc(tok.maya, "set_ai_mode", { conn, mode: "auto" });

  // The screen, with the connection's real bridge on this computer.
  const seat = { table_id: T, local: { key: bridgeKey(), allowed: true }, terminalFolder: scratch };
  bridge = await startBridge({ app: APP, seats: [seat], home: scratch, log: () => {} });
  check("the real bridge is allowed", (await anon("runner_local", { token: device, port: bridge.port, key: seat.local.key })).body === true);
  const page = owner.page;
  // His screen: wide enough that the site scales itself to 125%, where windows used to run off the edge.
  await page.setViewportSize({ width: 1920, height: 1000 });
  const general = sql(`select id from public.chats where table_id = '${T}' and name = 'General'`);
  await page.goto(`${APP}/t/${T}?c=${general}`);
  await page.waitForSelector("[data-testid=open-terminal]");
  check("the page is scaled, as on his screen", (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--zoom").trim())) === "1.25");
  await page.click("[data-testid=mode-pick]");
  check("the mode menu offers Bypass", (await page.locator("[role=option]", { hasText: "Bypass" }).count()) === 1);
  await page.keyboard.press("Escape");

  // The terminal: a real one, opened from its icon under the box.
  check("the terminal is an icon under the box, and there is no browser", (await page.locator("[data-testid=open-terminal] svg").count()) === 1 && (await page.locator("[data-testid=open-browser]").count()) === 0
    && ((await page.locator("[data-testid=open-terminal]").textContent()) || "").trim() === "");
  const OUT = "[data-testid=term-out]:visible";
  const screen = () => page.locator(`${OUT} .xterm-rows`).innerText().catch(() => "");
  const shows = (word) => until(async () => (await screen()).split("\n").some((l) => l.trim() === word), 20000);
  const shown = () => page.locator("[data-testid=computer-window]:not([data-hidden])");
  const winOf = (pane) => page.locator(`[data-testid=computer-window][data-pane=${pane}]`);
  const headOf = (pane) => page.locator(`[data-testid=computer-window][data-pane=${pane}] [data-head]`);
  const settle = () => sleep(650); // a window's way out of its icon, or back into it
  await page.click("[data-testid=open-terminal]");
  await page.waitForSelector(`${OUT} .xterm-rows`);
  await sleep(2500);
  await page.click(OUT);
  await page.keyboard.type(win ? "echo ('typed-in'+'-longtable')" : "echo 'typed-in''-longtable'");
  await page.keyboard.press("Enter");
  check("what is typed in the terminal runs in their real shell", await shows("typed-in-longtable"), (await screen()).slice(-300));
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  check("arrow keys reach the shell (Up brings the last command back)", await until(async () => (await screen()).split("\n").filter((l) => l.trim() === "typed-in-longtable").length >= 2, 15000));
  check("the terminal has a terminal's black, and no name in its bar", (await page.locator(`${OUT} .xterm-rows`).count()) > 0
    && (await page.evaluate(() => getComputedStyle(document.querySelector("[data-testid=computer-window][data-pane=terminal]")).backgroundColor)) === "rgb(12, 12, 12)"
    && !((await headOf("terminal").innerText()) || "").match(/terminal|browser/i));

  // Terminals as tabs, each its own shell; switching keeps each one's screen; closing a tab ends only that one.
  await page.click("[data-testid=term-new]");
  check("+ opens a second terminal as a tab, in front", await until(async () => (await page.locator("[data-testid=term-tab]").count()) === 2
    && (await page.locator("[data-testid=term-tab]").nth(1).getAttribute("aria-selected")) === "true", 3000));
  await sleep(2000);
  await page.click(OUT);
  await page.keyboard.type(win ? "echo ('second'+'-tab')" : "echo 'second''-tab'");
  await page.keyboard.press("Enter");
  check("the second terminal is a shell of its own", await shows("second-tab") && !(await screen()).includes("typed-in-longtable"));
  await page.locator("[data-testid=term-tab]").first().click();
  check("switching back shows the first one as it was, at once", (await screen()).includes("typed-in-longtable") && !(await screen()).includes("second-tab"));
  await page.locator("[data-testid=term-tab]").nth(1).locator("button").click();
  check("closing a terminal's tab leaves the others", await until(async () => (await page.locator("[data-testid=term-tab]").count()) === 1, 3000) && (await screen()).includes("typed-in-longtable"));
  const hb = await headOf("terminal").boundingBox();
  check("the top bar is slim: the tabs are the bar", hb.height <= 36 * 1.25 + 2, hb);

  // Moved by its top bar, it stays under the cursor exactly, never picks text on the way, and never leaves its room.
  const vw = 1920, vh = 1000;
  const rect = (pane = "terminal") => winOf(pane).boundingBox();
  let r = await rect();
  const grab = { x: r.x + r.width - 130, y: r.y + 16 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x - 600, grab.y + 150, { steps: 12 });
  let r2 = await rect();
  check("dragged, the window keeps pace with the cursor", Math.abs(r2.x - (r.x - 600)) < 3 && Math.abs(r2.y - (r.y + 150)) < 3, { r, r2 });
  check("dragging across the page picks no text", (await page.evaluate(() => getSelection().toString())) === "");
  await page.mouse.move(vw + 400, vh + 400, { steps: 12 });
  r2 = await rect();
  const icons = await page.locator("[data-testid=open-terminal]").boundingBox();
  check("dragged past the corner, it stays on the screen and clear of the icons under the box", r2.x + r2.width <= vw - 5 && r2.y + r2.height <= icons.y && r2.x >= 5, { r2, icons });
  await page.mouse.move(-400, -400, { steps: 12 });
  r2 = await rect();
  check("and past the other corner too", r2.x >= 5 && r2.y >= 60, r2);
  await page.mouse.up();

  // Snapped to a side, to the top; dragged off a side it goes back to its own size.
  const drag = async (from, to) => { await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 14 }); await page.mouse.up(); await sleep(400); };
  r = await rect();
  await page.mouse.move(r.x + r.width - 130, r.y + 16); await page.mouse.down(); await page.mouse.move(1, 500, { steps: 14 });
  await sleep(300);
  const pv = await page.locator("[data-testid=snap-preview]").boundingBox().catch(() => null);
  check("held at the left edge, where it would go shows first", !!pv && pv.x < 20 && Math.abs(pv.width - (vw - 30) / 2) < 20, pv);
  await page.mouse.up(); await sleep(400);
  r2 = await rect();
  check("dragged to the left edge, it fills the left half (down to the icons)", (await winOf("terminal").getAttribute("data-snap")) === "left" && r2.x < 20 && Math.abs(r2.width - (vw - 30) / 2) < 20 && r2.y + r2.height <= icons.y && r2.height > vh - 220, r2);
  await drag({ x: r2.x + r2.width - 130, y: r2.y + 16 }, { x: vw - 1, y: 500 });
  check("to the right edge, the right half", (await winOf("terminal").getAttribute("data-snap")) === "right" && (await rect()).x > vw / 2 - 20);

  // Dragged away, it goes back to its own size; a double-click on its top bar fills the screen and back.
  r = await rect("terminal");
  await drag({ x: r.x + r.width - 130, y: r.y + 16 }, { x: 700, y: 360 });
  r2 = await rect();
  check("dragged away, it goes back to its own size", !(await winOf("terminal").getAttribute("data-snap")) && r2.width < vw / 2, r2);
  await headOf("terminal").dblclick({ position: { x: 400, y: 12 } });
  await sleep(400);
  check("a double-click on its top bar fills the screen", (await winOf("terminal").getAttribute("data-snap")) === "max");
  await headOf("terminal").dblclick({ position: { x: 400, y: 12 } });
  await sleep(400);

  // Sized from its edges; against a wall an edge stops there and the other side stays put.
  r = await rect();
  await drag({ x: r.x + r.width - 130, y: r.y + 16 }, { x: r.x + r.width - 130 - (r.x - 9), y: r.y + 16 });
  r = await rect();
  await drag({ x: r.x + 2, y: r.y + r.height / 2 }, { x: r.x - 200, y: r.y + r.height / 2 });
  r2 = await rect();
  check("at the left wall, the left edge stops and the right side stays put", Math.abs((r2.x + r2.width) - (r.x + r.width)) < 3 && r2.x >= 5, { r, r2 });
  await drag({ x: r2.x + r2.width - 130, y: r2.y + 16 }, { x: 900, y: 380 });
  r = await rect();
  await drag({ x: r.x + r.width - 2, y: r.y + r.height / 2 }, { x: r.x + r.width + 118, y: r.y + r.height / 2 });
  r2 = await rect();
  check("its right edge sizes it", Math.abs(r2.width - (r.width + 120)) < 4 && Math.abs(r2.x - r.x) < 3, { r, r2 });
  await drag({ x: r2.x + 2, y: r2.y + r2.height / 2 }, { x: r2.x - 98, y: r2.y + r2.height / 2 });
  const r3 = await rect();
  check("its left edge too, keeping its right side where it was", Math.abs(r3.x - (r2.x - 100)) < 4 && Math.abs((r3.x + r3.width) - (r2.x + r2.width)) < 3, { r2, r3 });

  // The minus sends it into its icon, held there with no flash back; the icon brings it back as it was.
  await page.click("[data-testid=computer-window][data-pane=terminal] [data-testid=minimize]");
  const seen = [];
  for (let i = 0; i < 12; i++) { seen.push(await winOf("terminal").evaluate((el) => el.getBoundingClientRect().width)); await sleep(50); }
  check("minimized, it goes into its icon without coming back at full size on the way", await until(async () => (await winOf("terminal").getAttribute("data-hidden")) === "true", 3000)
    && seen.slice(seen.findIndex((w) => w < r3.width * 0.5)).every((w) => w < r3.width * 0.5), seen);
  await page.click("[data-testid=open-terminal]");
  check("its icon brings it back, as it was", await until(async () => !(await winOf("terminal").getAttribute("data-hidden")), 3000) && await shows("typed-in-longtable"));
  await settle();
  check("back in the same place and size", Math.abs((await rect()).x - r3.x) < 3 && Math.abs((await rect()).width - r3.width) < 3);
  await page.click("[data-testid=open-terminal]");
  check("pressed again while in front, it goes back into the icon", await until(async () => (await winOf("terminal").getAttribute("data-hidden")) === "true", 3000));
  await page.click("[data-testid=open-terminal]");
  await settle();
  // The cross closes the window with no flash; the shell lives on, so opening it again shows it as it was.
  await page.click("[data-testid=computer-window][data-pane=terminal] [data-testid=close-window]");
  const after = [];
  for (let i = 0; i < 8; i++) { after.push(await winOf("terminal").count()); await sleep(60); }
  check("the cross closes the window, and it does not come back", after.indexOf(0) >= 0 && after.slice(after.indexOf(0)).every((n) => n === 0), after);
  await page.click("[data-testid=open-terminal]");
  check("and the terminal is not lost: opened again, it is as it was", await shows("typed-in-longtable"));

  // "!" in the box runs in the terminal and never reaches the chat.
  const before = sql(`select count(*) from public.messages where table_id = '${T}'`);
  await page.fill("textarea[aria-label='Message the table']", win ? "!echo ('from'+'-the-box')" : "!echo 'from''-the-box'");
  await page.press("textarea[aria-label='Message the table']", "Enter");
  check("\"!\" in the box runs it in their terminal", await shows("from-the-box"), (await screen()).slice(-300));
  check("and nothing reaches the chat", sql(`select count(*) from public.messages where table_id = '${T}'`) === before && (await page.inputValue("textarea[aria-label='Message the table']")) === "");

  // The sidebar put away: its room goes to the chat, it slides back while the pointer is at the left edge, and the
  // choice is kept for this device.
  const aside = () => page.locator("aside[aria-label=Menu]").boundingBox();
  const asideShown = async () => { const b = await aside(); return !!b && b.x + b.width > 50; };
  await page.click("[data-testid=computer-window][data-pane=terminal] [data-testid=minimize]");
  await settle();
  await page.click("[data-testid=side-toggle]");
  check("the button by its edge puts the sidebar away", await until(async () => !(await asideShown()), 3000));
  await page.mouse.move(400, 500);
  await page.mouse.move(2, 500, { steps: 4 });
  check("the pointer at the left edge brings it over the room", await until(asideShown, 3000));
  // Into it, as someone peeking at it does, then away: leaving the sidebar puts it away again.
  await page.mouse.move(120, 500, { steps: 4 });
  await page.mouse.move(1000, 500, { steps: 4 });
  check("and it goes again when the pointer leaves it", await until(async () => !(await asideShown()), 3000));
  await page.reload();
  await page.waitForSelector("[data-testid=side-toggle]");
  await sleep(800);
  check("put away, it stays away after a reload", !(await asideShown()));
  await page.click("[data-testid=side-toggle]");
  check("and the button brings it back", await until(asideShown, 3000));

  // A smaller screen keeps every window on it.
  await page.click("[data-testid=open-terminal]");
  await until(async () => (await shown().count()) === 1, 5000);
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(600);
  const small = await winOf("terminal").boundingBox();
  check("on a phone the window is wholly on the screen", small.x >= 0 && small.x + small.width <= 390 && small.y + small.height <= 844, small);
  await page.setViewportSize({ width: 1920, height: 1000 });

  // A teammate has no way to it.
  await sam.page.goto(`${APP}/t/${T}?c=${general}`);
  await sam.page.waitForSelector("[data-testid=messages]");
  check("a teammate sees no Terminal of theirs", (await sam.page.locator("[data-testid=open-terminal]").count()) === 0);
} catch (e) {
  check("the run finished", false, e.message.split(String.fromCharCode(10))[0]);
} finally {
  bridge?.close();
  await browser.close();
  try { rmSync(scratch, { recursive: true, force: true }); } catch {}
}

const failed = Object.entries(results).filter(([, v]) => v !== "pass");
for (const [k, v] of Object.entries(results)) console.log(`${v === "pass" ? "pass" : "FAIL"}  ${k}${v === "pass" ? "" : "  " + v.slice(5)}`);
console.log(`\n${Object.keys(results).length - failed.length} of ${Object.keys(results).length} passed`);
process.exit(failed.length ? 1 : 0);
