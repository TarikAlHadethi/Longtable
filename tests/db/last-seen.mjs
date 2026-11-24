// Last seen, and a message shown once: a page says when its person last had a Longtable tab open; the team reads
// everyone's, a client and another table read nothing and cannot say it for someone else; the sidebar shows "Seen ..."
// under someone who is away and their window "Last seen ..."; and a message sent from the box is on screen once, never
// twice for a moment while its own live copy arrives before the send has finished.
//
//   node --experimental-websocket tests/db/last-seen.mjs

import { execFileSync } from "node:child_process";
import { accessToken, APP, inviteLink, join as joinTable, launch, rpc, sleep, startTable } from "../lib.mjs";

const run = Date.now().toString(36);
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 300)}`; };
const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(300); } return v; };

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Last seen", "Maya Stone");
  const T = owner.tableId;
  const sam = await joinTable(browser, await inviteLink(owner.page, "developer"), `sam-${run}@example.test`, "Sam Ali");
  const elena = await joinTable(browser, await inviteLink(owner.page, "client"), `elena-${run}@example.test`, "Elena Ruiz");
  const other = await startTable(browser, `other-${run}@example.test`, "Elsewhere", "Omar Nader");
  const tok = { maya: await accessToken(owner.context), sam: await accessToken(sam.context), elena: await accessToken(elena.context), omar: await accessToken(other.context) };
  const id = (name) => sql(`select id from public.members where table_id = '${T}' and display_name = '${name}'`);
  const samId = id("Sam Ali"), elenaId = id("Elena Ruiz");

  // Each open page has said it is here.
  const said = await until(() => Number(sql(`select count(*) from public.member_seen where table_id = '${T}'`)) >= 3);
  check("each person's open page says when they were last here", said, sql(`select count(*) from public.member_seen where table_id = '${T}'`));

  const read = async (who) => { const r = await rpc(tok[who], "last_seen", { t: T }); return Array.isArray(r.body) ? r.body : []; };
  check("the team reads everyone's last seen", (await read("maya")).length >= 3 && (await read("sam")).length >= 3);
  check("a client reads nobody's", (await read("elena")).length === 0);
  check("someone at another table reads nothing", (await read("omar")).length === 0);
  await rpc(tok.omar, "i_am_here", { t: T });
  check("nobody can say they were here at a table they are not at", Number(sql(`select count(*) from public.member_seen where table_id = '${T}' and member_id not in (select id from public.members where table_id = '${T}')`)) === 0);
  check("signed out, neither works", (await fetch(`${process.env.SUPABASE_URL || "http://127.0.0.1:54321"}/rest/v1/rpc/last_seen`, { method: "POST", headers: { apikey: "x", "Content-Type": "application/json" }, body: JSON.stringify({ t: T }) })).status >= 400);

  // Sam closes his tab; he was last here two hours ago.
  await sam.page.close();
  // Two hours ago is "Yesterday" when run just after midnight.
  sql(`update public.member_seen set at = now() - interval '2 hours 5 minutes' where member_id = '${samId}'`);
  sql(`update public.member_seen set at = now() - interval '7 minutes' where member_id = '${elenaId}'`);
  await elena.page.close();
  await owner.page.reload();
  await owner.page.waitForSelector("[data-testid=messages]");
  // The short time beside the name ("2h"), with the whole of it ("Seen 2 hours ago") on pointing.
  const line = async (name) => { const at = owner.page.locator(`[data-member="${name}"] [data-testid=seen-short]`); return (await at.count()) ? `${await at.innerText()} ${await at.getAttribute("title")}` : ""; };
  check("the sidebar says when someone away was last seen", await until(async () => /^(2h|1d) Seen (2 hours ago|Yesterday)/.test(await line("Sam Ali"))), await line("Sam Ali"));
  check("a client's too, for the team", await until(async () => /^7m Seen 7 min ago/.test(await line("Elena Ruiz"))), await line("Elena Ruiz"));
  check("someone here now shows no last seen", !/Seen/.test(await line("Maya Stone")), await line("Maya Stone"));
  await owner.page.click(`[data-member="Sam Ali"]`);
  const win = owner.page.locator("[data-testid=last-seen]");
  check("their window says when they were last seen", await until(async () => /Last seen (2 hours ago|Yesterday)/.test(await win.innerText().catch(() => ""))), await win.innerText().catch(() => ""));
  await owner.page.keyboard.press("Escape");
  await sleep(500);

  // A message from the box is on screen once, from the moment it is sent until well after it arrived.
  await owner.page.evaluate(() => {
    window.__most = 0;
    const count = () => { for (const i of [0, 1, 2]) { const n = [...document.querySelectorAll("[data-mid]")].filter((e) => e.textContent?.includes(`shown once please ${i}`)).length; window.__most = Math.max(window.__most, n); } };
    new MutationObserver(count).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  for (let i = 0; i < 3; i++) {
    await owner.page.fill("textarea", `shown once please ${i}`);
    await owner.page.keyboard.press("Enter");
    await sleep(2500);
  }
  const each = await owner.page.evaluate(() => [0, 1, 2].map((i) => [...document.querySelectorAll("[data-mid]")].filter((e) => e.textContent?.includes(`shown once please ${i}`)).length));
  check("a sent message is shown once, never twice for a moment", (await owner.page.evaluate(() => window.__most)) <= 1 && each.every((n) => n === 1), { most: await owner.page.evaluate(() => window.__most), each });
} finally {
  await browser.close();
}

const failed = Object.entries(results).filter(([, v]) => v !== "pass");
for (const [name, v] of Object.entries(results)) console.log(`${v === "pass" ? "pass" : "FAIL"}  ${name}${v === "pass" ? "" : "  " + v.slice(5)}`);
console.log(`\n${Object.keys(results).length - failed.length} of ${Object.keys(results).length} passed`);
process.exit(failed.length ? 1 : 0);
