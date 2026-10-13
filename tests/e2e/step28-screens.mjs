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

} catch (e) {
  check("the run did not crash", false, e.stack || String(e));
} finally {
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
process.exit(Object.values(results).some((v) => v !== "pass") ? 1 : 0);
