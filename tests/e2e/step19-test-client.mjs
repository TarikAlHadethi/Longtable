// A test client: the owner tries the client's side for real with nobody invited, then takes it off again.
//
//   node --experimental-websocket tests/e2e/step19-test-client.mjs

import { accessToken, inviteLink, join as joinTable, launch, rest, rpc, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = { checks: {} };
const check = (name, ok, detail) => { results.checks[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "")}`.slice(0, 1500); };

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Booking app", "Maya");
  const dev = await joinTable(browser, await inviteLink(owner.page, "developer"), `dev-${run}@example.test`, "Sam");
  const p = owner.page;
  const token = await accessToken(owner.context);
  const devToken = await accessToken(dev.context);

  check("a developer has no Client side button while no client is here", (await dev.page.locator("[data-testid=client-portal]").count()) === 0);
  check("a developer cannot add a test client", (await rpc(devToken, "add_test_client", { t: owner.tableId })).status >= 400);

  await p.click("[data-testid=client-portal]");
  await p.click("[data-testid=add-test-client]");
  await p.waitForSelector("[data-testid=client-view] [data-testid=client-chat]");
  check("the owner is told they are trying it as a test client", /test client/.test(await p.textContent("[data-testid=viewing]")));
  check("the box can be written in", !(await p.isDisabled("[data-testid=client-view] [aria-label='Ask the team']")));

  await p.fill("[aria-label='Ask the team']", "Can the title be bigger?");
  await p.press("[aria-label='Ask the team']", "Enter");
  await p.waitForFunction(() => document.querySelector("[data-testid=client-chat]")?.textContent.includes("Can the title be bigger?"), null, { timeout: 15000 });
  check("what the owner asks as the test client shows on the client's side", true);
  // The words show at once; the request lands a moment later.
  let reqs = { body: [] };
  for (let i = 0; i < 40 && !reqs.body?.length; i++) { reqs = await rest(devToken, `requests?select=id,body,member_id&table_id=eq.${owner.tableId}`); if (!reqs.body?.length) await new Promise((r) => setTimeout(r, 250)); }
  check("and it reaches the team as a client's request", reqs.body.length === 1 && /title be bigger/.test(reqs.body[0].body), reqs.body);
  await dev.page.waitForFunction(() => !!document.querySelector("aside[aria-label=Menu] [data-member='Test client']"), null, { timeout: 15000 });
  check("the team sees the test client in People, marked as one", /Test client/.test(await dev.page.textContent("aside[aria-label=Menu]")));
  check("a developer cannot write as the test client", (await rpc(devToken, "client_say", { t: owner.tableId, body: "hi" })).status >= 400);

  // Only one, and adding again gives the same seat.
  const again = await rpc(token, "add_test_client", { t: owner.tableId });
  check("there is only ever one test client", again.body === reqs.body[0].member_id, again.body);

  // A real client is not the test client and still writes as themselves.
  await p.click("[data-testid=table-portal]");
  await p.waitForSelector("[data-testid=table-home]");
  const elena = await joinTable(browser, await inviteLink(p, "client"), `client-${run}@example.test`, "Elena Ruiz");
  await elena.page.fill("[aria-label='Ask the team']", "Hello from Elena");
  await elena.page.press("[aria-label='Ask the team']", "Enter");
  await elena.page.waitForFunction(() => document.querySelector("[data-testid=client-chat]")?.textContent.includes("Hello from Elena"));
  const both = await rest(devToken, `requests?select=body,member_id&table_id=eq.${owner.tableId}`);
  check("a real client's words stay their own", both.body.length === 2 && new Set(both.body.map((r) => r.member_id)).size === 2, both.body);
  check("the real client's page does not show the test client's request", !(await elena.page.textContent("[data-testid=client-chat]")).includes("title be bigger"));

  // Taking it off removes all it did.
  await p.click("[data-testid=client-portal]");
  await p.click("[data-testid=viewing] button:text-is('Test')");
  await p.waitForSelector("[data-testid=remove-test-client]");
  await p.click("[data-testid=remove-test-client]");
  await p.waitForFunction(() => !document.querySelector("[data-testid=remove-test-client]"));
  const left = await rest(devToken, `requests?select=body&table_id=eq.${owner.tableId}`);
  const people = await rest(devToken, `members?select=display_name,test&table_id=eq.${owner.tableId}`);
  check("removing the test client removes what it asked", left.body.length === 1 && /Elena/.test(left.body[0].body), left.body);
  check("and the seat itself", !people.body.some((m) => m.test), people.body);
} catch (e) {
  check("the run did not crash", false, e.stack || String(e));
} finally {
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
process.exit(Object.values(results.checks).some((v) => v !== "pass") ? 1 : 0);
