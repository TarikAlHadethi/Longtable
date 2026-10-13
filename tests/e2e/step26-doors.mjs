// Two doors that must only open one way. Signing in sends a person on to a page of this site and never to another
// site named in the link, however the link spells it. And the check that a client's copy opens without a sign-in,
// which the server makes itself, is the owner's alone and never reaches a machine on a private network.
//
//   node tests/e2e/step26-doors.mjs

import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { APP, inviteLink, join as joinTable, launch, signIn, sleep, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "")}`.slice(0, 700); };
const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();

const browser = await launch();
// Something listening on this computer, to see whether the server ever comes knocking.
let knocks = 0;
const inside = createServer((socket) => { knocks++; socket.destroy(); });
await new Promise((done) => inside.listen(0, "127.0.0.1", done));
try {
  // ---- signing in never sends anyone to another site
  for (const [spelling, next] of [["a tab", "/%09/example.test/x"], ["a new line", "/%0A/example.test/x"], ["a backslash further in", "/%09%5Cexample.test/x"]]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const away = [];
    page.on("request", (r) => { if (/example\.test/.test(new URL(r.url()).host)) away.push(r.url()); });
    await page.goto(`${APP}/sign-in?next=${next}`);
    await signIn(page, `${spelling.replace(/\W+/g, "")}-${run}@example.test`);
    await page.waitForURL((u) => !/\/sign-in/.test(u.pathname), { timeout: 15000 }).catch(() => {});
    await sleep(1500);
    check(`a link that hides another site behind ${spelling} still lands on this site after signing in`, away.length === 0 && page.url().startsWith(APP), { url: page.url(), away });
    await context.close();
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${APP}/sign-in?next=/start?from=door`);
  await signIn(page, `plain-${run}@example.test`);
  await page.waitForURL((u) => u.pathname === "/start", { timeout: 15000 }).catch(() => {});
  check("and an ordinary page of this site is still where they are sent", page.url() === `${APP}/start?from=door`, { url: page.url(), says: (await page.textContent("main").catch(() => "")).slice(0, 200) });
  await context.close();

  // ---- the copy check
  const owner = await startTable(browser, `owner-${run}@example.test`, "Booking app", "Maya");
  const sam = await joinTable(browser, await inviteLink(owner.page, "developer"), `sam-${run}@example.test`, "Sam");
  const elena = await joinTable(browser, await inviteLink(owner.page, "client"), `elena-${run}@example.test`, "Elena Ruiz");
  const member = sql(`select id from public.members where table_id = '${owner.tableId}' and role = 'client'`);
  const ask = async (who, data = { member }) => {
    const started = Date.now();
    const res = await who.context.request.post(`${APP}/api/sandbox/check`, { data, timeout: 30000 });
    return { status: res.status(), body: await res.json().catch(() => null), ms: Date.now() - started };
  };
  // An address nothing answers at: whoever makes the server go there waits out its nine seconds.
  sql(`insert into public.sandboxes (table_id, member_id, branch, url) values ('${owner.tableId}', '${member}', 'longtable/sandbox-doors-${run}', 'https://192.0.2.1/') on conflict (member_id) do update set url = excluded.url`);
  const dev = await ask(sam);
  check("a developer asking is refused at once, before the server goes anywhere", dev.status === 403 && dev.ms < 4000, dev);
  const client = await ask(elena);
  check("a client asking learns nothing", client.status >= 400 && client.ms < 4000, client);
} catch (e) {
  check("the run did not crash", false, e.stack || String(e));
} finally {
  inside.close();
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
process.exit(Object.values(results).some((v) => v !== "pass") ? 1 : 0);
