// Step 6 check, settings and people: the owner invites by name, changes the table's settings, picks who writes the
// final answer, and takes a person off the table, whose page closes at once and who then reads nothing; a new
// invite brings them back. Nobody but the owner can change any of it.
//
//   node tests/e2e/step6-settings.mjs

import { accessToken, APP, inviteLink, join, launch, rest, rpc, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = { checks: {} };
const check = (name, ok, detail) => { results.checks[name] = ok ? "pass" : `FAIL ${detail ?? ""}`.trim(); };

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Booking app", "Maya");
  const tableId = owner.tableId;

  // Invite by name: the join page arrives filled in.
  await owner.page.click("[data-testid=me-menu]");
  await owner.page.click("text=Invite people");
  await owner.page.fill("input[aria-label='Their name']", "Sam Lee");
  await owner.page.fill("input[aria-label='Their email']", `sam-${run}@example.test`);
  await owner.page.click("text=A developer");
  const link = (await owner.page.textContent("[data-testid=invite-link]")).trim();
  await owner.page.click("[data-testid=invite-close]");
  const samContext = await browser.newContext();
  const sam = await samContext.newPage();
  await sam.goto(link);
  await sam.click("text=Sign in to join");
  const { signIn } = await import("./lib.mjs");
  await signIn(sam, `sam-${run}@example.test`);
  await sam.waitForURL(/\/join\//);
  const prefilled = await sam.inputValue("#me");
  check("an invite by name arrives filled in", prefilled === "Sam Lee", prefilled);
  await sam.click("button:has-text('Join')");
  await sam.waitForURL(/\/t\/[0-9a-f-]{36}$/);
  const client = await join(browser, await inviteLink(owner.page, "client"), `client-${run}@example.test`, "Dr. Ruiz");

  // A chat for client requests, then the settings page.
  await owner.page.click("button[aria-label='New chat']");
  await owner.page.fill("input[aria-label='Name the new chat']", "Client asks");
  await owner.page.press("input[aria-label='Name the new chat']", "Enter");
  await owner.page.waitForFunction(() => document.body.innerText.includes("Client asks"));
  await owner.page.click("[data-testid=me-menu]");
  await owner.page.click("a:has-text('Table settings')");
  await owner.page.waitForURL(/\/settings$/);
  await owner.page.fill("#s-name", "Fernhill booking");
  await owner.page.fill("#s-undo", "20");
  await owner.page.selectOption("#s-requests", { label: "Client asks" });
  await owner.page.click("form[aria-label='The table'] button:has-text('Save')");
  await owner.page.waitForSelector("form[aria-label='The table'] [role=status]");
  await owner.page.selectOption("#s-seat", { label: "Sam Lee's" });
  await owner.page.check("input[name=offline] >> nth=1");
  await owner.page.click("form[aria-label='Final answers'] button:has-text('Save')");
  await owner.page.waitForSelector("form[aria-label='Final answers'] [role=status]");

  const [ownerToken, samToken, clientToken] = await Promise.all([owner.context, samContext, client.context].map(accessToken));
  const t = (await rest(ownerToken, `tables?select=name,undo_seconds,client_chat,final_seat,when_final_offline&id=eq.${tableId}`)).body[0];
  const people = (await rest(ownerToken, `members?select=id,display_name&table_id=eq.${tableId}`)).body;
  const samId = people.find((p) => p.display_name === "Sam Lee")?.id;
  const askChat = (await rest(ownerToken, `chats?select=id&table_id=eq.${tableId}&name=eq.Client asks`)).body[0]?.id;
  results.table = t;
  check("the settings save", t.name === "Fernhill booking" && t.undo_seconds === 20 && t.client_chat === askChat
    && t.final_seat === samId && t.when_final_offline === "next", JSON.stringify(t));

  // A client's ask lands in the chat the owner chose.
  await rpc(clientToken, "client_ask", { t: tableId, body: "Can we add a waiting list?" });
  const landed = (await rest(ownerToken, `messages?select=chat_id&table_id=eq.${tableId}&kind=eq.client`)).body;
  check("client requests land where the owner chose", landed.length === 1 && landed[0].chat_id === askChat, JSON.stringify(landed));

  // The rules: no undo window under 5 seconds, and only the owner changes anything.
  const tries = {
    undoZero: await rpc(ownerToken, "update_table", { t: tableId, table_name: "x", undo: 0, requests_chat: null }),
    devSettings: await rpc(samToken, "update_table", { t: tableId, table_name: "Taken", undo: 10, requests_chat: null }),
    clientSettings: await rpc(clientToken, "update_table", { t: tableId, table_name: "Taken", undo: 10, requests_chat: null }),
    devSeat: await rpc(samToken, "set_final_seat", { t: tableId, seat: null, offline: "wait" }),
    devRemove: await rpc(samToken, "remove_member", { m: people.find((p) => p.display_name === "Maya").id }),
    clientInvite: await rpc(clientToken, "create_invite", { t: tableId, invite_role: "developer", invite_name: "", invite_email: "" }),
    ownerRemovesSelf: await rpc(ownerToken, "remove_member", { m: people.find((p) => p.display_name === "Maya").id }),
  };
  results.refused = Object.fromEntries(Object.entries(tries).map(([k, v]) => [k, v.status]));
  check("only the owner changes settings and people, and never to no undo", Object.values(tries).every((v) => v.status >= 400), JSON.stringify(results.refused));

  // Taking Sam off: his page closes live, he reads nothing, and the owner's list drops him.
  await sam.goto(`${APP}/t/${tableId}?c=general`);
  await sam.waitForFunction(() => !document.body.innerText.includes("Connecting"), null, { timeout: 10000 });
  await owner.page.goto(`${APP}/t/${tableId}/settings`);
  await owner.page.click("[data-person='Sam Lee'] button:has-text('Take off the table')");
  await owner.page.click("[data-person='Sam Lee'] button:has-text('Take Sam off')");
  const closed = await sam.waitForFunction(() => document.body.innerText.includes("no longer at this table"), null, { timeout: 10000 })
    .then(() => true, () => false);
  check("his page closes at once", closed);
  const samReads = {
    tables: (await rest(samToken, `tables?select=id&id=eq.${tableId}`)).body.length,
    messages: (await rest(samToken, `messages?select=id&table_id=eq.${tableId}`)).body.length,
    members: (await rest(samToken, `members?select=id&table_id=eq.${tableId}`)).body.length,
  };
  const samWrite = await rest(samToken, "messages", { method: "POST", body: JSON.stringify({ table_id: tableId, chat_id: askChat, member_id: samId, body: "still here?" }) });
  results.samReads = samReads;
  check("taken off, he reads and writes nothing", Object.values(samReads).every((n) => n === 0) && samWrite.status >= 400, JSON.stringify({ ...samReads, write: samWrite.status }));
  const seatAfter = (await rest(ownerToken, `tables?select=final_seat&id=eq.${tableId}`)).body[0].final_seat;
  check("his seat stops writing final answers", seatAfter === null, String(seatAfter));
  await owner.page.goto(`${APP}/t/${tableId}?c=general`);
  const ownerSees = await owner.page.evaluate(() => document.querySelector("aside")?.innerText ?? "");
  check("he is gone from the people list", !ownerSees.includes("Sam Lee"), ownerSees.slice(0, 300));

  // A new invite brings him back.
  const again = await inviteLink(owner.page, "developer");
  await sam.goto(again);
  await sam.fill("#me", "Sam Lee");
  await sam.click("button:has-text('Join')");
  await sam.waitForURL(/\/t\/[0-9a-f-]{36}$/);
  const back = (await rest(samToken, `messages?select=id&table_id=eq.${tableId}`)).status === 200
    && (await rest(samToken, `tables?select=id&id=eq.${tableId}`)).body.length === 1;
  check("a new invite brings him back", back);

  const actions = (await rest(ownerToken, `activity?select=action&table_id=eq.${tableId}`)).body.map((a) => a.action);
  check("the log recorded it", ["settings.changed", "settings.final_seat", "member.removed", "invite.created"].every((a) => actions.includes(a)), JSON.stringify(actions));

  if (process.env.SCREENSHOTS) {
    await owner.page.goto(`${APP}/t/${tableId}/settings`);
    await owner.page.setViewportSize({ width: 1100, height: 1000 });
    await owner.page.screenshot({ path: `${process.env.SCREENSHOTS}/step6-settings.png`, fullPage: true });
  }
} finally {
  await browser.close();
}

const failed = Object.values(results.checks).filter((v) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
