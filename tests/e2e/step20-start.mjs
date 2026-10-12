// Coming back: someone signed in is shown their tables on the start page, and the opening page knows they are in.
//
//   node --experimental-websocket tests/e2e/step20-start.mjs

import { launch, startTable } from "./lib.mjs";

const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "")}`.slice(0, 500); };
const browser = await launch();
try {
  const owner = await startTable(browser, `back-${Date.now().toString(36)}@example.test`, "Booking app", "Maya");
  const p = owner.page;
  const at = (path) => new URL(path, p.url()).href;
  await p.goto(at("/start"));
  await p.waitForSelector("a[href^='/t/']", { timeout: 10000 }).catch(() => {});
  const text = await p.textContent("body");
  check("the start page lists the table they already have", /Your tables/.test(text) && /Booking app/.test(text) && (await p.locator(`a[href='/t/${owner.tableId}']`).count()) === 1, text.slice(0, 200));
  await p.goto(at("/"));
  check("the opening page shows the way to their tables, not Sign in", (await p.locator("[data-testid=my-tables]").count()) === 1 && (await p.locator("header a:has-text('Sign in')").count()) === 0);
  await p.click("[data-testid=my-tables]");
  await p.click(`a[href='/t/${owner.tableId}']`);
  await p.waitForSelector("[data-testid=table-home], [data-testid=work-panel]", { timeout: 15000 });
  check("and from there they are back at their table", p.url().includes(owner.tableId));
  const fresh = await browser.newContext();
  const q = await fresh.newPage();
  await q.goto(at("/"));
  check("someone not signed in still sees Sign in", (await q.locator("header a:has-text('Sign in')").count()) === 1 && (await q.locator("[data-testid=my-tables]").count()) === 0);
} catch (e) {
  check("the run did not crash", false, e.stack || String(e));
} finally {
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
process.exit(Object.values(results).some((v) => v !== "pass") ? 1 : 0);
