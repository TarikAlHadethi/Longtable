// Every screen a client can see, on a phone, as pictures. A walk through one client's whole time at a table: the
// invite, the first look, asking, a decision, a question back, their own assistant, dark mode, and being taken off.
// Writes numbered PNGs to the folder in SCREENSHOTS.
//
//   SCREENSHOTS=<folder> node --experimental-websocket tests/e2e/look-client.mjs

import { execFileSync } from "node:child_process";
import { accessToken, API, APP, inviteLink, join, KEY, launch, rest, rpc, sleep, startTable } from "./lib.mjs";

const out = process.env.SCREENSHOTS;
if (!out) throw new Error("Set SCREENSHOTS to a folder.");
const run = Date.now().toString(36);
const sql = (q) => execFileSync("docker", ["exec", "-i", "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
const anon = async (fn, args) => (await fetch(`${API}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(args) })).json().catch(() => null);
let n = 0;
const made = [];
const snap = async (page, name, full = false) => {
  await sleep(700);
  // The development badge is not part of the product.
  await page.evaluate(() => document.querySelectorAll("nextjs-portal").forEach((el) => { el.style.display = "none"; }));
  const shot = async (suffix) => {
    const file = `${out}/${String(++n).padStart(2, "0")}-${name}${suffix}.png`;
    await page.screenshot({ path: file });
    made.push(file);
  };
  if (!full) return shot("");
  // A page longer than the phone: one picture from the top, one from the bottom, as someone scrolling would see it.
  const scroller = "main[class*=talk]";
  const long = await page.evaluate((sel) => { const el = document.querySelector(sel) ?? document.scrollingElement; el.scrollTop = 0; return el.scrollHeight > el.clientHeight + 40; }, scroller);
  await sleep(250);
  await shot("");
  if (!long) return;
  await page.evaluate((sel) => {
    const el = document.querySelector(sel) ?? document.scrollingElement;
    el.scrollTop = el.scrollHeight;
    const chat = document.querySelector("[data-testid=client-chat]");
    if (chat) chat.scrollTop = chat.scrollHeight;
  }, scroller);
  await sleep(300);
  n--;
  await shot("-scrolled-down");
};

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Fernhill Dental booking", "Maya");
  const tableId = owner.tableId;
  const dev = await join(browser, await inviteLink(owner.page, "developer"), `dev-${run}@example.test`, "Sam");
  const link = await inviteLink(owner.page, "client");

  // ---- the invite, before anything
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  const first = await browser.newContext(phone);
  const firstPage = await first.newPage();
  await firstPage.goto(link);
  await snap(firstPage, "the-invite-link-opens-here");
  await first.close();

  const elena = await join(browser, link, `elena-${run}@example.test`, "Elena Ruiz");
  const page = elena.page;
  await page.setViewportSize({ width: 390, height: 844 });
  const ownerToken = await accessToken(owner.context);
  const elenaToken = await accessToken(elena.context);

  // ---- the first look
  await page.goto(`${APP}/t/${tableId}`);
  await page.waitForSelector("[data-testid=client-tree]");
  await sleep(2200);
  await snap(page, "first-look-her-side-of-the-table");
  await page.click("button[aria-label=Menu]");
  await snap(page, "the-menu");
  await page.click("button[aria-label=Menu]");
  await page.click("[data-testid=me-menu]");
  await snap(page, "her-picture-menu");
  await page.keyboard.press("Escape");
  await page.mouse.click(195, 700);

  // ---- the chat, empty
  await page.click("button:has-text('Open the chat')");
  await page.waitForSelector("text=What you asked for");
  await snap(page, "the-chat-before-she-asks-anything", true);

  // ---- she asks; the team decides
  const ask = "Some patients only want to see Sofia. Can they pick a specific hygienist when they book?";
  await page.fill("input[aria-label='Ask the team']", ask);
  await page.press("input[aria-label='Ask the team']", "Enter");
  await page.waitForSelector("[data-request]");
  await snap(page, "she-asked-it-is-with-the-team", true);
  const reqId = (await rest(elenaToken, `requests?select=id&table_id=eq.${tableId}`)).body[0].id;

  await dev.page.waitForSelector(`[data-request='${reqId}'] button:has-text('Make a poll')`);
  await dev.page.click(`[data-request='${reqId}'] button:has-text('Make a poll')`);
  await dev.page.fill("#d-title", "Hygienist choice: launch or first update?");
  await dev.page.fill("input[aria-label='Option 1']", "Ship it for launch");
  await dev.page.fill("input[aria-label='Option 2']", "First update");
  await dev.page.fill("textarea[aria-label^='What Elena Ruiz will be told for option 1']", "Good news: patients will be able to pick their hygienist when they book, from launch.");
  await dev.page.fill("textarea[aria-label^='What Elena Ruiz will be told for option 2']", "Picking a hygienist comes in the first update after launch.");
  await dev.page.click("button:has-text('Start the poll')");
  await page.waitForFunction((id) => document.querySelector(`[data-request='${id}'] [data-testid=status]`)?.textContent === "Being decided", reqId, { timeout: 10000 });
  await snap(page, "the-team-is-deciding", true);

  const d1 = (await rest(ownerToken, `decisions?select=id,request_id&table_id=eq.${tableId}`)).body.find((x) => x.request_id === reqId).id;
  await owner.page.locator(`[data-did='${d1}'] button:has-text('Ship it for launch')`).click();
  await page.waitForFunction((id) => document.querySelector(`[data-request='${id}'] [data-testid=status]`)?.textContent === "Decided", reqId, { timeout: 40000 });
  await page.click(`[data-request='${reqId}'] button`);
  await snap(page, "decided-she-is-told-in-the-teams-chosen-words", true);

  // ---- the team asks her something back
  const ask2 = "Could we also have a waiting list for cancelled slots?";
  await page.fill("input[aria-label='Ask the team']", ask2);
  await page.press("input[aria-label='Ask the team']", "Enter");
  await page.waitForFunction(() => document.querySelectorAll("[data-request]").length >= 2);
  const req2 = (await rest(elenaToken, `requests?select=id,body&table_id=eq.${tableId}`)).body.find((r) => r.body === ask2).id;
  await dev.page.waitForSelector(`[data-request='${req2}'] button:has-text('Make a poll')`);
  await dev.page.click(`[data-request='${req2}'] button:has-text('Make a poll')`);
  await dev.page.fill("#d-title", "Waiting list: launch or later?");
  await dev.page.fill("input[aria-label='Option 1']", "Build it for launch");
  await dev.page.fill("input[aria-label='Option 2']", "After launch");
  await dev.page.fill("textarea[aria-label^='What Elena Ruiz will be told for option 1']", "The waiting list will be ready at launch.");
  await dev.page.fill("textarea[aria-label^='What Elena Ruiz will be told for option 2']", "The waiting list comes after launch.");
  await dev.page.click("button:has-text('Ask Elena Ruiz first')");
  await dev.page.fill("textarea[aria-label='The question Elena Ruiz will be asked']", "Would you rather have the waiting list at launch, or keep that time for testing?");
  await dev.page.fill("input[aria-label='Answer 1']", "At launch");
  await dev.page.fill("input[aria-label='Answer 2']", "Keep the time for testing");
  await dev.page.click("button:has-text('Start the poll')");
  const d2 = await (async () => { for (;;) { const d = (await rest(ownerToken, `decisions?select=id,request_id&table_id=eq.${tableId}`)).body.find((x) => x.request_id === req2); if (d) return d.id; await sleep(300); } })();
  await owner.page.waitForSelector(`[data-did='${d2}']`);
  await owner.page.locator(`[data-did='${d2}'] button:has-text('Ask Elena Ruiz first')`).click();
  await page.waitForSelector("[data-testid=replies] button:has-text('At launch')", { timeout: 40000 });
  await snap(page, "a-question-for-her-with-answers-to-tap", true);
  await page.click("[data-testid=replies] button:has-text('At launch')");
  await page.waitForFunction((id) => document.querySelector(`[data-request='${id}'] [data-testid=status]`)?.textContent === "With the team", req2, { timeout: 10000 });
  await page.click(`[data-request='${req2}'] button`);
  await snap(page, "she-answered-it-goes-back-to-the-team", true);

  // ---- connecting her own assistant
  await page.click("[data-testid=client-home]");
  await page.waitForSelector("[data-testid=client-tree]");
  await page.click("button:has-text('Connect your assistant')");
  await snap(page, "connect-her-own-assistant-pick-one");
  await page.click("[data-testid=pick-codex]").catch(() => page.click("[data-testid=pick-claude]"));
  await snap(page, "connect-what-she-pastes-into-it", true);
  // Her assistant connects (a stand-in connection plays it, so each state holds still for its picture).
  const code = (await rpc(elenaToken, "start_pairing", { t: tableId, ai_kind: "codex" })).body;
  const device = (await anon("pair_connection", { code, device_label: "look" })).token;
  const pulse = setInterval(() => anon("runner_hello", { token: device }), 8000);
  await sleep(1500);
  await page.keyboard.press("Escape");
  await page.reload();
  await page.waitForSelector("[data-testid=client-tree]");
  await sleep(2200);
  await snap(page, "her-side-with-her-assistant-connected");
  await page.click("[data-testid=me-menu]");
  await snap(page, "her-picture-menu-once-connected");
  await page.keyboard.press("Escape");
  await page.mouse.click(195, 700);

  // ---- talking to her assistant
  await page.click("button:has-text('Open your assistant')");
  await page.waitForSelector("[data-testid=client-chat]");
  const take = async () => { for (let i = 0; i < 60; i++) { const j = await anon("runner_claim", { token: device, lane: "light" }); if (j) return j; await sleep(500); } return null; };
  await page.fill("input[aria-label='Ask the team']", "What did the team say about picking a hygienist?");
  await page.press("input[aria-label='Ask the team']", "Enter");
  const j1 = await take();
  await page.waitForSelector("[data-testid=thinking]").catch(() => {});
  await snap(page, "her-assistant-is-writing", true);
  await anon("runner_finish", { token: device, job: j1.job_id, answer: "The team decided that one already: patients will be able to pick their hygienist when they book, from launch.", info: { pass_on: false, title: "" } });
  await sleep(1500);
  await snap(page, "her-assistant-answers-from-what-she-was-told", true);
  await page.fill("input[aria-label='Ask the team']", "Can reminders also go out on WhatsApp?");
  await page.press("input[aria-label='Ask the team']", "Enter");
  const j2 = await take();
  await anon("runner_finish", { token: device, job: j2.job_id, answer: "That is a new one, so I have passed it on to the team. You will hear here what they decide.", info: { pass_on: true, title: "Reminders on WhatsApp" } });
  await sleep(1500);
  await snap(page, "something-new-her-assistant-passes-it-on", true);

  // ---- the same, dark
  await page.click("[data-testid=me-menu]");
  await page.click("button:has-text('Dark')").catch(() => {});
  await page.mouse.click(195, 760);
  await snap(page, "dark-the-chat", true);
  await page.click("[data-testid=client-home]");
  await sleep(2200);
  await snap(page, "dark-her-side-of-the-table");
  await page.click("[data-testid=me-menu]");
  await page.click("button:has-text('Light')").catch(() => {});
  await page.mouse.click(195, 760);

  // ---- the two other pages she can reach
  await page.goto(`${APP}/privacy`);
  await snap(page, "the-privacy-page", true);

  // ---- what she gets when she tries the team's pages
  await page.goto(`${APP}/t/${tableId}/settings`);
  await snap(page, "trying-the-teams-settings-address-she-gets-her-own-side");
  await page.goto(`${APP}/t/${tableId}?c=general`);
  await sleep(500);
  await snap(page, "trying-the-teams-chat-address-she-gets-her-own-chat", true);

  // ---- taken off the table
  const elenaId = (await rest(ownerToken, `members?select=id,display_name&table_id=eq.${tableId}`)).body.find((m) => m.display_name === "Elena Ruiz").id;
  await rpc(ownerToken, "remove_member", { m: elenaId });
  await page.waitForSelector("text=This page is closed", { timeout: 20000 }).catch(() => {});
  await snap(page, "after-the-team-takes-her-off");
  clearInterval(pulse);
} catch (e) {
  console.error(e.stack || String(e));
  process.exitCode = 1;
} finally {
  await browser.close();
}
console.log(made.join("\n"));
