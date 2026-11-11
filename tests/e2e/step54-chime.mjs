// A sound when someone is needed, on the screen: being named in the chat in front of you makes none, a message that
// does not name you makes none, being named in another chat chimes, a client writing chimes, what was already there
// when a page opened makes none, the team writing to a client chimes on their page, and Sound off in the picture
// menu stops it and is kept.
//
//   node --experimental-websocket tests/e2e/step54-chime.mjs

import { execFileSync } from "node:child_process";
import { accessToken, APP, inviteLink, join as joinTable, launch, rest, rpc, sleep, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 300)}`; };
const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
const chimes = (page) => page.evaluate(() => window.__ltChimes ?? 0);
const until = async (fn, ms = 12000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(300); } return v; };
// The sound plays at most once every three seconds, so each check waits that out first.
const settle = () => sleep(3300);

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Chimes", "Maya Stone");
  const T = owner.tableId;
  const sam = await joinTable(browser, await inviteLink(owner.page, "developer"), `sam-${run}@example.test`, "Sam Ali");
  const elena = await joinTable(browser, await inviteLink(owner.page, "client"), `elena-${run}@example.test`, "Elena Ruiz");
  const tok = { maya: await accessToken(owner.context), sam: await accessToken(sam.context), elena: await accessToken(elena.context) };
  const room = (name) => rpc(tok.maya, "make_chat", { t: T, chat_name: name, chat_about: "", who: "everyone", people: [], take_notes: false, ai_answers: "normal" }).then((r) => r.body);
  const design = await room("Design");
  const launchChat = await room("Launch");
  const samId = sql(`select id from public.members where table_id = '${T}' and display_name = 'Sam Ali'`);
  // A plain message goes in the way the room sends one.
  const say = (c, body) => rest(tok.sam, "messages", { method: "POST", body: JSON.stringify({ table_id: T, chat_id: c, member_id: samId, body }) });

  // Maya has the Design chat open in front of her.
  await owner.page.goto(`${APP}/t/${T}?c=${design}`);
  await owner.page.waitForSelector("[data-testid=messages]");
  await owner.page.mouse.click(5, 5);
  await settle();

  let at = await chimes(owner.page);
  await say(design, "Maya can you look at the header here?");
  await sleep(2000);
  check("being named in the chat in front of you makes no sound", (await chimes(owner.page)) === at, { at, now: await chimes(owner.page) });

  await say(launchChat, "the build is green");
  await sleep(2000);
  check("a message that does not name you makes no sound", (await chimes(owner.page)) === at, { at, now: await chimes(owner.page) });

  await settle();
  at = await chimes(owner.page);
  await say(launchChat, "@Maya we need your call on the launch date");
  check("being named in another chat chimes", await until(async () => (await chimes(owner.page)) > at), { at, now: await chimes(owner.page) });

  await settle();
  at = await chimes(owner.page);
  await rpc(tok.elena, "client_say", { t: T, body: "hi, quick question about my booking", files: [] });
  check("a client writing chimes for the owner", await until(async () => (await chimes(owner.page)) > at), { at, now: await chimes(owner.page) });

  // The client's page: what is there on opening is quiet, the team writing to them chimes.
  await elena.page.goto(`${APP}/t/${T}`);
  await elena.page.waitForSelector("[data-testid=client-box]");
  await elena.page.mouse.click(5, 5);
  await sleep(2000);
  check("what was already there when a page opened makes no sound", (await chimes(elena.page)) === 0, await chimes(elena.page));
  const elenaId = sql(`select id from public.members where table_id = '${T}' and display_name = 'Elena Ruiz'`);
  await rpc(tok.maya, "team_say", { m: elenaId, words: "Hi Elena, does Tuesday work?" });
  check("the team writing to a client chimes on their page", await until(async () => (await chimes(elena.page)) > 0, 20000), await chimes(elena.page));

  // Sound off stops it, and is kept.
  await settle();
  await owner.page.click("[data-testid=me-menu]");
  await owner.page.click("[data-testid=sound-off]");
  await owner.page.keyboard.press("Escape");
  at = await chimes(owner.page);
  await say(launchChat, "Maya one more thing");
  await sleep(2500);
  check("Sound off in the picture menu stops it", (await chimes(owner.page)) === at, { at, now: await chimes(owner.page) });
  check("and it is kept", (await owner.page.evaluate(() => localStorage.getItem("lt-sound"))) === "off");
} finally {
  await browser.close();
}

const failed = Object.entries(results).filter(([, v]) => v !== "pass");
for (const [k, v] of Object.entries(results)) console.log(`${v === "pass" ? "pass" : "FAIL"}  ${k}${v === "pass" ? "" : "  " + v.slice(5)}`);
console.log(`\n${Object.keys(results).length - failed.length} of ${Object.keys(results).length} passed`);
process.exit(failed.length ? 1 : 0);
