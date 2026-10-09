// Step 5 check, the client page half: a client asks in their own words; the team sees it live as a client card and
// decides it; the client follows it on their page and hears the answer in the decision's own words. Two clients at
// one table never see or hear each other's requests, and the client seat still reads nothing of the back room.
// The Codex half of step 5 needs a real Codex app and is not in this file.
//
//   node --experimental-websocket tests/e2e/step5.mjs     (Node 20; on Node 22 plain node works)

import { API, KEY, accessToken, inviteLink, join, launch, listen, rest, rpc, sleep, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = { checks: {} };
const check = (name, ok, detail) => { results.checks[name] = ok ? "pass" : `FAIL ${detail ?? ""}`.trim(); };
const textOf = (page) => page.evaluate(() => document.body.innerText);
const statusOn = (page, id, testid) => page.evaluate(([i, t]) => document.querySelector(`[data-request='${i}'] [data-testid=${t}]`)?.textContent ?? null, [id, testid]);
const waitStatus = (page, id, testid, words, timeout = 5000) => page.waitForFunction(([i, t, w]) =>
  document.querySelector(`[data-request='${i}'] [data-testid=${t}]`)?.textContent === w, [id, testid, words], { timeout });

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
  await elena.page.waitForSelector("text=What you asked for");
  const firstLook = (await textOf(elena.page)).toLowerCase();
  check("the client gets their own page", ["what you asked for", "with the team", "the team"].every((w) => firstLook.includes(w))
    && !["chats", "ask the table", "inbox", "general"].some((w) => firstLook.includes(w)), firstLook.slice(0, 300));

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
  await elena.page.fill("input[aria-label='Ask the team']", ask);
  const askedAt = Date.now();
  await elena.page.press("input[aria-label='Ask the team']", "Enter");
  await elena.page.waitForSelector("[data-request]");
  const reqId = await elena.page.getAttribute("[data-request]", "data-request");
  await waitStatus(elena.page, reqId, "status", "With the team");
  await elena.page.waitForFunction(() => document.querySelector("[data-testid=client-chat]")?.textContent?.includes("Passed on to the team"), null, { timeout: 5000 });
  check("her page shows the request and the team's note", true);

  // The team sees it live, as a client card with a way to decide it.
  await dev.page.waitForFunction((id) => !!document.querySelector(`[data-request='${id}'] [data-testid=request-status]`), reqId, { timeout: 5000 });
  results.teamSawItAfterMs = Date.now() - askedAt;
  const card = await dev.page.textContent(`[data-request='${reqId}']`);
  check("the team sees it live as a client card", card.includes(ask) && card.includes("client") && card.includes("New request") && card.includes("Ask for a decision"), card);

  // Priya sees none of it, on her page or in the database.
  await priya.page.reload();
  await priya.page.waitForSelector("text=What you asked for");
  const priyaLook = await textOf(priya.page);
  const priyaReads = {
    requests: (await rest(priyaToken, `requests?select=id&table_id=eq.${tableId}`)).body.length,
    timeline: (await rest(priyaToken, `request_events?select=id&table_id=eq.${tableId}`)).body.length,
    toldAboutIt: (await rest(priyaToken, `client_updates?select=id&request_id=eq.${reqId}`)).body.length,
  };
  results.otherClientReads = priyaReads;
  check("another client sees none of it", !priyaLook.includes(ask) && Object.values(priyaReads).every((n) => n === 0), JSON.stringify(priyaReads));

  // The developer opens a decision from the card. It starts from her words, and she will hear the answer.
  await dev.page.click(`[data-request='${reqId}'] button:has-text('Ask for a decision')`);
  await dev.page.waitForSelector("[data-testid=asked]");
  const form = "form[aria-label='Ask for a decision']";
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
  await dev.page.click("button:has-text('Put it in the inbox')");

  // Her page moves to Being decided, live; the team's card follows and the button goes.
  await waitStatus(elena.page, reqId, "status", "Being decided");
  await waitStatus(owner.page, reqId, "request-status", "Being decided");
  check("she sees it being decided, live", true);
  const ownerCard = await owner.page.textContent(`[data-request='${reqId}']`);
  check("the card stops offering a second decision", !ownerCard.includes("Ask for a decision"), ownerCard);

  const { body: ds } = await rest(ownerToken, `decisions?select=id,request_id,affects_client,origin&table_id=eq.${tableId}`);
  const d = ds.find((x) => x.request_id === reqId);
  check("the decision is tied to her request", !!d && d.affects_client && d.origin === "requested by Elena Ruiz", JSON.stringify(ds));

  // The owner decides. After the undo window she hears the chosen option's own words, and only those.
  await owner.page.locator(`aside[aria-label='Inbox'] [data-did='${d.id}'] button:has-text('Ship it for launch')`).click();
  const decidedAt = Date.now();
  await elena.page.waitForFunction((w) => document.querySelector("[data-testid=client-chat]")?.textContent?.includes(w), yes, { timeout: 30000 });
  results.heardAfterSeconds = Math.round((Date.now() - decidedAt) / 100) / 10;
  await waitStatus(elena.page, reqId, "status", "Decided");
  await elena.page.click(`[data-request='${reqId}'] button`);
  const timeline = await elena.page.textContent(`[data-request='${reqId}'] ol`);
  results.timeline = timeline;
  check("she hears it after the window, in the chosen words", results.heardAfterSeconds >= 9 && ["You asked", "The team is deciding", yes].every((w) => timeline.includes(w)),
    `${results.heardAfterSeconds} s, ${timeline}`);
  const elenaLook = await textOf(elena.page);
  check("the team's own words never reach her", !["Hygienist choice", "Ship it for launch", "First update", later, "Maya", "Sam"].some((w) => elenaLook.includes(w)),
    elenaLook.slice(0, 600));
  await waitStatus(dev.page, reqId, "request-status", "Decided");
  check("the team's card shows it decided", true);

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
  await elena.page.waitForSelector("text=What you asked for");
  await dev.page.waitForFunction(() => !document.body.innerText.includes("Connecting"), null, { timeout: 10000 });
  dropPushes = true;
  const ask2 = "Could the booking page show prices for each treatment?";
  await elena.page.fill("input[aria-label='Ask the team']", ask2);
  await elena.page.press("input[aria-label='Ask the team']", "Enter");
  await elena.page.waitForFunction((t) => document.body.innerText.includes(t), ask2, { timeout: 5000 });
  const req2 = (await rest(elenaToken, `requests?select=id,body&table_id=eq.${tableId}`)).body.find((r) => r.body === ask2)?.id;
  await rpc(devToken, "create_decision", { c: generalId, title: "Prices on the booking page", context: "", origin: "requested by Elena Ruiz",
    affects_client: true, request: req2, options: [{ label: "Show prices", recommended: true, client_words: "Prices will show on the booking page." },
      { label: "Not yet", recommended: false, client_words: "Prices come in a later update." }] });
  await sleep(3000);
  const stale = { client: await statusOn(elena.page, req2, "status"), team: (await textOf(dev.page)).includes("Prices on the booking page") };
  await dev.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const teamCaughtUp = await dev.page.waitForFunction(() => document.body.innerText.includes("Prices on the booking page"), null, { timeout: 5000 }).then(() => true, () => false);
  const clientCaughtUp = await waitStatus(elena.page, req2, "status", "Being decided", 20000).then(() => true, () => false);
  results.lostPushes = { stale, teamCaughtUp, clientCaughtUp };
  check("a lost push only delays", stale.client === "With the team" && !stale.team && teamCaughtUp && clientCaughtUp, JSON.stringify(results.lostPushes));

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
