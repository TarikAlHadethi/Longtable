// Joining with the table's code: someone who signed up on their own types it in, waits, and is let in by an owner;
// only owners see the code or the people asking; a wrong code says nothing about any table and is limited; a new code
// stops the old one; a locked table takes nobody, by code or by invite; a no stands; a table link someone is not at
// says how to get in.
//
//   node tests/e2e/step51-join-code.mjs

import { execFileSync } from "node:child_process";
import { APP, accessToken, inviteLink, join as joinTable, launch, rest, rpc, signIn, sleep, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 300)}`; };
const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
const ok = (r) => r.status < 300;
const until = async (fn, ms = 12000) => { for (let i = 0; i < ms / 250; i++) { if (await fn()) return true; await sleep(250); } return false; };

// Someone signed in who is at no table yet, on the start page.
async function newcomer(browser, email) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${APP}/start`);
  await signIn(page, email);
  await page.waitForURL(/\/start$/);
  return { context, page, token: await accessToken(context) };
}

const browser = await launch();
try {
  const owner = await startTable(browser, `own-${run}@example.test`, `Fernhill ${run}`, "Maya Stone");
  const T = owner.tableId;
  const sam = await joinTable(browser, await inviteLink(owner.page, "developer"), `sam-${run}@example.test`, "Sam Ali");
  const tok = { maya: await accessToken(owner.context), sam: await accessToken(sam.context) };

  const j = await rpc(tok.maya, "joining", { t: T });
  const code = j.body?.code;
  check("an owner gets the table's code, eight readable letters and digits", ok(j) && /^[A-HJ-NP-Z2-9]{8}$/.test(code) && j.body.locked === false, j);
  check("the same code every time it is asked for", (await rpc(tok.maya, "joining", { t: T })).body?.code === code);
  check("a developer cannot see the code", !ok(await rpc(tok.sam, "joining", { t: T })));
  check("nobody reads the codes table itself", (await rest(tok.maya, `table_joining?table_id=eq.${T}`)).body?.length === 0);

  const priya = await newcomer(browser, `priya-${run}@example.test`);
  const body = await priya.page.textContent("body");
  check("someone new is welcomed with start or join", body.includes("Welcome to Longtable") && await priya.page.isVisible("[data-testid=choose-start]") && await priya.page.isVisible("[data-testid=choose-join]"));

  const wrong = await rpc(priya.token, "ask_to_join", { code: "ZZZZZZZZ", my_name: "Priya" });
  check("a wrong code is refused and names no table", wrong.body?.status === "wrong" && !JSON.stringify(wrong.body).includes("Fernhill"), wrong.body);
  await priya.page.click("[data-testid=choose-join]");
  await priya.page.fill("#join-code", "ZZZZ-ZZZZ");
  await priya.page.fill("#join-me", "Priya Shah");
  await priya.page.click("button:has-text('Ask to join')");
  check("on screen a wrong code says so", await until(async () => (await priya.page.textContent("body")).includes("That code does not match a table")));
  await priya.page.goto(`${APP}/start`);

  // On screen: the code, typed with a dash and in small letters, then a name and a line.
  await priya.page.click("[data-testid=choose-join]");
  await priya.page.fill("#join-code", `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`);
  await priya.page.fill("#join-me", "Priya Shah");
  await priya.page.fill("#join-note", "The new designer");
  await priya.page.click("button:has-text('Ask to join')");
  check("asking shows the table and that they wait", await until(async () => (await priya.page.textContent("[data-testid=join-waits]").catch(() => "")).includes(`Fernhill ${run}`)
    && (await priya.page.textContent("[data-testid=join-waits]")).includes("Waiting for an owner")
    && (await priya.page.textContent("h1")) === "Almost there"));
  const again = await rpc(priya.token, "ask_to_join", { code, my_name: "Priya Shah" });
  check("asking again is the same request, not a second one", again.body?.status === "waiting" && sql(`select count(*) from public.join_requests where table_id = '${T}'`) === "1", again.body);
  check("the table does not let them in by itself", (await rest(priya.token, `members?table_id=eq.${T}`)).body?.length === 0);
  check("the person asking reads their own request", (await rest(priya.token, `join_requests?table_id=eq.${T}`)).body?.length === 1);
  check("a developer reads no one asking", (await rest(tok.sam, `join_requests?table_id=eq.${T}`)).body?.length === 0);
  const seen = (await rest(tok.maya, `join_requests?table_id=eq.${T}&select=name,email,note`)).body?.[0];
  check("an owner sees their name, signed-in address and line", seen?.name === "Priya Shah" && seen?.email === `priya-${run}@example.test` && seen?.note === "The new designer", seen);
  const rid = sql(`select id from public.join_requests where table_id = '${T}'`);
  check("a developer cannot let them in", !ok(await rpc(tok.sam, "answer_join", { r: rid, let_in: true, as_role: "developer" })));
  check("nobody is let in as an owner", !ok(await rpc(tok.maya, "answer_join", { r: rid, let_in: true, as_role: "owner" })));

  // The owner hears at once, and lets her in from Settings, People.
  check("the owner's room shows someone asking, live", await until(() => owner.page.isVisible("[data-testid=asking-badge]")));
  check("in words", (await owner.page.textContent("[data-testid=asking-badge]")).includes("Priya is asking to join"));
  await owner.page.click("[data-testid=asking-badge]");
  await owner.page.waitForSelector("[data-testid=asking-to-join]");
  check("the table code is hidden until shown", await until(async () => (await owner.page.textContent("[data-testid=table-code]")).includes("••••")));
  await owner.page.click("[data-testid=show-code]");
  check("and shown in two fours", (await owner.page.textContent("[data-testid=table-code]")).trim() === `${code.slice(0, 4)}-${code.slice(4)}`);
  await owner.page.click("[data-testid=let-in]");
  check("let in, the request leaves the owner's screen", await until(async () => !(await owner.page.isVisible("[data-testid=asking-to-join]"))));
  check("she is at the table as a developer", sql(`select role from public.members where table_id = '${T}' and display_name = 'Priya Shah' and removed_at is null`) === "developer");
  check("her waiting page moves her into the table", await until(async () => priya.page.url().includes(`/t/${T}`), 15000), priya.page.url());
  check("the log says how she came in", sql(`select count(*) from public.activity where table_id = '${T}' and action = 'member.joined' and details->>'code' = 'true'`) === "1");
  check("asking again once in just opens the table", (await rpc(priya.token, "ask_to_join", { code, my_name: "x" })).body?.status === "member");

  // A no stands for a week.
  const lee = await newcomer(browser, `lee-${run}@example.test`);
  await rpc(lee.token, "ask_to_join", { code, my_name: "Lee" });
  const leeReq = sql(`select id from public.join_requests where table_id = '${T}' and name = 'Lee'`);
  check("an owner can say no", ok(await rpc(tok.maya, "answer_join", { r: leeReq, let_in: false })));
  check("and it cannot be answered twice", !ok(await rpc(tok.maya, "answer_join", { r: leeReq, let_in: true, as_role: "developer" })));
  check("someone told no cannot simply ask again", !ok(await rpc(lee.token, "ask_to_join", { code, my_name: "Lee" })));

  // The table link, for someone not at it.
  await lee.page.goto(`${APP}/t/${T}`);
  check("a table link someone is not at says how to get in", (await lee.page.textContent("body")).includes("You're not at this table") && await lee.page.isVisible("[data-testid=join-with-code]"));
  await lee.page.click("[data-testid=join-with-code]");
  check("and Join with a code opens the code boxes", await until(() => lee.page.isVisible("#join-code")));

  // Cancelling.
  const omar = await newcomer(browser, `omar-${run}@example.test`);
  await rpc(omar.token, "ask_to_join", { code, my_name: "Omar" });
  const omarReq = sql(`select id from public.join_requests where table_id = '${T}' and name = 'Omar'`);
  await rpc(omar.token, "cancel_join", { r: omarReq });
  check("someone can cancel their own request", sql(`select status from public.join_requests where id = '${omarReq}'`) === "cancelled");

  // A new code.
  const renewed = await rpc(tok.maya, "new_join_code", { t: T });
  check("a new code replaces the old", ok(renewed) && renewed.body !== code);
  check("the old code stops working", (await rpc(omar.token, "ask_to_join", { code, my_name: "Omar" })).body?.status === "wrong");
  check("the new one works", (await rpc(omar.token, "ask_to_join", { code: renewed.body, my_name: "Omar" })).body?.status === "waiting");

  // Locking.
  await owner.page.goto(`${APP}/t/${T}?c=general`);
  const early = await inviteLink(owner.page, "developer");
  check("a developer cannot lock the table", !ok(await rpc(tok.sam, "set_table_locked", { t: T, on_: true })));
  check("an owner locks it", ok(await rpc(tok.maya, "set_table_locked", { t: T, on_: true })));
  const zoe = await newcomer(browser, `zoe-${run}@example.test`);
  check("a locked table takes no one by code", !ok(await rpc(zoe.token, "ask_to_join", { code: renewed.body, my_name: "Zoe" })));
  check("makes no invite links", !ok(await rpc(tok.maya, "create_invite", { t: T, invite_role: "developer" })));
  check("takes no invite link sent before", !ok(await rpc(zoe.token, "accept_invite", { token: early.split("/join/")[1], my_name: "Zoe" })));
  const omarReq2 = sql(`select id from public.join_requests where table_id = '${T}' and name = 'Omar' and status = 'waiting'`);
  check("and lets nobody waiting in until unlocked", !ok(await rpc(tok.maya, "answer_join", { r: omarReq2, let_in: true, as_role: "client" })));
  await rpc(tok.maya, "set_table_locked", { t: T, on_: false });
  check("unlocked, the invite sent before works again", ok(await rpc(zoe.token, "accept_invite", { token: early.split("/join/")[1], my_name: "Zoe" })));
  check("and someone waiting is let in as a client", ok(await rpc(tok.maya, "answer_join", { r: omarReq2, let_in: true, as_role: "client" }))
    && sql(`select role from public.members where table_id = '${T}' and display_name = 'Omar'`) === "client");

  // Guessing.
  const kim = await newcomer(browser, `kim-${run}@example.test`);
  for (let i = 0; i < 10; i++) await rpc(kim.token, "ask_to_join", { code: `QQQQQQ${String(i).padStart(2, "2").replace(/[01]/g, "3")}`, my_name: "Kim" });
  const tenth = await rpc(kim.token, "ask_to_join", { code: renewed.body, my_name: "Kim" });
  check("after ten wrong codes even the right one waits an hour", !ok(tenth) && JSON.stringify(tenth.body).includes("Too many"), tenth.body);
  check("signed-out callers cannot ask", !ok(await rest("", "rpc/ask_to_join", { method: "POST", body: JSON.stringify({ code: renewed.body, my_name: "x" }) })));
} catch (e) {
  check("the run finished", false, String(e?.stack || e));
} finally {
  await browser.close();
}
const failed = Object.entries(results).filter(([, v]) => v !== "pass");
console.log(JSON.stringify(results, null, 2));
console.log(`${Object.keys(results).length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
