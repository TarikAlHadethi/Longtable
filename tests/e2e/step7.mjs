// Step 7 check: a new team gets from Start to its first answer with no help. Someone lands on the opening screen,
// follows only what each screen says, connects their Claude (what their own Claude would run after they press Send),
// and asks the table; the answer comes back. Then their data: download everything, and delete the table for good.
//
//   node tests/e2e/step7.mjs

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP, accessToken, launch, rest, rpc, signIn } from "./lib.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const bin = join(repoRoot, "packages", "connect", "bin", "longtable.mjs");
const run = Date.now().toString(36);
const results = { checks: {} };
const check = (name, ok, detail) => { results.checks[name] = ok ? "pass" : `FAIL ${detail ?? ""}`.trim(); };

const testHome = mkdtempSync(join(tmpdir(), "longtable-home-"));
const saved = join(homedir(), ".longtable", "secrets", "claude-token.bin");
if (!existsSync(saved)) throw new Error("No saved Claude sign-in on this computer.");
mkdirSync(join(testHome, "secrets"), { recursive: true });
copyFileSync(saved, join(testHome, "secrets", "claude-token.bin"));
const env = { ...process.env, LONGTABLE_HOME: testHome, LONGTABLE_MODEL: "haiku" };

const browser = await launch();
let runner;
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const started = Date.now();

  // The opening screen: one sentence, Start, Start demo.
  await page.goto(APP);
  check("the opening screen says what it is and offers Start and the demo",
    (await page.textContent("body")).includes("at one table") && await page.isVisible("a:has-text('Start demo')"));
  await page.click("a:has-text('Start')");
  await signIn(page, `new-${run}@example.test`);
  await page.waitForURL(/\/start$/);
  await page.fill("#table", "Our app");
  await page.fill("#me", "Nadia");
  await page.click("text=Start the table");
  await page.waitForURL(/\/t\/[0-9a-f-]{36}$/);
  const tableId = page.url().split("/t/")[1];
  const empty = await page.textContent("body");
  check("the table's home says what to do next", /Connect your AI/.test(empty) && /No AI connected yet/.test(empty), empty.slice(0, 300));

  // Connect my Claude, as the screen says; the message is what their own Claude runs after they press Send.
  await page.click("[data-testid=table-home] button:has-text('Connect your AI')");
  await page.click("[data-testid=pick-claude]");
  await page.click("text=It is only on my computer");
  const message = await page.locator("[data-testid=connect-message]").textContent();
  check("the Connect window explains itself", /press Send/.test(await page.textContent("div[role=dialog]")), message);
  const m = message.match(/connect ([0-9A-F]{20}) --app (\S+)/);
  const connected = spawnSync(process.execPath, [bin, "connect", m[1], "--app", m[2], "--repo", repoRoot, "--no-autostart", "--no-run"], { env, encoding: "utf8" });
  check("their Claude connects", connected.status === 0 && /Connected\./.test(connected.stdout), connected.stderr || connected.stdout);
  runner = spawn(process.execPath, [bin, "run"], { env, stdio: "ignore", windowsHide: true });
  await page.waitForSelector("[data-testid=me-menu][data-connected]", { timeout: 15000 });
  await page.click("div[role=dialog] button >> text=/Done|Close/");
  await page.waitForSelector("[data-testid=table-home] [data-seat-ai=claude]", { timeout: 15000 }).then(() => check("their Claude takes its place in the tree", true))
    .catch(() => check("their Claude takes its place in the tree", false));
  await page.click("[data-testid=table-home] button:has-text('Open General')");

  // Its first message introduces the project, then the first question.
  await page.waitForSelector("[data-ai='intro']", { timeout: 120000 }).then(() => check("their Claude introduces the project first", true))
    .catch(() => check("their Claude introduces the project first", false));
  await page.fill("textarea", "What does this project do, in one sentence?");
  await page.press("textarea", "Control+Enter");
  await page.waitForSelector("[data-ai='true']", { timeout: 120000 });
  results.secondsToFirstAnswer = Math.round((Date.now() - started) / 1000);
  const answer = await page.locator("[data-ai='true']").last().textContent();
  results.answer = answer.slice(0, 300);
  check("the first answer comes back", answer.length > 40, answer);

  // Their data: everything in one file, then the table deleted for good.
  const token = await accessToken(ctx);
  const exported = (await rpc(token, "export_table", { t: tableId })).body;
  check("Download everything holds the table, its people and its messages, and no secrets",
    exported?.table?.name === "Our app" && exported.people.length === 1 && exported.messages.length >= 2
      && !JSON.stringify(exported).includes("token_hash"), JSON.stringify(Object.keys(exported || {})));
  await page.goto(`${APP}/t/${tableId}/settings`);
  await page.click("button:has-text('Delete this table')");
  await page.fill("input[aria-label=\"Type the table's name\"]", "Our ap");
  const blocked = await page.isDisabled("button:has-text('Delete it for good')");
  await page.fill("input[aria-label=\"Type the table's name\"]", "Our app");
  await page.click("button:has-text('Delete it for good')");
  await page.waitForURL(/\?deleted=1$/);
  const after = await rest(token, `tables?select=id&id=eq.${tableId}`);
  const messagesAfter = await rest(token, `messages?select=id&table_id=eq.${tableId}`);
  check("Delete needs the exact name, then removes everything", blocked && after.body.length === 0 && messagesAfter.body.length === 0,
    JSON.stringify({ blocked, tables: after.body.length, messages: messagesAfter.body.length }));
} finally {
  if (runner) runner.kill();
  await browser.close();
  try { rmSync(testHome, { recursive: true, force: true }); } catch {}
}

const failed = Object.values(results.checks).filter((v) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
