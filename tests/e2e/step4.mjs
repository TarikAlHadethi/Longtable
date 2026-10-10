// Step 4 check: several Claudes at one table. Each introduces itself; a deeper question gets a view from one and
// one combined answer from the final-answer Claude, with the files it read and "How they got here".
// Done when a deeper question returns one answer with sources and "How they got here".
//
// Both connections run here, each in its own settings folder, on this computer's saved Claude sign-in, on Haiku.
//
//   node tests/e2e/step4.mjs

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accessToken, inviteLink, join as joinTable, launch, rest, startTable } from "./lib.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const bin = join(repoRoot, "packages", "connect", "bin", "longtable.mjs");
const run = Date.now().toString(36);
const results = { checks: {} };
const check = (name, ok, detail) => { results.checks[name] = ok ? "pass" : `FAIL ${detail ?? ""}`.trim(); };
const savedSignIn = join(homedir(), ".longtable", "secrets", "claude-token.bin");
if (!existsSync(savedSignIn)) throw new Error("No saved Claude sign-in on this computer.");

function home() {
  const dir = mkdtempSync(join(tmpdir(), "longtable-home-"));
  mkdirSync(join(dir, "secrets"), { recursive: true });
  copyFileSync(savedSignIn, join(dir, "secrets", "claude-token.bin"));
  return dir;
}

// Press Connect my Claude on this page, then do what that person's Claude would do after they press Send.
async function connect(page, dir) {
  await page.click("button:has-text('Connect my AI')");
  const message = await page.locator("[data-testid=connect-message]").textContent();
  const [, code, app] = message.match(/connect ([0-9A-F]{20}) --app (\S+)/);
  const env = { ...process.env, LONGTABLE_HOME: dir, LONGTABLE_MODEL: "haiku" };
  const r = spawnSync(process.execPath, [bin, "connect", code, "--app", app, "--repo", repoRoot, "--no-autostart", "--no-run"], { env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  await page.locator("[role=dialog] button").last().click();
  return spawn(process.execPath, [bin, "run"], { env, stdio: "ignore", windowsHide: true });
}

const homes = [home(), home()];
const runners = [];
const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Booking app", "Maya");
  const dev = await joinTable(browser, await inviteLink(owner.page, "developer"), `dev-${run}@example.test`, "Sam");
  const client = await joinTable(browser, await inviteLink(owner.page, "client"), `client-${run}@example.test`, "Dr. Ruiz");
  runners.push(await connect(dev.page, homes[0]));
  runners.push(await connect(owner.page, homes[1]));

  // Each Claude introduces itself, and the first one pins a summary of the project.
  await owner.page.waitForFunction(() => document.querySelectorAll("[data-ai='intro']").length >= 2, null, { timeout: 180000 });
  check("both Claudes introduce themselves", true);
  await owner.page.waitForFunction(() => [...document.querySelectorAll("[data-testid=pinned]")].some((b) => b.textContent.includes("The project")), null, { timeout: 10000 });
  const pinned = await owner.page.locator("[data-testid=pinned]").allTextContents();
  results.pinned = pinned;
  check("the project summary and both intros are pinned", pinned.includes("The project") && pinned.some((p) => p.includes("Maya")) && pinned.some((p) => p.includes("Sam")), JSON.stringify(pinned));

  // A deeper question: Sam's Claude gives a view, Maya's Claude (the owner's) writes the one answer.
  const asked = Date.now();
  await owner.page.fill("textarea", "Where is the 10-second undo window enforced, and could a client get around it to hear a decision early?");
  await owner.page.click("button:has-text('Ask the table')");
  await owner.page.waitForFunction(() => [...document.querySelectorAll("[data-ai='true']")].some((el) => el.textContent.includes("The table")), null, { timeout: 240000 });
  results.answerSeconds = Math.round((Date.now() - asked) / 100) / 10;
  const answer = owner.page.locator("[data-ai='true']").filter({ hasText: "The table" }).last();
  results.answer = (await answer.textContent()).slice(0, 900);
  check("one combined answer, written by Maya's Claude", /one answer from 2 Claudes, written by Maya/.test(results.answer), results.answer);

  const sources = await answer.locator("[data-testid=sources] span").allTextContents();
  results.sources = sources;
  check("it lists the files it read, all real", sources.length > 0 && sources.every((s) => existsSync(join(repoRoot, s))), JSON.stringify(sources));

  await answer.locator("button:has-text('How they got here')").click();
  const how = await answer.locator("[data-testid=how]").textContent();
  results.how = how.slice(0, 900);
  check("How they got here shows Sam's view", /Sam's Claude/.test(how), how);

  const ownerToken = await accessToken(owner.context);
  const views = await rest(ownerToken, `messages?select=id,kind,meta&table_id=eq.${owner.tableId}&kind=eq.view`);

  // Found on the first run: the final Claude said no test covered the undo window while Sam's view cited
  // tests/e2e/step2.mjs, which does. A final answer must not deny what a view cited without reading it.
  const citedTest = views.body.some((v) => (v.meta?.sources ?? []).some((s) => s.startsWith("tests/")));
  const deniesTests = /no test|not covered by (a |any )?test|isn't tested|is not tested|no tests/i.test(results.answer);
  check("the final answer doesn't deny a test a view cited", !(citedTest && deniesTests), JSON.stringify({ citedTest, deniesTests }));
  const shownViews = await owner.page.evaluate((ids) => ids.filter((id) => {
    const el = document.querySelector(`[data-mid='${id}']`);
    return el && !el.closest("[data-testid=how]");
  }).length, views.body.map((v) => v.id));
  check("views stay in the back room, not in the chat", views.body.length === 1 && shownViews === 0, JSON.stringify({ views: views.body.length, shownViews }));

  const jobs = await rest(ownerToken, `jobs?select=kind,status,usage&table_id=eq.${owner.tableId}`);
  results.jobs = jobs.body.map((j) => `${j.kind}:${j.status}:${j.usage?.wall_ms ?? "-"}ms`);
  check("intro, view and combine jobs all finished", jobs.body.length === 4 && jobs.body.every((j) => j.status === "done"), JSON.stringify(results.jobs));

  // The wall: the client reads no notes and no views.
  const clientToken = await accessToken(client.context);
  const cn = await rest(clientToken, "notes?select=id");
  const cv = await rest(clientToken, "messages?select=id&kind=eq.view");
  check("the client reads no notes and no views", cn.body.length === 0 && cv.body.length === 0, JSON.stringify({ notes: cn.body, views: cv.body }));

  if (process.env.SCREENSHOTS) {
    await owner.page.setViewportSize({ width: 1440, height: 1000 });
    await answer.scrollIntoViewIfNeeded();
    await owner.page.screenshot({ path: `${process.env.SCREENSHOTS}/step4-answer.png` });
  }
} finally {
  for (const r of runners) r.kill();
  await browser.close();
  for (const h of homes) rmSync(h, { recursive: true, force: true });
}

const failed = Object.values(results.checks).filter((v) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
