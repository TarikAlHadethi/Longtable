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
  await p.waitForSelector("[data-testid=person-panel]");
  const sam = await p.textContent("[data-testid=person-panel]");
  check("clicking a person opens them in the middle, with when they joined", /Sam/.test(sam) && /Developer/.test(sam) && /Joined\s*\d{1,2} \w+ 20\d\d/.test(sam), sam.slice(0, 200));
  check("the sidebar is still there", await p.isVisible("aside[aria-label=Menu]"));

  await p.click("a:has-text('Logs')");
  await p.waitForSelector("[data-testid=logs-panel] li");
  check("Logs opens inside the room, at its own address", p.url().endsWith("/activity") && /started the table/.test(await p.textContent("[data-testid=logs-panel]")) && await p.isVisible("aside[aria-label=Menu]"), p.url());

  await p.click("a:has-text('Settings')");
  await p.waitForSelector("form[aria-label='The table']");
  check("Settings opens inside the room, at its own address", p.url().endsWith("/settings") && await p.isVisible("aside[aria-label=Menu]"), p.url());
  check("none of that reloaded the page", await p.evaluate(() => window.__same === true));

  await p.goBack();
  await p.waitForSelector("[data-testid=logs-panel]");
  check("the browser's Back moves between them", p.url().endsWith("/activity"));

  // The bug button.
  // In development Next.js draws its own badge over this corner, so the click is sent to the button itself.
  await p.dispatchEvent("[data-testid=bug]", "click");
  await p.fill("#bug-text", "The crown is crooked on purpose, but this is a test report.");
  await p.click("form[aria-label='Report a bug'] button:has-text('Send')");
  await p.waitForFunction(() => document.body.innerText.includes("Sent. Thank you."));
  const peek = await rest(await accessToken(owner.context), "bug_reports?select=body");
  const asOperator = await rpc(await accessToken(owner.context), "operator_bugs", {});
  check("a bug report is sent, and nobody at the table can read the reports", (peek.status >= 400 || (Array.isArray(peek.body) && peek.body.length === 0)) && asOperator.status >= 400, JSON.stringify(peek.body).slice(0, 120));

  // Handing the table over.
  await p.click("aside[aria-label=Menu] [data-member='Sam']");
  await p.click("[data-testid=person-panel] button:has-text('Make owner')");
  await p.click("[data-testid=person-panel] button:has-text('Make Sam the owner')");
  await dev.page.waitForSelector("aside[aria-label=Menu] a:has-text('Settings')", { timeout: 10000 })
    .then(() => check("the owner hands the table to a developer, who gets Settings at once", true), () => check("the owner hands the table to a developer, who gets Settings at once", false));
  await p.waitForFunction(() => !document.querySelector("aside[aria-label=Menu] a[href$='/settings']"), null, { timeout: 10000 })
    .then(() => check("and the old owner no longer has it", true), () => check("and the old owner no longer has it", false));
  const again = await rpc(await accessToken(owner.context), "transfer_ownership", { m: owner.tableId });
  check("someone who is not the owner cannot hand it over", again.status >= 400);
  const owners = (await rest(await accessToken(dev.context), `members?select=role&table_id=eq.${owner.tableId}&role=eq.owner`)).body;
  check("there is exactly one owner", owners.length === 1, JSON.stringify(owners));
} finally {
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
if (Object.values(results.checks).some((v) => v !== "pass")) process.exit(1);
