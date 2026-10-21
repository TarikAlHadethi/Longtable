// A person's full Claude Code at the table, on the real model. By default it is on and works in their own folder, as
// Claude Code does at home: it runs a command it needs, the permission prompt reaches them in Longtable, they allow it
// (always), it runs and the output is in the answer, and the change is in their folder with nothing committed or
// pushed. A command they deny does not run. With "Work in my folder" off, the change lands on the task's branch in a
// worktree and their folder is untouched.
//
// The connection runs here on this computer's saved Claude sign-in, on Haiku; the project is a scratch repository.
//
//   node --experimental-websocket tests/e2e/step42-full-claude.mjs

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accessToken, launch, rest, rpc, startTable } from "./lib.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const bin = join(repoRoot, "packages", "connect", "bin", "longtable.mjs");
const run = Date.now().toString(36);
const results = { checks: {} };
const check = (name, ok, detail) => { results.checks[name] = ok ? "pass" : `FAIL ${typeof detail === "string" ? detail : JSON.stringify(detail ?? "")}`.trim().slice(0, 600); };
const savedSignIn = join(homedir(), ".longtable", "secrets", "claude-token.bin");
if (!existsSync(savedSignIn)) throw new Error("No saved Claude sign-in on this computer.");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The project: a bare repository standing in for GitHub, and the person's own folder cloned from it.
const scratch = mkdtempSync(join(tmpdir(), "longtable-full-"));
const remote = join(scratch, "remote.git");
const project = join(scratch, "project");
const MARK = `CHECK-OK-${run}`;
git(scratch, "init", "-q", "--bare", "-b", "main", remote);
git(scratch, "clone", "-q", remote, project);
writeFileSync(join(project, "greet.js"), 'export const greeting = "hello";\n');
writeFileSync(join(project, "check.js"), `import * as g from "./greet.js";\nconsole.log("${MARK}", Object.keys(g).sort().join(","));\n`);
writeFileSync(join(project, "package.json"), JSON.stringify({ name: "greeter", type: "module" }, null, 2));
git(project, "add", "-A");
git(project, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-q", "-m", "start");
git(project, "push", "-q", "origin", "HEAD:main");
git(project, "config", "user.name", "Maya");
git(project, "config", "user.email", "maya@example.test");

const home = mkdtempSync(join(tmpdir(), "longtable-home-"));
mkdirSync(join(home, "secrets"), { recursive: true });
copyFileSync(savedSignIn, join(home, "secrets", "claude-token.bin"));

let runner = null;
const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Greeter", "Maya");
  const page = owner.page;
  // Connect from the project's own folder, as a person's Claude would.
  await page.click("[data-testid=me-menu]");
  await page.click("button:has-text('Connect my AI')");
  await page.click("[data-testid=pick-claude]");
  await page.click("text=It is only on my computer");
  const message = await page.locator("[data-testid=connect-message]").textContent();
  const [, code, app] = message.match(/connect ([0-9A-F]{20}) --app (\S+)/);
  const env = { ...process.env, LONGTABLE_HOME: home, LONGTABLE_MODEL: "haiku", LONGTABLE_FULL: "on" };
  const r = spawnSync(process.execPath, [bin, "connect", code, "--app", app, "--repo", project, "--no-autostart", "--no-run"], { env, cwd: project, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  await page.locator("[role=dialog] button").last().click();
  runner = spawn(process.execPath, [bin, "run"], { env, cwd: project, stdio: "ignore", windowsHide: true });
  await page.waitForFunction(() => document.querySelectorAll("[data-ai='intro']").length >= 1, null, { timeout: 180000 });

  // She turns on full Claude Code in her AI's window.
  const token = await accessToken(owner.context);
  const conn = (await rest(token, `connections?select=id,full_claude,in_folder&table_id=eq.${owner.tableId}&revoked_at=is.null`)).body[0];
  check("full Claude Code starts on, working in her own folder", conn && conn.full_claude === true && conn.in_folder === true, conn);

  // She asks for something that needs a command run.
  await page.fill("textarea", "Add a farewell export to greet.js that says bye. Then run `node check.js` and tell me exactly what it printed.");
  await page.keyboard.press("Control+Enter");
  const card = page.locator("[data-testid=approvals] [data-approval]").first();
  await card.waitFor({ timeout: 300000 });
  const what = await card.textContent();
  results.asked = what;
  check("her Claude's request reaches her in Longtable", /wants to run/.test(what), what);
  check("the tab says something is waiting", /^\(\d+\) /.test(await page.title()), await page.title());
  // Always is offered only for one plain command; a chained one is allowed once.
  const plain = /^[^*()\r\n;&|`$<>]{1,500}$/.test(what.replace(/^Your Claude wants to run/, "").replace(/Allow once.*$/, "").trim());
  check("always allow is offered only for one plain command", (await card.locator("[data-testid=always]").count() > 0) === plain, what);
  await card.locator(plain ? "[data-testid=always]" : "[data-testid=allow]").click();

  // Further prompts (if any) are answered the same way while the work goes on.
  const answered = Date.now();
  let extra = 0;
  for (;;) {
    const done = await page.evaluate(() => [...document.querySelectorAll("[data-ai='true']")].some((el) => /check|farewell|bye/i.test(el.textContent || "") && !el.closest("[data-ai='intro']")));
    if (done) break;
    const more = page.locator("[data-testid=approvals] [data-approval] [data-testid=allow]").first();
    if (await more.count()) { await more.click(); extra++; }
    if (Date.now() - answered > 420000) throw new Error("no answer in 7 minutes");
    await sleep(2000);
  }
  results.extraPrompts = extra;
  const answer = (await page.locator("[data-ai='true']").last().textContent()) || "";
  results.answer = answer.slice(-700);
  check("the command ran and its output is in the answer", answer.includes(MARK) || /farewell,greeting|greeting,farewell/.test(answer), results.answer);

  const branchesNow = () => git(scratch, "--git-dir", remote, "branch", "--list").split(/\r?\n/).map((b) => b.replace(/^[* ]+/, "")).filter(Boolean);
  check("the change is in her own folder, as at home", /farewell/.test(readFileSync(join(project, "greet.js"), "utf8")) && /greet\.js/.test(git(project, "status", "--porcelain")), git(project, "status", "--porcelain"));
  check("nothing was committed or pushed for her", !/farewell/.test(git(project, "show", "HEAD:greet.js")) && !branchesNow().some((b) => b.startsWith("longtable/")), branchesNow());
  check("no worktree was made", !git(project, "worktree", "list").includes("trees"), git(project, "worktree", "list"));

  // A command she denies does not run.
  const before = await page.locator("[data-ai='true']").count();
  await page.fill("textarea", "Run `node -e \"console.log('DENY-CHECK-' + (40 + 2))\"` and tell me exactly what it printed.");
  await page.keyboard.press("Control+Enter");
  const second = page.locator("[data-testid=approvals] [data-approval]").first();
  await second.waitFor({ timeout: 300000 });
  results.askedSecond = await second.textContent();
  await second.locator("[data-testid=deny]").click();
  // Whatever it asks next is denied too, until its answer arrives.
  for (let i = 0; i < 300; i++) {
    if ((await page.locator("[data-ai='true']").count()) > before) break;
    const again = page.locator("[data-testid=approvals] [data-approval] [data-testid=deny]").first();
    if (await again.count()) { results.deniedAgain = (results.deniedAgain || 0) + 1; await again.click().catch(() => {}); }
    await page.waitForTimeout(1000);
  }
  const said = (await page.locator("[data-ai='true']").last().textContent()) || "";
  results.denied = said.slice(-400);
  const lastAsk = (await rest(token, `approvals?select=status,summary&table_id=eq.${owner.tableId}&order=created_at.desc&limit=1`)).body?.[0];
  check("a command she denies does not run, and her Claude says so", lastAsk?.status === "denied" && /DENY-CHECK/.test(lastAsk?.summary || "")
    && /said no|didn.t run|did not run|couldn.t run|not run|declined/i.test(said), { lastAsk, said: said.slice(-300) });
  const leftover = (await rest(token, `approvals?select=status&table_id=eq.${owner.tableId}&status=eq.waiting`)).body;
  check("nothing is left waiting", Array.isArray(leftover) && leftover.length === 0, leftover);

  // She turns "Work in my folder" off: her next request goes to the task's branch in a worktree, her folder stays as it is.
  const off = await rpc(token, "set_work_in_folder", { conn: conn.id, on_: false });
  check("she turns working in her folder off", off.status < 300, off);
  const folderBefore = readFileSync(join(project, "greet.js"), "utf8");
  const third = await page.locator("[data-ai='true']").count();
  await page.fill("textarea", "Add an export named ciao to greet.js whose value is the string ciao. Change nothing else and run nothing.");
  await page.keyboard.press("Control+Enter");
  for (let i = 0; i < 420; i++) {
    if ((await page.locator("[data-ai='true']").count()) > third) break;
    const any = page.locator("[data-testid=approvals] [data-approval] [data-testid=allow]").first();
    if (await any.count()) await any.click().catch(() => {});
    await page.waitForTimeout(1000);
  }
  const made = branchesNow().find((b) => b.startsWith("longtable/"));
  check("the change is on the task's own branch in the repository", !!made, branchesNow());
  if (made) check("with what was asked", /ciao/.test(git(scratch, "--git-dir", remote, "show", `${made}:greet.js`)));
  check("the default branch is untouched", !/ciao|farewell/.test(git(scratch, "--git-dir", remote, "show", "main:greet.js")));
  check("her own folder is untouched by it", readFileSync(join(project, "greet.js"), "utf8") === folderBefore);
} catch (e) {
  check("the run did not crash", false, e.stack || e.message);
} finally {
  try { runner?.kill(); } catch {}
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
const failed = Object.values(results.checks).filter((v) => v !== "pass").length;
console.log(`${Object.keys(results.checks).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
