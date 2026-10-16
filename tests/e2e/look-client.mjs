// Every screen a client can see, on a phone, as pictures. A walk through one client's whole time at a table: the
// invite, the first look, asking, a decision, a question back, their own assistant, dark mode, and being taken off.
// Writes numbered PNGs to the folder in SCREENSHOTS.
//
//   SCREENSHOTS=<folder> node --experimental-websocket tests/e2e/look-client.mjs

import { execFileSync } from "node:child_process";
import { accessToken, API, APP, inviteLink, join, KEY, launch, rest, rpc, sleep, startTable } from "./lib.mjs";


// A poll about a client's request is made from under the box (17 Oct 2026: no poll link and no status pill under a
// client's message any more): open it, then pick the request in its menu.
async function pollFor(page, title) {
  await page.click("button:has-text('Make a poll') >> nth=-1");
  await page.waitForSelector("form[aria-label='Make a poll']");
  await page.click("form[aria-label='Make a poll'] button[aria-haspopup=listbox]");
  await page.click(`form[aria-label='Make a poll'] [role=option]:has-text(${JSON.stringify(title)})`);
  await page.waitForSelector("[data-testid=asked]");
}

const out = process.env.SCREENSHOTS;
if (!out) throw new Error("Set SCREENSHOTS to a folder.");
const run = Date.now().toString(36);
const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
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
  const scroller = "[data-testid=client-chat]";
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
  const elenaId0 = (await rest(ownerToken, `members?select=id,display_name&table_id=eq.${tableId}`)).body.find((m) => m.display_name === "Elena Ruiz").id;
  const elenaToken = await accessToken(elena.context);

  // ---- the first look
  await page.goto(`${APP}/t/${tableId}`);
  await page.waitForSelector("[data-testid=client-chat]");
  await snap(page, "first-look-one-page-one-box");
  await page.click("[data-testid=me-menu]");
  await snap(page, "her-menu-everything-else-lives-here");
  await page.keyboard.press("Escape");
  await page.mouse.click(195, 500);

  // ---- she asks; the team decides
  const ask = "Some patients only want to see Sofia. Can they pick a specific hygienist when they book?";
  await page.fill("[aria-label='Ask the team']", ask);
  await page.press("[aria-label='Ask the team']", "Enter");
  await page.waitForSelector("[data-request]");
  await snap(page, "she-asked-it-is-with-the-team", true);
  const reqId = (await rest(elenaToken, `requests?select=id&table_id=eq.${tableId}`)).body[0].id;

  await dev.page.waitForSelector(`[data-request='${reqId}']`);
  await pollFor(dev.page, (await rest(ownerToken, `requests?select=title&id=eq.${reqId}`)).body[0].title);
  await dev.page.fill("#d-title", "Hygienist choice: launch or first update?");
  await dev.page.fill("input[aria-label='Option 1']", "Ship it for launch");
  await dev.page.fill("input[aria-label='Option 2']", "First update");
  await dev.page.fill("textarea[aria-label^='What Elena Ruiz will be told for option 1']", "Good news: patients will be able to pick their hygienist when they book, from launch.");
  await dev.page.fill("textarea[aria-label^='What Elena Ruiz will be told for option 2']", "Picking a hygienist comes in the first update after launch.");
  await dev.page.click("button:has-text('Start the poll')");
  await sleep(2500);
  await snap(page, "the-team-is-deciding", true);

  const d1 = (await rest(ownerToken, `decisions?select=id,request_id&table_id=eq.${tableId}`)).body.find((x) => x.request_id === reqId).id;
  await owner.page.locator(`[data-did='${d1}'] button:has-text('Ship it for launch')`).click();
  await page.waitForFunction((id) => document.querySelector(`[data-testid=panel-request][data-id='${id}']`)?.getAttribute("data-state") === "decided", reqId, { timeout: 40000 }).catch(() => {});
  await snap(page, "decided-she-is-told-in-the-teams-chosen-words", true);

  // ---- the team asks her something back
  const ask2 = "Could we also have a waiting list for cancelled slots?";
  await page.fill("[aria-label='Ask the team']", ask2);
  await page.press("[aria-label='Ask the team']", "Enter");
  await page.waitForFunction(() => document.querySelectorAll("[data-request]").length >= 2);
  const req2 = (await rest(elenaToken, `requests?select=id,body&table_id=eq.${tableId}`)).body.find((r) => r.body === ask2).id;
  await dev.page.waitForSelector(`[data-request='${req2}']`);
  await pollFor(dev.page, (await rest(ownerToken, `requests?select=title&id=eq.${req2}`)).body[0].title);
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
  await page.waitForSelector(`[data-request='${req2}']`, { timeout: 10000 });
  await snap(page, "she-answered-it-goes-back-to-the-team", true);

  // ---- connecting her own assistant
  await page.click("[data-testid=me-menu]");
  await page.click("button:has-text('Connect my assistant')");
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
  await page.waitForSelector("[data-testid=client-chat][data-with=assistant]");
  await page.click("[data-testid=me-menu]");
  await snap(page, "her-menu-once-her-assistant-is-connected");
  await page.keyboard.press("Escape");
  await page.mouse.click(195, 500);

  // ---- talking to her assistant
  const take = async () => { for (let i = 0; i < 60; i++) { const j = await anon("runner_claim", { token: device, lane: "light" }); if (j) return j; await sleep(500); } return null; };
  await page.fill("[aria-label='Ask the team']", "What did the team say about picking a hygienist?");
  await page.press("[aria-label='Ask the team']", "Enter");
  const j1 = await take();
  await page.waitForSelector("[data-testid=thinking]").catch(() => {});
  await snap(page, "her-assistant-is-writing", true);
  await anon("runner_finish", { token: device, job: j1.job_id, answer: "The team decided that one already: patients will be able to pick their hygienist when they book, from launch.", info: { pass_on: false, title: "" } });
  await sleep(1500);
  await snap(page, "her-assistant-answers-from-what-she-was-told", true);
  await page.fill("[aria-label='Ask the team']", "Can reminders also go out on WhatsApp?");
  await page.press("[aria-label='Ask the team']", "Enter");
  const j2 = await take();
  await anon("runner_finish", { token: device, job: j2.job_id, answer: "That is a new one, so I have passed it on to the team. You will hear here what they decide.", info: { pass_on: true, title: "Reminders on WhatsApp" } });
  await sleep(1500);
  await snap(page, "something-new-her-assistant-passes-it-on", true);

  // ---- the same, dark
  await page.click("[data-testid=me-menu]");
  await page.click("button:has-text('Dark')").catch(() => {});
  await page.mouse.click(195, 760);
  await snap(page, "dark-the-chat", true);
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

  // ---- a copy of her own: the owner turns it on, and what she says is built there for her to try
  await rpc(ownerToken, "disconnect", { conn: (await rest(elenaToken, `connections?select=id&table_id=eq.${tableId}`)).body[0]?.id }).catch(() => {});
  clearInterval(pulse);
  const teamCode = (await rpc(ownerToken, "start_pairing", { t: tableId, ai_kind: "claude" })).body;
  const teamDevice = (await anon("pair_connection", { code: teamCode, device_label: "look" })).token;
  sql(`update public.jobs set status = 'skipped' where table_id = '${tableId}' and kind = 'intro'`);
  const teamPulse = setInterval(() => anon("runner_hello", { token: teamDevice }), 8000);
  const heavy = async () => { for (let i = 0; i < 60; i++) { const j = await anon("runner_claim", { token: teamDevice, lane: "heavy" }); if (j) return j; await sleep(500); } return null; };
  await rpc(ownerToken, "prepare_client_sandbox", { m: elenaId0 });
  const place = await heavy();
  await anon("runner_finish", { token: teamDevice, job: place.job_id, answer: "", info: { commit: "a".repeat(40) } });
  await rpc(ownerToken, "set_sandbox_links", { t: tableId, ours: "", cap: 20, m: elenaId0, theirs: "https://elena-copy.example.test" });
  await rpc(ownerToken, "set_client_sandbox", { m: elenaId0, enabled: true, made_up_data: true, no_real_keys: true });
  await page.goto(`${APP}/t/${tableId}`);
  await page.waitForSelector("[data-testid=client-chat][data-with=copy]");
  await snap(page, "a-copy-of-her-own-the-first-time");
  await page.fill("[aria-label='Ask the team']", "Make the booking button bigger and green, and put it at the top of the page.");
  await page.press("[aria-label='Ask the team']", "Enter");
  const c1 = await heavy();
  await page.waitForSelector("[data-change]");
  await snap(page, "her-change-is-being-built");
  await anon("runner_finish", { token: teamDevice, job: c1.job_id, answer: "The booking button is larger and green now, and it sits at the top of the page. Open the booking page to try it.", info: { changed: true, commit: "c".repeat(40), files: ["app/booking/page.tsx"], detail: "Moved the button." } });
  await rpc(ownerToken, "set_sandbox_links", { t: tableId, ours: "", cap: 20, m: elenaId0, theirs: "https://elena-copy.example.test" });
  await page.waitForSelector("[data-testid=try-it]", { timeout: 20000 });
  await page.reload();
  await page.waitForSelector("[data-testid=try-it]");
  await snap(page, "ready-she-can-try-it");
  await page.fill("[aria-label='Ask the team']", "Actually make it a bit smaller, and blue instead.");
  await page.press("[aria-label='Ask the team']", "Enter");
  const c2 = await heavy();
  await anon("runner_finish", { token: teamDevice, job: c2.job_id, answer: "It is a little smaller and blue now. Have another look on the booking page.", info: { changed: true, commit: "d".repeat(40), files: ["app/booking/page.tsx"], detail: "Restyled." } });
  await page.fill("[aria-label='Ask the team']", "Can patients pay a deposit when they book?");
  await page.press("[aria-label='Ask the team']", "Enter");
  const c3 = await heavy();
  await anon("runner_finish", { token: teamDevice, job: c3.job_id, answer: "Taking payments is one for the team to decide, so I have passed it on. You will hear here what they decide.", info: { pass_on: true, title: "Deposits when booking" } });
  await sleep(1500);
  const cs = (await rest(ownerToken, `sandbox_changes?select=id,status&table_id=eq.${tableId}&order=created_at`)).body;
  await rpc(ownerToken, "judge_change", { change: cs[1].id, answer: "take" });
  await rpc(ownerToken, "judge_change", { change: cs[0].id, answer: "no", said: "We went with the smaller blue one you asked for after this." });
  await page.reload();
  await page.waitForSelector("[data-testid=verdict]");
  await snap(page, "what-the-team-made-of-each-change", true);
  clearInterval(teamPulse);

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
