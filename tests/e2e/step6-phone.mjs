// Step 6 check, the phone layout: at 390 by 844, no page scrolls sideways; the room's menu opens the sidebar as a
// drawer, and picking a chat in it closes it; the client page and settings fit.
//
//   node tests/e2e/step6-phone.mjs

import { APP, inviteLink, join, launch, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = { checks: {} };
const check = (name, ok, detail) => { results.checks[name] = ok ? "pass" : `FAIL ${detail ?? ""}`.trim(); };
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const shots = process.env.SCREENSHOTS;

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Fernhill booking", "Maya");
  const tableId = owner.tableId;
  const client = await join(browser, await inviteLink(owner.page, "client"), `client-${run}@example.test`, "Dr. Ruiz");
  await owner.page.click("button[aria-label='New chat']");
  await owner.page.fill("input[aria-label='Name the new chat']", "Booking flow");
  await owner.page.press("input[aria-label='Name the new chat']", "Enter");
  await owner.page.waitForFunction(() => document.body.innerText.includes("Booking flow"));

  for (const p of [owner.page, client.page]) await p.setViewportSize({ width: 390, height: 844 });
  await owner.page.goto(`${APP}/t/${tableId}`);
  await owner.page.waitForFunction(() => !document.body.innerText.includes("Connecting"), null, { timeout: 10000 });
  const roomOver = await sideways(owner.page);
  const asideHidden = await owner.page.evaluate(() => getComputedStyle(document.querySelector("aside[aria-label=Menu]")).display === "none");
  check("the room fits a phone, sidebar tucked away", roomOver <= 0 && asideHidden, `over ${roomOver}, hidden ${asideHidden}`);

  await owner.page.click("button[aria-label=Menu]");
  const drawer = await owner.page.evaluate(() => {
    const a = document.querySelector("aside[aria-label=Menu]");
    const r = a.getBoundingClientRect();
    return { shown: getComputedStyle(a).display !== "none", width: r.width, text: a.innerText };
  });
  if (shots) await owner.page.screenshot({ path: `${shots}/phone-drawer.png` });
  check("the menu opens the sidebar", drawer.shown && drawer.width > 200 && drawer.width <= 390
    && ["booking flow", "connect my claude", "people", "settings"].every((w) => drawer.text.toLowerCase().includes(w)), JSON.stringify({ ...drawer, text: drawer.text.slice(0, 200) }));
  await owner.page.click("aside[aria-label=Menu] button:has-text('Booking flow')");
  await owner.page.waitForFunction(() => getComputedStyle(document.querySelector("aside[aria-label=Menu]")).display === "none", null, { timeout: 3000 })
    .then(() => true, () => false)
    .then(async (closed) => {
      const title = await owner.page.textContent("main >> div >> nth=0");
      check("picking a chat closes it and opens the chat", closed && title.includes("Booking flow"), `${closed} ${title}`);
    });
  if (shots) await owner.page.screenshot({ path: `${shots}/phone-room.png` });

  await client.page.goto(`${APP}/t/${tableId}`);
  await client.page.waitForSelector("text=What you asked for");
  const clientOver = await sideways(client.page);
  if (shots) await client.page.screenshot({ path: `${shots}/phone-client.png`, fullPage: true });
  check("the client page fits a phone", clientOver <= 0, String(clientOver));

  await owner.page.goto(`${APP}/t/${tableId}/settings`);
  const settingsOver = await sideways(owner.page);
  check("settings fit a phone", settingsOver <= 0, String(settingsOver));
  await owner.page.goto(`${APP}/t/${tableId}/activity`);
  const activityOver = await sideways(owner.page);
  check("the activity log fits a phone", activityOver <= 0, String(activityOver));
} finally {
  await browser.close();
}

const failed = Object.values(results.checks).filter((v) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
