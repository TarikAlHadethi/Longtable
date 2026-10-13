// Small things on the screens that were wrong: a numbered list in an answer keeps counting past a blank line; a chat
// opened from the table's home starts at its newest message; the Connect window names the table as it is called now;
// the GitHub instructions name every kind of event the table listens for; a client's long chat with an assistant
// shows its newest lines; and an invite link that was already used says so before asking anyone to sign in.
//
//   node tests/e2e/step28-screens.mjs

import { execFileSync } from "node:child_process";
import { APP, inviteLink, join as joinTable, launch, sleep, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "")}`.slice(0, 700); };
const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Booking app", "Maya");
  const table = owner.tableId;
  const p = owner.page;
  const me = sql(`select id from public.members where table_id = '${table}' and role = 'owner'`);
  const chat = sql(`select id from public.chats where table_id = '${table}' and is_general`);

  // ---- a numbered list keeps counting
  sql(`insert into public.messages (table_id, member_id, chat_id, body, by_ai, kind) values ('${table}', '${me}', '${chat}', E'Three steps:\\n\\n1. Pick a day\\n\\n2. Pick a time\\n   - mornings fill first\\n3. Confirm', true, 'answer')`);
  await p.goto(`${APP}/t/${table}?c=general`);
  await p.waitForFunction(() => document.body.innerText.includes("Confirm"), null, { timeout: 15000 });
  const numbers = await p.evaluate(() => [...document.querySelectorAll("[data-testid=messages] ol")].flatMap((ol) => [...ol.children].map((_, i) => ol.start + i)));
  check("a numbered list in an answer counts 1, 2, 3 across a blank line and a bullet under an item", JSON.stringify(numbers) === "[1,2,3]", numbers);

  // ---- a chat opened from the table's home starts at its newest message
  sql(`insert into public.messages (table_id, member_id, chat_id, body) select '${table}', '${me}', '${chat}', 'Line ' || n from generate_series(1, 90) n`);
  await p.goto(`${APP}/t/${table}`);
  await p.waitForSelector("[data-testid=table-home]");
  await sleep(1500);
  await p.click("[data-testid=table-home] button:has-text('Open General')");
  await sleep(1200);
  const fromEnd = await p.evaluate(() => { const el = document.querySelector("[data-testid=messages]"); return el.scrollHeight - el.scrollTop - el.clientHeight; });
  check("a chat opened from the table's home is at its newest message, not its oldest", fromEnd < 80, fromEnd);

  // ---- the Connect window names the table as it is called now
  await p.click("[data-testid=me-menu]");
  await p.click("a:has-text('Table settings')");
  await p.waitForURL(/\/settings$/);
  await p.fill("#s-name", "Fernhill booking");
  await p.click("form[aria-label='The table'] button:has-text('Save')");
  await p.waitForSelector("form[aria-label='The table'] [role=status]");
  await p.click("[data-testid=me-menu]");
  await p.click("button:has-text('Connect my AI')");
  await p.click("[data-testid=pick-claude]");
  await p.click("text=It is only on my computer");
  const message = await p.locator("[data-testid=connect-message]").textContent();
  check("after the table is renamed, the Connect window's message uses the new name", /Fernhill booking/.test(message) && !/Booking app/.test(message), message);
  await p.keyboard.press("Escape");

  // ---- the GitHub instructions name every kind of event the table listens for
  await p.goto(`${APP}/t/${table}/settings`);
  await p.click("button:has-text('Connect a repo')");
  await p.waitForSelector("[data-testid=github-url]");
  const how = await p.evaluate(() => [...document.querySelectorAll(".note")].map((n) => n.textContent).find((t) => /Add webhook/.test(t)) || "");
  check("the webhook instructions say to pick deployment statuses too, which is how a copy's address arrives", /Pushes/.test(how) && /Deployment statuses/i.test(how), how);
  await p.goto(`${APP}/t/${table}?c=general`);

  // ---- an invite link that was already used says so
  const link = await inviteLink(p, "developer");
  const sam = await joinTable(browser, link, `sam-${run}@example.test`, "Sam");
  const stranger = await browser.newContext();
  const q = await stranger.newPage();
  await q.goto(link);
  const says = await q.textContent("main");
  check("a used invite link says it was used, and does not ask a new person to sign in for nothing", /already (been )?used/i.test(says) && (await q.locator("text=Sign in to join").count()) === 0, says);
  await sam.page.goto(link);
  check("the person who used it is not told off for opening it again", !/isn't valid|expired/i.test(await sam.page.textContent("main")), await sam.page.textContent("main"));

} catch (e) {
  check("the run did not crash", false, e.stack || String(e));
} finally {
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
process.exit(Object.values(results).some((v) => v !== "pass") ? 1 : 0);
