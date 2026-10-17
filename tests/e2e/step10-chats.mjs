// Chats in the sidebar: a new chat left unnamed is gone when the pointer goes elsewhere; a chat is renamed by
// double-clicking it while it is open, or from its menu; its maker or the owner can delete it, and it goes for
// everyone. General can never be deleted, and a developer cannot delete someone else's chat.
//
//   node tests/e2e/step10-chats.mjs

import { accessToken, inviteLink, join as joinTable, launch, rpc, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = { checks: {} };
const check = (name, ok, detail) => { results.checks[name] = ok ? "pass" : `FAIL ${detail ?? ""}`.trim(); };
const shots = process.env.SHOTS;
const names = (page) => page.evaluate(() => [...document.querySelectorAll("aside[aria-label=Menu] [data-chat]")].map((el) => el.getAttribute("data-chat")));

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Booking app", "Maya");
  const dev = await joinTable(browser, await inviteLink(owner.page, "developer"), `dev-${run}@example.test`, "Sam");
  const p = owner.page;

  await p.click("button[aria-label='New chat']");
  await p.fill("input[aria-label='Name the new chat']", "Half typed");
  await p.click("textarea");
  await p.waitForTimeout(300);
  check("a new chat left unnamed is gone when you click elsewhere", (await p.locator("input[aria-label='Name the new chat']").count()) === 0 && !(await names(p)).includes("Half typed"), JSON.stringify(await names(p)));

  await p.click("button[aria-label='New chat']");
  await p.fill("input[aria-label='Name the new chat']", "Launch");
  await p.press("input[aria-label='Name the new chat']", "Enter");
  await p.waitForSelector("[data-chat='Launch']");
  await dev.page.waitForSelector("[data-chat='Launch']", { timeout: 8000 });
  check("a named chat is made and everyone sees it", true);

  await p.dblclick("[data-chat='Launch'] button >> nth=0");
  await p.fill("input[aria-label=\"The chat's name\"]", "Launch plan");
  await p.press("input[aria-label=\"The chat's name\"]", "Enter");
  await dev.page.waitForSelector("[data-chat='Launch plan']", { timeout: 8000 }).then(() => check("double-clicking the open chat renames it, for everyone", true), () => check("double-clicking the open chat renames it, for everyone", false));

  await p.hover("[data-chat='Launch plan']");
  await p.click("[data-chat='Launch plan'] button[aria-haspopup=menu]");
  if (shots) await p.screenshot({ path: `${shots}/chat-menu.png`, clip: { x: 0, y: 60, width: 420, height: 320 } });
  await p.click("[role=menu] >> text=Rename");
  await p.fill("input[aria-label=\"The chat's name\"]", "Launch day");
  await p.press("input[aria-label=\"The chat's name\"]", "Enter");
  await p.waitForSelector("[data-chat='Launch day']");
  check("the menu renames it too", true);

  const devToken = await accessToken(dev.context);
  const chatId = (await p.evaluate(() => new URL(location.href).searchParams.get("c")));
  const refused = await rpc(devToken, "delete_chat", { c: chatId });
  check("a developer cannot delete someone else's chat", refused.status >= 400, JSON.stringify(refused.body));

  await p.hover("[data-chat='General']");
  await p.click("[data-chat='General'] button[aria-haspopup=menu]");
  check("General offers no delete", (await p.locator("[role=menu] >> text=Delete").count()) === 0);
  await p.keyboard.press("Escape");

  await p.hover("[data-chat='Launch day']");
  await p.click("[data-chat='Launch day'] button[aria-haspopup=menu]");
  await p.click("[role=menu] >> text=Delete");
  const sure = await p.textContent("[data-testid=delete-chat-sure]");
  check("deleting asks a short question naming the chat", /Delete # Launch day\?/.test(sure) && !/everything in it/.test(sure), sure);
  await p.click("[data-testid=delete-chat-sure] button:has-text('Delete')");
  await p.waitForFunction(() => !document.querySelector("[data-chat='Launch day']"));
  await dev.page.waitForFunction(() => !document.querySelector("[data-chat='Launch day']"), null, { timeout: 8000 })
    .then(() => check("deleting asks once more, then it is gone for everyone", true), () => check("deleting asks once more, then it is gone for everyone", false));
  check("and the owner lands back on the table", !!(await p.$("[data-testid=table-home]")));
} finally {
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
if (Object.values(results.checks).some((v) => v !== "pass")) process.exit(1);
