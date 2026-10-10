// Where the code is: the first person to connect says where the project's repository is, once. After that the
// setup message carries the address, so an AI can be opened in any folder. The client can never read it.
//
//   node tests/e2e/step9-repo.mjs

import { accessToken, inviteLink, join as joinTable, launch, rest, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = { checks: {} };
const check = (name, ok, detail) => { results.checks[name] = ok ? "pass" : `FAIL ${detail ?? ""}`.trim(); };
const REPO = "https://github.com/example/booking-app";

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Booking app", "Maya");
  const dev = await joinTable(browser, await inviteLink(owner.page, "developer"), `dev-${run}@example.test`, "Sam");
  const client = await joinTable(browser, await inviteLink(owner.page, "client"), `client-${run}@example.test`, "Dr. Ruiz");

  await owner.page.click("button:has-text('Connect my AI')");
  await owner.page.click("[data-testid=pick-claude]");
  await owner.page.fill("#repo", "not an address");
  await owner.page.click("div[role=dialog] button:has-text('Save')");
  await owner.page.waitForSelector("div[role=dialog] .error");
  check("a wrong address is refused", /repository address/.test(await owner.page.textContent("div[role=dialog] .error")));
  await owner.page.fill("#repo", REPO);
  await owner.page.click("div[role=dialog] button:has-text('Save')");

  const mine = await owner.page.locator("[data-testid=connect-message]").textContent();
  check("the setup message carries the address and no longer asks for a folder", mine.includes(` --repo ${REPO} `) && !/in this folder/.test(mine) && /stays on this computer/.test(mine), mine);

  await dev.page.click("button:has-text('Connect my AI')");
  await dev.page.click("[data-testid=pick-codex]");
  const sams = await dev.page.locator("[data-testid=connect-message]").textContent();
  check("the next person is not asked again", sams.includes(` --repo ${REPO} `) && sams.includes("--ai codex"), sams);

  const seen = await rest(await accessToken(client.context), `table_code?table_id=eq.${owner.tableId}&select=repo_url`);
  check("the client cannot read where the code is", Array.isArray(seen.body) && seen.body.length === 0, JSON.stringify(seen.body));
  const set = await rest(await accessToken(client.context), "rpc/set_table_repo", { method: "POST", body: JSON.stringify({ t: owner.tableId, url: "https://github.com/evil/x" }) });
  check("the client cannot change it", set.status >= 400, JSON.stringify(set.body));
} finally {
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
if (Object.values(results.checks).some((v) => v !== "pass")) process.exit(1);
