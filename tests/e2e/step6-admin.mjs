// Step 6 check, the operator's page: someone not listed as an operator gets a 404 and a refusal from the database;
// an operator sees counts that match the activity, and no names, messages or table titles.
// Adds the test operator with SQL through Docker, the way a deployer would, and removes them after.
//
//   node tests/e2e/step6-admin.mjs

import { execFileSync } from "node:child_process";
import { APP, accessToken, launch, rest, rpc, signIn, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = { checks: {} };
const check = (name, ok, detail) => { results.checks[name] = ok ? "pass" : `FAIL ${detail ?? ""}`.trim(); };
const opEmail = `operator-${run}@example.test`;
const sql = (q) => execFileSync("docker", ["exec", "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" });

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Secret Project Name", "Maya");
  await owner.page.fill("textarea", "a very private message");
  await owner.page.press("textarea", "Enter");

  // Not an operator: a 404, and the database refuses.
  const ownerToken = await accessToken(owner.context);
  const refused = await rpc(ownerToken, "operator_counts", {});
  const res = await owner.page.goto(`${APP}/admin`);
  check("a non-operator gets nothing", refused.status >= 400 && res.status() === 404, `${refused.status} ${res.status()}`);

  // An operator, added with SQL.
  sql(`insert into public.operators (email) values ('${opEmail}')`);
  const ctx = await browser.newContext();
  const op = await ctx.newPage();
  await op.goto(`${APP}/sign-in?next=/admin`);
  await signIn(op, opEmail);
  await op.waitForURL(/\/admin$/);
  await op.waitForSelector("[data-count=tables]");
  const text = await op.evaluate(() => document.body.innerText);
  const counts = (await rpc(await accessToken(ctx), "operator_counts", {})).body;
  results.counts = counts;
  check("an operator sees the counts", counts.tables >= 1 && counts.messages_24h >= 1 && /How it is going/.test(text), JSON.stringify(counts));
  check("no names, messages or titles on it", !["Secret Project Name", "a very private message", "Maya"].some((w) => text.includes(w)), text.slice(0, 300));
  const readList = await rest(await accessToken(ctx), "operators?select=email");
  check("the operator list itself stays unreadable, even to an operator", readList.status >= 400, String(readList.status));
} finally {
  try { sql(`delete from public.operators where email = '${opEmail}'`); } catch {}
  await browser.close();
}

const failed = Object.values(results.checks).filter((v) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
