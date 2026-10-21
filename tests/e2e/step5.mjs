// Step 5 check, the client page half: a client asks in their own words; the team sees it live as a client card and
// decides it; the client follows it on their page and hears the answer in the decision's own words. Two clients at
// one table never see or hear each other's requests, and the client seat still reads nothing of the back room.
// The Codex half of step 5 needs a real Codex app and is not in this file.
//
//   node --experimental-websocket tests/e2e/step5.mjs     (Node 20; on Node 22 plain node works)

import { execFileSync } from "node:child_process";
import { API, KEY, accessToken, inviteLink, join, launch, listen, rest, rpc, sleep, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = { checks: {} };
const check = (name, ok, detail) => { results.checks[name] = ok ? "pass" : `FAIL ${detail ?? ""}`.trim(); };
const textOf = (page) => page.evaluate(() => document.body.innerText);
const statusOn = (page, id, testid) => page.evaluate(([i, t]) => document.querySelector(`[data-request='${i}'] [data-testid=${t}]`)?.textContent ?? null, [id, testid]);
const waitStatus = (page, id, testid, words, timeout = 5000) => page.waitForFunction(([i, t, w]) =>
  document.querySelector(`[data-request='${i}'] [data-testid=${t}]`)?.textContent === w, [id, testid, words], { timeout });

// A poll about a client's request is made from under the box (17 Oct 2026: no poll link and no status pill under a
// client's message any more): open it, then pick the request in its menu.
async function pollFor(page, title) {
  await page.locator("textarea").first().fill("/poll"); await page.locator("textarea").first().press("Enter");
  await page.waitForSelector("form[aria-label='Make a poll']");
  await page.click("form[aria-label='Make a poll'] button[aria-haspopup=listbox]");
  await page.click(`form[aria-label='Make a poll'] [role=option]:has-text(${JSON.stringify(title)})`);
  await page.waitForSelector("[data-testid=asked]");
}
// Where a request stands, read from the database as the team.
const reqStatus = async (token, id) => (await rest(token, `requests?select=status&id=eq.${id}`)).body?.[0]?.status ?? null;
const waitReq = async (token, id, status, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 250))) if ((await reqStatus(token, id)) === status) return true; return false; };

// A call with no one signed in: the public key only, no session.
const signedOut = async (fn, args) => (await fetch(`${API}/rest/v1/rpc/${fn}`, {
  method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(args),
})).status;

const browser = await launch();
const listeners = [];
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Fernhill Dental booking", "Maya");
  const tableId = owner.tableId;
  const dev = await join(browser, await inviteLink(owner.page, "developer"), `dev-${run}@example.test`, "Sam");
  const elena = await join(browser, await inviteLink(owner.page, "client"), `elena-${run}@example.test`, "Elena Ruiz");
  const priya = await join(browser, await inviteLink(owner.page, "client"), `priya-${run}@example.test`, "Priya Shah");

  // The client lands on their own page, never the team's room.
  await elena.page.waitForSelector("[data-testid=client-chat]");
  const firstLook = (await textOf(elena.page)).toLowerCase();
  check("the client gets their own page", firstLook.includes("this is where you talk to the team") && !firstLook.includes("what's done so far?")
    && !["ask the table", "inbox", "general"].some((w) => firstLook.includes(w)), firstLook.slice(0, 300));

  const [ownerToken, devToken, elenaToken, priyaToken] = await Promise.all([owner, dev, elena, priya].map((p) => accessToken(p.context)));
  const people = (await rest(ownerToken, `members?select=id,display_name&table_id=eq.${tableId}`)).body;
  const idOf = (name) => people.find((p) => p.display_name === name)?.id;
  const elenaId = idOf("Elena Ruiz");

  // On the wire: Elena may open her own channel; Priya may not, and on the channel every client shares she must
  // never hear Elena's requests.
  const elenaOwn = await listen(elenaToken, `client:${tableId}:${elenaId}`);
  const priyaSpy = await listen(priyaToken, `client:${tableId}:${elenaId}`);
  const priyaShared = await listen(priyaToken, `client:${tableId}`);
  listeners.push(elenaOwn, priyaSpy, priyaShared);
  results.channels = { elenaOwn: elenaOwn.status, priyaOnElenas: priyaSpy.status, priyaShared: priyaShared.status };
  check("a client can open their own channel", elenaOwn.status === "SUBSCRIBED" && priyaShared.status === "SUBSCRIBED", JSON.stringify(results.channels));
  check("another client cannot open it", priyaSpy.status === "CHANNEL_ERROR", priyaSpy.status);

  // Elena asks, in her own words, from her page.
  const ask = "Some patients only want to see Sofia. Can they pick a specific hygienist when they book?";
  await elena.page.fill("[aria-label='Ask the team']", ask);
  const askedAt = Date.now();
  await elena.page.press("[aria-label='Ask the team']", "Enter");
  await elena.page.waitForSelector("[data-request]");
  const reqId = await elena.page.getAttribute("[data-request]", "data-request");
  check("her page shows the request, with no state on it anywhere", await waitReq(ownerToken, reqId, "asked") && !/With the team|What you asked/.test(await textOf(elena.page)));

  // The team sees it live, as a client card with a way to decide it.
  await dev.page.waitForSelector(`[data-request='${reqId}']`, { timeout: 5000 });
  results.teamSawItAfterMs = Date.now() - askedAt;
  const card = await dev.page.textContent(`[data-request='${reqId}']`);
  check("the team sees it live as her message, with no status pill and no poll link under it", card.includes(ask) && card.includes("client") && !card.includes("New request") && !card.includes("Make a poll"), card);

  // Priya sees none of it, on her page or in the database.
  await priya.page.reload();
  await priya.page.waitForSelector("[data-testid=client-chat]");
  const priyaLook = await textOf(priya.page);
  const priyaReads = {
    requests: (await rest(priyaToken, `requests?select=id&table_id=eq.${tableId}`)).body.length,
    timeline: (await rest(priyaToken, `request_events?select=id&table_id=eq.${tableId}`)).body.length,
    toldAboutIt: (await rest(priyaToken, `client_updates?select=id&request_id=eq.${reqId}`)).body.length,
  };
  results.otherClientReads = priyaReads;
  check("another client sees none of it", !priyaLook.includes(ask) && Object.values(priyaReads).every((n) => n === 0), JSON.stringify(priyaReads));

  // The developer opens a decision from the card. It starts from her words, and she will hear the answer.
  const reqTitle = (await rest(ownerToken, `requests?select=title&id=eq.${reqId}`)).body[0].title;
  await pollFor(dev.page, reqTitle);
  const form = "form[aria-label='Make a poll']";
  const prefilled = {
    title: await dev.page.inputValue("#d-title"),
    asked: await dev.page.textContent("[data-testid=asked]"),
    hears: await dev.page.isChecked(`${form} input[type=checkbox]`),
    locked: await dev.page.isDisabled(`${form} input[type=checkbox]`),
  };
  check("the decision starts from the request", prefilled.title === ask && prefilled.asked.includes("Elena Ruiz asked") && prefilled.asked.includes(ask)
    && prefilled.hears && prefilled.locked, JSON.stringify(prefilled));
  await dev.page.fill("#d-title", "Hygienist choice: launch or first update?");
  await dev.page.fill("input[aria-label='Option 1']", "Ship it for launch");
  await dev.page.fill("input[aria-label='Option 2']", "First update");
  const yes = "Good news: patients will be able to pick their hygienist when they book, from launch.";
  const later = "Picking a hygienist comes in the first update after launch.";
  await dev.page.fill("textarea[aria-label^='What Elena Ruiz will be told for option 1']", yes);
  await dev.page.fill("textarea[aria-label^='What Elena Ruiz will be told for option 2']", later);
  await dev.page.click("button:has-text('Start the poll')");

  // Her page moves to Being decided, live; the team's card follows and the button goes.
  check("she sees it being decided, live", await waitReq(ownerToken, reqId, "being decided") && await waitReq(ownerToken, reqId, "being decided", 20000));
  await owner.page.locator("textarea").first().fill("/poll"); await owner.page.locator("textarea").first().press("Enter");
  await owner.page.click("form[aria-label='Make a poll'] button[aria-haspopup=listbox]").catch(() => {});
  const offered = await owner.page.locator("form[aria-label='Make a poll'] [role=option]").allTextContents().catch(() => []);
  await owner.page.keyboard.press("Escape");
  await owner.page.keyboard.press("Escape");
  check("a request being decided is not offered for a second poll", !offered.some((t) => t.includes(reqTitle)), offered);

  const { body: ds } = await rest(ownerToken, `decisions?select=id,request_id,affects_client,origin&table_id=eq.${tableId}`);
  const d = ds.find((x) => x.request_id === reqId);
  check("the decision is tied to her request", !!d && d.affects_client && d.origin === "requested by Elena Ruiz", JSON.stringify(ds));

  // A reply from the team's assistant before the decision, as when an AI passed her words on: the decision must read
  // after it, at its own time, not up beside her question.
  const assistantSaid = "Passed on to the team for you.";
  execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-qAt", "-c",
    `insert into public.client_lines (table_id, member_id, who, body, by_table) select table_id, member_id, 'assistant', '${assistantSaid}', true from public.requests where id = '${reqId}'`]);
  await elena.page.reload();
  await elena.page.waitForFunction((w) => document.querySelector("[data-testid=client-chat]")?.textContent?.includes(w), assistantSaid, { timeout: 20000 });

  // The owner picks and sends. She hears the chosen option's own words, and only those, at once.
  await owner.page.locator(`[data-did='${d.id}'] button:has-text('Ship it for launch')`).click();
  await owner.page.click(`[data-did='${d.id}'] [data-testid=send-decision]`);
  const decidedAt = Date.now();
  await elena.page.waitForFunction((w) => document.querySelector("[data-testid=client-chat]")?.textContent?.includes(w), yes, { timeout: 30000 });
  results.heardAfterSeconds = Math.round((Date.now() - decidedAt) / 100) / 10;
  await waitReq(ownerToken, reqId, "decided", 30000);
  // A request and what the team said about it, each at its own time in the conversation.
  const timeline = (await elena.page.$$eval(`[data-request='${reqId}']`, (els) => els.map((el) => el.textContent))).join(" ");
  const order = await elena.page.evaluate(([said, words]) => { const t = document.querySelector("[data-testid=client-chat]")?.textContent ?? ""; return [t.indexOf(said), t.indexOf(words)]; }, [assistantSaid, yes]);
  check("her conversation reads in order: the assistant's reply, then the decision", order[0] >= 0 && order[1] > order[0], order);
  results.timeline = timeline;
  check("she hears it at once, in the chosen words, under what she asked", results.heardAfterSeconds < 8 && [ask, yes].every((w) => timeline.includes(w)) && !timeline.includes("Passed on to the team"),
    `${results.heardAfterSeconds} s, ${timeline}`);
  // The conversation, not the panel: the panel shows her team's faces and first names on purpose (17 Oct 2026).
  const elenaLook = await elena.page.textContent("[data-testid=client-chat]");
  check("the team's own words never reach her", !["Hygienist choice", "Ship it for launch", "First update", later, "Maya", "Sam"].some((w) => elenaLook.includes(w)),
    elenaLook.slice(0, 600));
  check("the request is decided for the team too", await waitReq(ownerToken, reqId, "decided"));

  // What went over the wire: Elena heard her request, its timeline and the answer; Priya heard nothing of it.
  await sleep(500);
  const tablesHeard = elenaOwn.heard.map((m) => m.table);
  results.elenaHeard = tablesHeard;
  check("her own channel carried it live", ["requests", "request_events", "client_updates"].every((t) => tablesHeard.includes(t))
    && elenaOwn.heard.some((m) => m.record?.body === yes), JSON.stringify(tablesHeard));
  const leaked = [...priyaSpy.heard, ...priyaShared.heard].filter((m) => JSON.stringify(m).includes(reqId) || JSON.stringify(m).includes("hygienist"));
  check("another client heard nothing of it", leaked.length === 0, JSON.stringify(leaked).slice(0, 400));

  // The client wall, straight against the database with her own token.
  const backRoom = ["chats", "messages", "decisions", "decision_options", "activity", "jobs", "connections", "notes"];
  const reads = {};
  for (const t of backRoom) {
    const r = await rest(elenaToken, `${t}?select=*&limit=50`);
    reads[t] = Array.isArray(r.body) ? r.body.length : `refused ${r.status}`;
  }
  results.clientReads = reads;
  check("she reads zero back-room rows", Object.values(reads).every((n) => n === 0 || String(n).startsWith("refused 4")), JSON.stringify(reads));
  const own = {
    requests: (await rest(elenaToken, `requests?select=id&table_id=eq.${tableId}`)).body.length,
    timeline: (await rest(elenaToken, `request_events?select=id&request_id=eq.${reqId}`)).body.length,
    told: (await rest(elenaToken, `client_updates?select=body&request_id=eq.${reqId}`)).body.map((u) => u.body),
  };
  results.clientOwnReads = own;
  check("she reads her own request, timeline and answers", own.requests === 1 && own.timeline >= 3 && own.told.includes(yes) && !own.told.includes(later), JSON.stringify(own));

  const generalId = (await rest(ownerToken, `chats?select=id&table_id=eq.${tableId}&is_general=eq.true`)).body[0].id;
  const tries = {
    insertRequest: await rest(elenaToken, "requests", { method: "POST", body: JSON.stringify({ table_id: tableId, member_id: elenaId, title: "x", body: "x" }) }),
    insertEvent: await rest(elenaToken, "request_events", { method: "POST", body: JSON.stringify({ request_id: reqId, table_id: tableId, label: "Done, trust me" }) }),
    addEvent: await rpc(elenaToken, "add_request_event", { req: reqId, words: "Done, trust me" }),
    decideOwnRequest: await rpc(elenaToken, "create_decision", { c: generalId, title: "x", context: "", origin: "", affects_client: true,
      options: [{ label: "a" }, { label: "b" }], request: reqId }),
    decide: await rpc(elenaToken, "decide", { d: d.id, choice: 2 }),
  };
  results.clientWrites = Object.fromEntries(Object.entries(tries).map(([k, v]) => [k, v.status]));
  const patched = await rest(elenaToken, `requests?id=eq.${reqId}`, { method: "PATCH", body: JSON.stringify({ status: "done" }), headers: { Prefer: "return=representation" } });
  const removed = await rest(elenaToken, `requests?id=eq.${reqId}`, { method: "DELETE", headers: { Prefer: "return=representation" } });
  const after = (await rest(ownerToken, `requests?select=status&id=eq.${reqId}`)).body[0]?.status;
  check("she can change nothing but by asking", Object.values(tries).every((v) => v.status >= 400)
    && (patched.body.length ?? 0) === 0 && (removed.body.length ?? 0) === 0 && after === "decided",
    JSON.stringify({ ...results.clientWrites, patch: patched.status, delete: removed.status, after }));

  // Only a client asks this way, and not with nothing.
  const teamAsks = await rpc(devToken, "client_ask", { t: tableId, body: "Make it pink" });
  const emptyAsk = await rpc(elenaToken, "client_ask", { t: tableId, body: "   " });
  check("only a client can ask, and not with nothing", teamAsks.status >= 400 && emptyAsk.status >= 400,
    JSON.stringify({ team: teamAsks.body?.message, empty: emptyAsk.body?.message }));

  // Who may call what: delivery is the scheduler's alone, and signed-out callers reach none of the functions people
  // use after signing in. The invite preview, which the join page shows before sign-in, still answers them.
  const outside = {
    startTable: await signedOut("start_table", { table_name: "x", my_name: "x" }),
    acceptInvite: await signedOut("accept_invite", { token: "x", my_name: "x" }),
    askTable: await signedOut("ask_table", { c: generalId, body: "x" }),
    createInvite: await signedOut("create_invite", { t: tableId, invite_role: "client" }),
    startPairing: await signedOut("start_pairing", { t: tableId, ai_kind: "claude" }),
    disconnect: await signedOut("disconnect", { conn: tableId }),
    clientAsk: await signedOut("client_ask", { t: tableId, body: "x" }),
  };
  const preview = await signedOut("invite_preview", { token: "x" });
  const deliver = { team: (await rpc(devToken, "deliver_due", {})).status, client: (await rpc(elenaToken, "deliver_due", {})).status };
  results.grants = { signedOut: outside, preview, deliver };
  check("only the scheduler delivers, and signed-out callers reach nothing", Object.values(outside).every((n) => n === 401)
    && preview < 400 && Object.values(deliver).every((n) => n === 403), JSON.stringify(results.grants));

  const actions = (await rest(ownerToken, `activity?select=action&table_id=eq.${tableId}`)).body.map((a) => a.action);
  check("the log recorded the ask", actions.includes("client.asked") && actions.includes("decision.delivered"), JSON.stringify(actions));

  // Ask the client first: the team puts a question to Elena; she answers with one tap; it goes back to the team.
  const ask3 = "Could we have a waiting list for cancelled slots?";
  await elena.page.fill("[aria-label='Ask the team']", ask3);
  await elena.page.press("[aria-label='Ask the team']", "Enter");
  await elena.page.waitForFunction((t) => document.body.innerText.includes(t), ask3, { timeout: 5000 });
  // Her words show at once; the request itself lands a moment later.
  let req3;
  for (let i = 0; i < 40 && !req3; i++) { req3 = (await rest(elenaToken, `requests?select=id,body&table_id=eq.${tableId}`)).body.find((r) => r.body === ask3)?.id; if (!req3) await sleep(250); }
  await dev.page.waitForSelector(`[data-request='${req3}']`, { timeout: 5000 });
  await pollFor(dev.page, (await rest(ownerToken, `requests?select=title&id=eq.${req3}`)).body[0].title);
  await dev.page.fill("#d-title", "Waiting list: launch or later?");
  await dev.page.fill("input[aria-label='Option 1']", "Build it for launch");
  await dev.page.fill("input[aria-label='Option 2']", "After launch");
  await dev.page.fill("textarea[aria-label^='What Elena Ruiz will be told for option 1']", "The waiting list will be ready at launch.");
  await dev.page.fill("textarea[aria-label^='What Elena Ruiz will be told for option 2']", "The waiting list comes after launch.");
  await dev.page.click("button:has-text('Ask Elena Ruiz first')");
  const question = "Would you rather have the waiting list at launch, or keep that time for testing?";
  await dev.page.fill("textarea[aria-label='The question Elena Ruiz will be asked']", question);
  await dev.page.fill("input[aria-label='Answer 1']", "At launch");
  await dev.page.fill("input[aria-label='Answer 2']", "Keep the time for testing");
  await dev.page.click("button:has-text('Start the poll')");
  await waitReq(ownerToken, req3, "being decided");
  let d3;
  for (let i = 0; i < 40 && !d3; i++) { d3 = (await rest(ownerToken, `decisions?select=id,request_id&table_id=eq.${tableId}`)).body.find((x) => x.request_id === req3)?.id; if (!d3) await sleep(250); }
  await owner.page.waitForSelector(`[data-did='${d3}']`, { timeout: 5000 });
  await owner.page.locator(`[data-did='${d3}'] button:has-text('Ask Elena Ruiz first')`).click();
  await owner.page.waitForFunction((id) => /Elena Ruiz would be asked/.test(document.querySelector(`[data-did='${id}']`)?.textContent || ""), d3, { timeout: 5000 });
  const ownerSees = await owner.page.textContent(`[data-did='${d3}']`);
  await owner.page.click(`[data-did='${d3}'] [data-testid=send-decision]`);
  check("the card shows the question and its answers", ownerSees.includes("Ask Elena Ruiz first") && ownerSees.includes("At launch") && ownerSees.includes("Keep the time for testing"), ownerSees);

  // After the window, the question reaches her with its answers, and the request is a question for her.
  await elena.page.waitForSelector("[data-testid=replies] button:has-text('At launch')", { timeout: 30000 });
  await waitReq(ownerToken, req3, "question", 15000);
  if (process.env.SCREENSHOTS) await elena.page.screenshot({ path: `${process.env.SCREENSHOTS}/step5-question.png` });
  const qLook = await elena.page.textContent("[data-testid=client-chat]");
  check("she gets the question with answers to tap", qLook.includes(question) && !qLook.includes("Build it for launch"), qLook.slice(-400));
  await elena.page.click("[data-testid=replies] button:has-text('At launch')");
  await waitReq(ownerToken, req3, "answered", 15000);
  const answeredLine = (await elena.page.$$eval(`[data-request='${req3}']`, (els) => els.map((el) => el.textContent))).join(" ");
  const repliesLeft = await elena.page.locator("[data-testid=replies]").count();
  check("her tap answers it, once", answeredLine.includes("You answered: At launch") && repliesLeft === 0, `${answeredLine} / ${repliesLeft} left`);

  // Her answer reaches the team live, as a client card that offers the next decision.
  const answered = await waitReq(ownerToken, req3, "answered");
  await dev.page.waitForFunction((id) => [...document.querySelectorAll(`[data-request='${id}']`)].some((el) => el.textContent.includes("At launch")), req3, { timeout: 5000 }).catch(() => {});
  const cards = await dev.page.$$eval(`[data-request='${req3}']`, (els) => els.map((el) => el.textContent));
  check("the team gets her answer and can decide again", answered && cards.some((t) => t.includes("Answering: " + "Would you rather") && t.includes("At launch")),
    JSON.stringify(cards));

  // Only she answers, and only once.
  const q = (await rest(elenaToken, `client_updates?select=id,replies,answer&request_id=eq.${req3}`)).body.find((u) => u.replies.length > 0);
  const again = {
    twice: (await rpc(elenaToken, "client_reply", { u: q.id, choice: 2 })).status,
    otherClient: (await rpc(priyaToken, "client_reply", { u: q.id, choice: 2 })).status,
    team: (await rpc(devToken, "client_reply", { u: q.id, choice: 2 })).status,
    rewrite: (await rest(elenaToken, `client_updates?id=eq.${q.id}`, { method: "PATCH", body: JSON.stringify({ answer: "Keep the time for testing" }), headers: { Prefer: "return=representation" } })).body.length ?? 0,
  };
  const stored = (await rest(ownerToken, `client_updates?select=answer&id=eq.${q.id}`)).body[0]?.answer;
  results.answerOnce = { ...again, stored };
  check("only she answers, and only once", again.twice >= 400 && again.otherClient >= 400 && again.team >= 400 && again.rewrite === 0 && stored === "At launch",
    JSON.stringify(results.answerOnce));

  // A lost push only delays. With every live push to their pages dropped, Elena and Sam still find out from the
  // database: her page checks while the team is on something she asked, his when he comes back to the tab.
  let dropPushes = false;
  const dropper = (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => {
      if (dropPushes && (typeof m !== "string" || m.includes('"broadcast"'))) return;
      ws.send(m);
    });
  };
  await elena.page.routeWebSocket(/\/realtime\/v1\/websocket/, dropper);
  await dev.page.routeWebSocket(/\/realtime\/v1\/websocket/, dropper);
  await Promise.all([elena.page.reload(), dev.page.reload()]);
  await elena.page.waitForSelector("[data-testid=client-chat]");
  // The team's page has really joined its channel (joining reads the database, which would catch it up early).
  await dev.page.waitForSelector("[data-live]", { timeout: 15000 });
  await sleep(1500);
  dropPushes = true;
  const ask2 = "Could the booking page show prices for each treatment?";
  await elena.page.fill("[aria-label='Ask the team']", ask2);
  await elena.page.press("[aria-label='Ask the team']", "Enter");
  await elena.page.waitForFunction((t) => document.body.innerText.includes(t), ask2, { timeout: 5000 });
  let req2;
  for (let i = 0; i < 40 && !req2; i++) { req2 = (await rest(elenaToken, `requests?select=id,body&table_id=eq.${tableId}`)).body.find((r) => r.body === ask2)?.id; if (!req2) await sleep(250); }
  await rpc(devToken, "create_decision", { c: generalId, title: "Prices on the booking page", context: "", origin: "requested by Elena Ruiz",
    affects_client: true, request: req2, options: [{ label: "Show prices", recommended: true, client_words: "Prices will show on the booking page." },
      { label: "Not yet", recommended: false, client_words: "Prices come in a later update." }] });
  await sleep(3000);
  const stale = { team: (await textOf(dev.page)).includes("Prices on the booking page") };
  await dev.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const teamCaughtUp = await dev.page.waitForFunction(() => document.body.innerText.includes("Prices on the booking page"), null, { timeout: 5000 }).then(() => true, () => false);
  const clientCaughtUp = await waitReq(ownerToken, req2, "being decided", 25000);
  results.lostPushes = { stale, teamCaughtUp, clientCaughtUp };
  // The team's page waits for its next read; the client's page reads every few seconds while an answer is forming,
  // so it may have caught up already. Either way, nothing is lost.
  check("a lost push only delays", !stale.team && teamCaughtUp && clientCaughtUp, JSON.stringify(results.lostPushes));

  if (process.env.SCREENSHOTS) {
    await elena.page.setViewportSize({ width: 1280, height: 860 });
    await elena.page.screenshot({ path: `${process.env.SCREENSHOTS}/step5-client.png` });
    await dev.page.setViewportSize({ width: 1440, height: 860 });
    await dev.page.screenshot({ path: `${process.env.SCREENSHOTS}/step5-team.png` });
  }
} finally {
  for (const l of listeners) await l.stop();
  await browser.close();
}

const failed = Object.values(results.checks).filter((v) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
