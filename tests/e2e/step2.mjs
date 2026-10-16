// Step 2 check: chats, a decision card with the undo window, the activity log, and the client wall.
// Done when a client token fails to read a back-room row in a direct database test.
//
//   node tests/e2e/step2.mjs

import { accessToken, inviteLink, join, launch, rest, rpc, sleep, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = { checks: {} };
const check = (name, ok, detail) => { results.checks[name] = ok ? "pass" : `FAIL ${detail ?? ""}`.trim(); };

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Booking app", "Maya");
  const tableId = owner.tableId;
  const dev = await join(browser, await inviteLink(owner.page, "developer"), `dev-${run}@example.test`, "Sam");
  const client = await join(browser, await inviteLink(owner.page, "client"), `client-${run}@example.test`, "Dr. Ruiz");
  // The client joined after the developer: the developer's screen must learn about them live, without a reload.
  await dev.page.waitForFunction(() => document.body.innerText.includes("Dr. Ruiz"), null, { timeout: 5000 })
    .then(() => check("a person joining reaches the team live", true))
    .catch(() => check("a person joining reaches the team live", false, "Dr. Ruiz never appeared on the developer's screen"));
  await owner.page.waitForFunction(() => document.body.innerText.includes("Dr. Ruiz"), null, { timeout: 5000 });

  // A new chat, made in the sidebar, appears for the developer live.
  await owner.page.click("button[aria-label='New chat']");
  await owner.page.fill("input[aria-label='Name the new chat']", "Booking flow");
  await owner.page.press("input[aria-label='Name the new chat']", "Enter");
  await dev.page.waitForFunction(() => document.body.innerText.includes("Booking flow"), null, { timeout: 5000 });
  check("new chat reaches the developer live", true);

  // Make a poll through the form, with the words the client will be told.
  await owner.page.click("button:has-text('Make a poll')");
  await owner.page.fill("#d-title", "Reminder channel for launch");
  await owner.page.fill("#d-context", "About a day of work.");
  await owner.page.fill("input[aria-label='Option 1']", "Text, email as fallback");
  await owner.page.fill("input[aria-label='Option 2']", "Email only");
  const words1 = "The team decided: reminders go out by text the day before, with email if a text fails.";
  const words2 = "The team decided reminders will go out by email the day before.";
  await owner.page.fill("textarea[aria-label^='What Dr. Ruiz will be told for option 1']", words1);
  await owner.page.fill("textarea[aria-label^='What Dr. Ruiz will be told for option 2']", words2);
  await owner.page.click("button:has-text('Start the poll')");

  // The developer is in another chat. Chats are listed with a "#" and no dot beside them (his picture, 17 Oct 2026); they
  // open the chat with the poll and decide there.
  await dev.page.waitForFunction(() => [...document.querySelectorAll("aside[aria-label=Menu] [data-chat]")].some((el) => /^#\s*Booking flow/.test(el.textContent?.trim() || "")), null, { timeout: 5000 })
    .then(() => check("chats are listed with a # and no dot", true), () => check("chats are listed with a # and no dot", false));
  await dev.page.click("aside[aria-label=Menu] >> text=Booking flow");
  await dev.page.waitForFunction(() => document.body.innerText.includes("Reminder channel for launch"), null, { timeout: 5000 });
  check("the poll is in its chat for the developer", true);
  const devToken = await accessToken(dev.context);
  const clientToken = await accessToken(client.context);
  const ownerToken = await accessToken(owner.context);
  const { body: list } = await rest(devToken, `decisions?select=id,title&table_id=eq.${tableId}`);
  const d1 = list.find((d) => d.title === "Reminder channel for launch")?.id;

  // Picking an option decides nothing (17 Oct 2026): it shows what the client would be told, in words that can be
  // changed, and only Send sends them, at once.
  const cardButton = dev.page.locator(`[data-did='${d1}'] button:has-text('Text, email as fallback')`);
  await cardButton.click();
  const box = dev.page.locator(`[data-did='${d1}'] [data-testid=would-be-told] textarea`);
  await box.waitFor({ timeout: 5000 });
  const shownWords = await box.inputValue();
  const label = await dev.page.textContent(`[data-did='${d1}'] [data-testid=would-be-told] label`);
  await sleep(1500);
  const stillOpen = (await rest(devToken, `decisions?select=status&id=eq.${d1}`)).body[0]?.status;
  const early = await rest(clientToken, `client_updates?select=id,body&table_id=eq.${tableId}`);
  check("picking shows what the client would be told, and decides nothing", shownWords === words1 && /Dr\. Ruiz would be told/.test(label) && stillOpen === "open" && early.body.length === 0,
    JSON.stringify({ shownWords, label, stillOpen, early: early.body }));
  const edited = `${words1} We will start with text.`;
  await box.fill(edited);
  await dev.page.click(`[data-did='${d1}'] [data-testid=send-decision]`);
  const decidedAt = Date.now();
  const words1Sent = edited;

  // The client gets exactly the words as they were sent, at once.
  let late;
  for (let i = 0; i < 20; i++) {
    late = await rest(clientToken, `client_updates?select=id,body,decision_id&table_id=eq.${tableId}`);
    if (late.body.length > 0) break;
    await sleep(500);
  }
  const heardAfter = (Date.now() - decidedAt) / 1000;
  results.clientHeardAfterSeconds = Math.round(heardAfter * 10) / 10;
  check("client hears at once, in the words as they were sent", late.body.length === 1 && late.body[0].body === words1Sent && heardAfter < 6, JSON.stringify(late.body));
  const cardText = await dev.page.textContent(`[data-did='${d1}']`);
  check("the card has no undo", !/Undo/.test(cardText), cardText);
  await dev.page.waitForFunction((id) => /has been told/.test(document.querySelector(`[data-did='${id}']`)?.textContent || ""), d1, { timeout: 5000 });
  check("card says the client has been told", true);

  // Too late to undo once it has gone out, even straight through the database.
  const lateUndo = await rpc(devToken, "undo_decision", { d: d1 });
  check("undo after delivery is refused", lateUndo.status >= 400 && /too late/.test(JSON.stringify(lateUndo.body)), JSON.stringify(lateUndo));

  // A second decision, picked and picked again to let it go: nothing is decided and the client never hears it.
  const made = await rpc(ownerToken, "create_decision", {
    c: (await rest(ownerToken, `chats?select=id&table_id=eq.${tableId}&is_general=eq.true`)).body[0].id,
    title: "Hygienist choice: launch or first update?", context: "", origin: "from Maya", affects_client: true,
    options: [{ label: "Ship it for launch", recommended: true, client_words: "Good news: you can pick a hygienist at launch." },
              { label: "First update", recommended: false, client_words: "Picking a hygienist comes in the first update." }],
  });
  const d2 = made.body;
  await owner.page.click("aside[aria-label=Menu] >> text=General");
  await owner.page.waitForFunction((id) => !!document.querySelector(`[data-did='${id}']`), d2, { timeout: 5000 });
  await owner.page.locator(`[data-did='${d2}'] button:has-text('Ship it for launch')`).click();
  await owner.page.locator(`[data-did='${d2}'] [data-testid=would-be-told]`).waitFor({ timeout: 5000 });
  await owner.page.locator(`[data-did='${d2}'] button:has-text('Ship it for launch')`).click();
  await owner.page.waitForFunction((id) => !document.querySelector(`[data-did='${id}'] [data-testid=would-be-told]`), d2, { timeout: 5000 });
  await sleep(3000);
  const afterUndo = await rest(clientToken, `client_updates?select=decision_id&table_id=eq.${tableId}`);
  const reopened = await rest(ownerToken, `decisions?select=status&id=eq.${d2}`);
  check("a decision that was never sent never reaches the client", afterUndo.body.every((u) => u.decision_id !== d2), JSON.stringify(afterUndo.body));
  check("and is still open", reopened.body[0]?.status === "open", JSON.stringify(reopened.body));

  // The client wall, straight against the database with the client's own token.
  const backRoom = ["chats", "messages", "decisions", "decision_options", "activity"];
  const reads = {};
  for (const t of backRoom) {
    const r = await rest(clientToken, `${t}?select=*&limit=50`);
    reads[t] = Array.isArray(r.body) ? r.body.length : r.status;
  }
  results.clientReads = reads;
  check("client reads zero back-room rows", Object.values(reads).every((n) => n === 0), JSON.stringify(reads));
  const teamReads = {};
  for (const t of ["chats", "decisions", "activity"]) teamReads[t] = (await rest(devToken, `${t}?select=id&table_id=eq.${tableId}`)).body.length;
  check("the team does read them", Object.values(teamReads).every((n) => n > 0), JSON.stringify(teamReads));

  const generalId = (await rest(ownerToken, `chats?select=id&table_id=eq.${tableId}&is_general=eq.true`)).body[0].id;
  const tries = {
    createChat: await rpc(clientToken, "create_chat", { t: tableId, chat_name: "Sneaky", chat_about: "" }),
    createDecision: await rpc(clientToken, "create_decision", { c: generalId, title: "x", context: "", origin: "", affects_client: false,
      options: [{ label: "a" }, { label: "b" }] }),
    decide: await rpc(clientToken, "decide", { d: d2, choice: 1 }),
    insertDecision: await rest(clientToken, "decisions", { method: "POST", body: JSON.stringify({ table_id: tableId, chat_id: generalId, title: "x" }) }),
    insertUpdate: await rest(clientToken, "client_updates", { method: "POST", body: JSON.stringify({ table_id: tableId, body: "fake news" }) }),
  };
  results.clientWrites = Object.fromEntries(Object.entries(tries).map(([k, v]) => [k, v.status]));
  check("client can change nothing", Object.values(tries).every((v) => v.status >= 400), JSON.stringify(results.clientWrites));

  // The activity log is append-only, even for the owner.
  const del = await rest(ownerToken, `activity?table_id=eq.${tableId}`, { method: "DELETE", headers: { Prefer: "return=representation" } });
  const upd = await rest(ownerToken, `activity?table_id=eq.${tableId}`, { method: "PATCH", body: JSON.stringify({ action: "rewritten" }), headers: { Prefer: "return=representation" } });
  const still = await rest(ownerToken, `activity?select=action&table_id=eq.${tableId}`);
  const actions = still.body.map((a) => a.action);
  results.activity = actions.reverse();
  check("owner cannot delete or rewrite the log", (del.body.length ?? 0) === 0 && (upd.body.length ?? 0) === 0 && !actions.includes("rewritten"),
    JSON.stringify({ del: del.status, upd: upd.status }));
  check("the log recorded every step", ["table.started", "member.joined", "chat.created", "decision.created", "decision.decided",
    "decision.delivered"].every((a) => actions.includes(a)), JSON.stringify(actions));

  if (process.env.SCREENSHOTS) {
    await dev.page.setViewportSize({ width: 1440, height: 860 });
    await dev.page.screenshot({ path: `${process.env.SCREENSHOTS}/step2-inbox.png` });
    await owner.page.goto(`${owner.page.url().split("?")[0]}/activity`);
    await owner.page.setViewportSize({ width: 900, height: 860 });
    await owner.page.screenshot({ path: `${process.env.SCREENSHOTS}/step2-activity.png` });
  }
} finally {
  await browser.close();
}

const failed = Object.values(results.checks).filter((v) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
