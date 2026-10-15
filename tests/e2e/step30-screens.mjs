// The screen faults of group 3 (16 Oct 2026), each driven in a real browser against the local stack. Where a fault
// only shows when the network misbehaves, one request is slowed or failed on purpose.
//   Sending with things attached goes once on a double Enter, and words typed during the upload are kept.
//   Something pressed that did not go through says so and puts the screen back.
//   Settings that could not be read cannot be saved; Logs that could not be read say so.
//   A chat deleted while the owner is in Settings leaves them in Settings.
//   A short name keeps a title: "Take Dr. Ruiz off", never "Take Dr. off".
//   The demo's client side is drawn with the client page's own look, with no greeting.
//   GitHub deliveries without a signature are refused before the database is asked.
//
//   node --experimental-websocket tests/e2e/step30-screens.mjs

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as path } from "node:path";
import { accessToken, APP, inviteLink, join, launch, rest, rpc, sleep, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 400)}`; };
const stuff = mkdtempSync(path(tmpdir(), "longtable-screens-"));
const note = path(stuff, "plan.txt");
writeFileSync(note, "The plan for Thursday.");

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Screens", "Maya");
  const { tableId } = owner;
  const p = owner.page;
  await join(browser, await inviteLink(p, "client"), `client-${run}@example.test`, "Dr. Ruiz");
  const token = await accessToken(owner.context);
  const general = (await rest(token, `chats?select=id&table_id=eq.${tableId}&is_general=is.true`)).body[0].id;
  const messagesWithFiles = async () => (await rest(token, `messages?select=id,meta&chat_id=eq.${general}`)).body.filter((m) => m.meta?.files?.length).length;

  // ---- Sending with things attached: once, and nothing typed meanwhile is lost
  await p.goto(`${APP}/t/${tableId}?c=general`);
  await p.waitForSelector("[data-testid=attach-button]");
  await p.route("**/storage/v1/object/**", async (route) => { await sleep(1500); await route.continue(); });
  await p.setInputFiles("[data-testid=attach-input]", [note]);
  await p.fill("textarea", "the plan, attached");
  await p.press("textarea", "Enter");
  await p.press("textarea", "Enter");
  await sleep(200);
  await p.type("textarea", "and one more thing");
  await p.waitForSelector("[data-testid=files]", { timeout: 20000 });
  await sleep(1500);
  await p.unroute("**/storage/v1/object/**");
  check("a double Enter with something attached sends it once", (await messagesWithFiles()) === 1, await messagesWithFiles());
  check("words typed while the upload was going are still in the box", (await p.inputValue("textarea")) === "and one more thing", await p.inputValue("textarea"));
  await p.fill("textarea", "");

  // ---- Something pressed that did not go through says so, and the screen goes back
  await p.route("**/rest/v1/rpc/add_test_client", (route) => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ message: "no" }) }));
  await p.click("[data-testid=client-portal]");
  const viewing = await p.waitForSelector("[data-testid=viewing], [data-testid=add-test-client]", { timeout: 15000 });
  void viewing;
  await p.click("[data-testid=add-test-client]");
  const toast = await p.waitForSelector("[data-testid=did-not-take]", { timeout: 5000 }).then((el) => el.textContent()).catch(() => null);
  check("a press that did not go through says so instead of nothing", !!toast && toast.trim().length > 0, toast);
  check("and nothing changed on screen", (await p.locator("[data-testid=remove-test-client]").count()) === 0);
  await p.unroute("**/rest/v1/rpc/add_test_client");

  // ---- Settings that could not be read cannot be saved over the real ones
  await p.route("**/rest/v1/tables?select=undo_seconds*", (route) => route.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
  await p.goto(`${APP}/t/${tableId}/settings`);
  await p.waitForSelector("[data-testid=settings-panel]");
  await sleep(1500);
  const saveOff = await p.locator("form[aria-label='The table'] button:has-text('Save')").isDisabled();
  const said = await p.locator("[data-testid=settings-panel] [role=alert]").textContent().catch(() => "");
  check("settings that could not be read cannot be saved", saveOff, saveOff);
  check("and the page says it could not read them", /could not be read/.test(said || ""), said);
  check("no made-up undo window is shown as if it were the table's", (await p.inputValue("#s-undo")) === "", await p.inputValue("#s-undo"));
  await p.unroute("**/rest/v1/tables?select=undo_seconds*");
  await p.goto(`${APP}/t/${tableId}/settings`);
  await p.waitForSelector("form[aria-label='The table'] button:has-text('Save'):not([disabled])", { timeout: 15000 });
  check("read properly, the settings show the table's own undo window", (await p.inputValue("#s-undo")) === "10", await p.inputValue("#s-undo"));
  await p.locator("button:has-text('Take off the table')").last().click();
  check("a short name keeps its title in Settings", (await p.locator("button:has-text('Take Dr. Ruiz off')").count()) === 1, await p.locator("button:has-text('Take')").allTextContents());

  // ---- A chat deleted while the owner is in Settings leaves them there
  const doomed = (await rpc(token, "create_chat", { t: tableId, chat_name: `gone-${run}` })).body;
  await p.goto(`${APP}/t/${tableId}?c=${doomed}`);
  await p.waitForSelector("textarea");
  await p.click("[data-testid=me-menu]");
  await p.click("a:has-text('Table settings')");
  await p.waitForURL(/\/settings$/);
  await rpc(token, "delete_chat", { c: doomed });
  await sleep(3000);
  check("a chat deleted while the owner is in Settings leaves them in Settings", /\/settings$/.test(p.url()) && (await p.locator("[data-testid=settings-panel]").count()) === 1, p.url());

  // ---- Logs that could not be read say so, not "Nothing yet."
  await p.route("**/rest/v1/activity?*", (route) => route.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
  await p.goto(`${APP}/t/${tableId}/activity`);
  await p.waitForSelector("[data-testid=logs-panel]");
  await sleep(1500);
  const logs = await p.textContent("[data-testid=logs-panel]");
  check("a log that could not be read says so, not \"Nothing yet.\"", /could not be read/.test(logs) && !/Nothing yet/.test(logs), logs.slice(0, 200));
  await p.unroute("**/rest/v1/activity?*");

  // ---- The demo's client side has the client page's own look
  await p.goto(`${APP}/demo`);
  await p.waitForSelector("[aria-label=\"Elena's page\"]");
  const demo = await p.evaluate(() => {
    const pane = document.querySelector("[aria-label=\"Elena's page\"]");
    const bubble = pane.querySelector("[class*=bubble]");
    return { greeting: /Good morning/.test(pane.textContent), bubble: bubble ? getComputedStyle(bubble).backgroundColor : null };
  });
  check("the demo's client side is drawn with the real client page's look, with no greeting", !demo.greeting && !!demo.bubble && demo.bubble !== "rgba(0, 0, 0, 0)", demo);

  // ---- GitHub deliveries without a signature never reach the database
  const unsigned = await fetch(`${APP}/api/github/${tableId}`, { method: "POST", headers: { "x-github-event": "push", "content-type": "application/json" }, body: "{}" });
  const forged = await fetch(`${APP}/api/github/${tableId}`, { method: "POST", headers: { "x-github-event": "push", "x-hub-signature-256": "sha1=abc" }, body: "{}" });
  check("a GitHub delivery with no signature, or not GitHub's kind, is refused at the door", unsigned.status === 401 && forged.status === 401, [unsigned.status, forged.status]);
} catch (e) {
  results.error = String(e?.stack || e).slice(0, 900);
} finally {
  await browser.close();
  rmSync(stuff, { recursive: true, force: true });
}
const failed = Object.entries(results).filter(([, v]) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
