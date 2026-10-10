// The room's own pages: a person opens in the middle with their facts; the owner can hand the table over; Logs and
// Settings open inside the room with the sidebar still there, at their own addresses, with no trip to the server;
// the bug button sends a report only an operator can read.
//
//   node tests/e2e/step11-room-pages.mjs

import { accessToken, inviteLink, join as joinTable, launch, rest, rpc, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = { checks: {} };
const check = (name, ok, detail) => { results.checks[name] = ok ? "pass" : `FAIL ${detail ?? ""}`.trim(); };

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Booking app", "Maya");
  const dev = await joinTable(browser, await inviteLink(owner.page, "developer"), `dev-${run}@example.test`, "Sam");
  const p = owner.page;

  // No full page load from here on: a marker on the window survives only if the page is never reloaded.
  await p.evaluate(() => { window.__same = true; });

  await p.click("aside[aria-label=Menu] [data-member='Sam']");
  await p.waitForSelector("[data-testid=person-window]");
  const sam = await p.textContent("[data-testid=person-window]");
  check("clicking a person opens their window, with when they joined", /Sam/.test(sam) && /Developer/.test(sam) && /Joined\s*\d{1,2} \w+ 20\d\d/.test(sam), sam.slice(0, 200));
  await p.click("[data-testid=person-window] button:has-text('Close')");

  await p.click("[data-testid=me-menu]");
  await p.click("a:has-text('Table settings')");
  await p.waitForSelector("form[aria-label='The table']");
  check("Settings opens inside the room, from the picture menu, at its own address", p.url().endsWith("/settings") && await p.isVisible("aside[aria-label=Menu]"), p.url());
  check("and it has no Inbox beside it", (await p.locator("aside[aria-label=Inbox]").count()) === 0);

  await p.click("[role=tab]:has-text('Logs')");
  await p.waitForSelector("[data-testid=logs-panel] li");
  check("Logs is a tab of Settings, at its own address", p.url().endsWith("/activity") && /started the table/.test(await p.textContent("[data-testid=logs-panel]")), p.url());
  check("none of that reloaded the page", await p.evaluate(() => window.__same === true));

  await p.goBack();
  await p.waitForSelector("form[aria-label='The table']");
  check("the browser's Back moves between them", p.url().endsWith("/settings"));

  // Your own window: a name, a status, a colour for your name.
  await p.click("[data-testid=me-menu]");
  await p.click("[data-testid=me-edit]");
  await p.fill("#pf-name", "Maya R");
  await p.fill("#pf-status", "On the booking flow");
  await p.click("[role=radiogroup][aria-label='Name colour'] button >> nth=3");
  await p.click("[data-testid=person-window] button:has-text('Save')");
  await dev.page.waitForFunction(() => document.querySelector("aside[aria-label=Menu] [data-member='Maya R']")?.textContent.includes("On the booking flow"), null, { timeout: 10000 })
    .then(() => check("you change your own name and status, and everyone sees it", true), () => check("you change your own name and status, and everyone sees it", false));
  const others = await rpc(await accessToken(dev.context), "update_profile", { t: owner.tableId, new_name: "Sam", new_color: "red; drop", new_name_color: "", new_avatar: "", new_status: "" });
  check("a colour that is not a colour is refused", others.status >= 400, JSON.stringify(others.body));

  // The bug button.
  // In development Next.js draws its own badge over this corner, so the click is sent to the button itself.
  await p.dispatchEvent("[data-testid=bug]", "click");
  await p.fill("#bug-text", "The crown is crooked on purpose, but this is a test report.");
  await p.click("form[aria-label='Report a bug'] button:has-text('Send')");
  await p.waitForFunction(() => document.body.innerText.includes("Sent. Thank you."));
  const peek = await rest(await accessToken(owner.context), "bug_reports?select=body");
  const asOperator = await rpc(await accessToken(owner.context), "operator_bugs", {});
  check("a bug report is sent, and nobody at the table can read the reports", (peek.status >= 400 || (Array.isArray(peek.body) && peek.body.length === 0)) && asOperator.status >= 400, JSON.stringify(peek.body).slice(0, 120));

  // The client's side, through the glass.
  await p.click("[data-testid=home]");
  // The glass drifts gently, so the pointer is sent without waiting for it to hold still.
  await p.hover("[data-testid=client-portal]", { force: true });
  await p.waitForTimeout(700);
  if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/peek.png` });
  await p.click("[data-testid=client-portal]", { force: true });
  await p.waitForSelector("[data-testid=client-side]");
  if (process.env.SHOTS) { await p.waitForTimeout(700); await p.screenshot({ path: `${process.env.SHOTS}/client-side.png` }); }
  check("the glass in the corner opens the client's side in the middle of the room", /The client.s side/.test(await p.textContent("[data-testid=client-side]")) && await p.isVisible("aside[aria-label=Menu]"));
  await p.click("[data-testid=table-portal]");
  await p.waitForSelector("[data-testid=table-home]");
  check("and the same corner leads back to the table", true);

  // Handing the table over.
  await p.click("aside[aria-label=Menu] [data-member='Sam']");
  await p.click("[data-testid=person-window] button:has-text('Make owner')");
  await p.click("[data-testid=person-window] button:has-text('Make Sam the owner')");
  await dev.page.waitForFunction(() => !!document.querySelector("aside[aria-label=Menu] [data-member='Sam'] svg"), null, { timeout: 10000 }).catch(() => {});
  await dev.page.click("[data-testid=me-menu]");
  check("the owner hands the table to a developer, who gets Table settings at once", (await dev.page.locator("a:has-text('Table settings')").count()) === 1);
  await p.click("[data-testid=me-menu]");
  check("and the old owner no longer has it", (await p.locator("a:has-text('Table settings')").count()) === 0);
  const again = await rpc(await accessToken(owner.context), "transfer_ownership", { m: owner.tableId });
  check("someone who is not the owner cannot hand it over", again.status >= 400);
  const owners = (await rest(await accessToken(dev.context), `members?select=role&table_id=eq.${owner.tableId}&role=eq.owner`)).body;
  check("there is exactly one owner", owners.length === 1, JSON.stringify(owners));
} finally {
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
if (Object.values(results.checks).some((v) => v !== "pass")) process.exit(1);
