// Handing work over: two Claudes, one task, a part each, landing on one branch at the same time.
// (Setup as in step 12.)
// Work at a table with two Claudes: the asker's Claude does the work, the other one says what it thinks before and
// looks it over after, and the table answers once. The change lands on the chat's branch, never the default one.
// Done when a request for a change puts a commit on longtable/general in the project's repository, a review job ran,
// and the round stopped by itself.
//
// Both connections run here, each in its own settings folder, on this computer's saved Claude sign-in, on Haiku.
// The project is a scratch repository made for this run.
//
//   node tests/e2e/step12-work.mjs

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// The project: a bare repository standing in for GitHub, and a folder cloned from it.
const scratch = mkdtempSync(join(tmpdir(), "longtable-work-"));
const remote = join(scratch, "remote.git");
const project = join(scratch, "project");
git(scratch, "init", "-q", "--bare", "-b", "main", remote);
git(scratch, "clone", "-q", remote, project);
writeFileSync(join(project, "greet.js"), 'export const greeting = "hello";\n');
writeFileSync(join(project, "README.md"), "# Greeter\n\nOne file, greet.js, that exports a greeting.\n");
git(project, "add", "-A");
git(project, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-q", "-m", "start");
git(project, "push", "-q", "origin", "HEAD:main");

function home() {
  const dir = mkdtempSync(join(tmpdir(), "longtable-home-"));
  mkdirSync(join(dir, "secrets"), { recursive: true });
  copyFileSync(savedSignIn, join(dir, "secrets", "claude-token.bin"));
  return dir;
}

async function connect(page, dir) {
  await page.click("[data-testid=me-menu]");
  await page.click("button:has-text('Connect my AI')");
  await page.click("[data-testid=pick-claude]");
  await page.click("text=It is only on my computer");
  const message = await page.locator("[data-testid=connect-message]").textContent();
  const [, code, app] = message.match(/connect ([0-9A-F]{20}) --app (\S+)/);
  const env = { ...process.env, LONGTABLE_HOME: dir, LONGTABLE_MODEL: "haiku" };
  const r = spawnSync(process.execPath, [bin, "connect", code, "--app", app, "--repo", project, "--no-autostart", "--no-run"], { env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  await page.locator("[role=dialog] button").last().click();
  return spawn(process.execPath, [bin, "run"], { env, stdio: "ignore", windowsHide: true });
}

const homes = [home(), home()];
const runners = [];
const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Greeter", "Maya");
  const dev = await joinTable(browser, await inviteLink(owner.page, "developer"), `dev-${run}@example.test`, "Sam");
  runners.push(await connect(dev.page, homes[0]));
  runners.push(await connect(owner.page, homes[1]));
  await owner.page.waitForFunction(() => document.querySelectorAll("[data-ai='intro']").length >= 2, null, { timeout: 180000 });

  // Sam asks for two things and says whose AI does which. The plan hands Maya's Claude its part.
  const asked = Date.now();
  await dev.page.fill("textarea", "Two things for the greeter. My Claude: change the greeting in greet.js to say hi. Maya's Claude always does our docs, so hand it this part: add a section called Usage to README.md that shows how to import the greeting.");
  await dev.page.click("button:has-text('Send')");
  await dev.page.waitForSelector("[data-testid=work-panel]", { timeout: 120000 });
  results.panelWhileWorking = (await dev.page.locator("[data-testid=work-panel]").textContent()).slice(0, 300);
  check("the work panel opens with the task once work starts", (await dev.page.locator("[data-testid=work-task]").count()) === 1, results.panelWhileWorking);
  await dev.page.waitForFunction(() => [...document.querySelectorAll("[data-ai='true']")].some((el) => el.textContent.includes("The table")), null, { timeout: 600000 });
  results.seconds = Math.round((Date.now() - asked) / 1000);
  results.answer = (await dev.page.locator("[data-ai='true']").filter({ hasText: "The table" }).last().textContent()).slice(0, 500);

  const token = await accessToken(owner.context);
  const jobs = (await rest(token, `jobs?select=kind,status,stage,member_id,brief,outcome&table_id=eq.${owner.tableId}&order=created_at`)).body;
  const members = (await rest(token, `members?select=id,display_name&table_id=eq.${owner.tableId}`)).body;
  const who = (id) => members.find((m) => m.id === id)?.display_name;
  results.jobs = jobs.map((j) => `${j.kind}${j.stage ? j.stage : ""}:${who(j.member_id)}:${j.status}`);
  const first = jobs.filter((j) => j.kind === "work" && j.stage === 0);
  check("the plan gave each Claude a part", jobs.some((j) => j.kind === "plan" && j.status === "done") && first.length === 2
    && first.some((j) => who(j.member_id) === "Sam") && first.some((j) => who(j.member_id) === "Maya" && /readme|usage/i.test(j.brief ?? "")), JSON.stringify(results.jobs));
  check("both looked over the whole of it", jobs.filter((j) => j.kind === "review" && j.stage === 0).length === 2, JSON.stringify(results.jobs));
  check("the round stopped by itself", jobs.filter((j) => j.kind === "combine").length === 1 && jobs.every((j) => ["done", "skipped"].includes(j.status)), JSON.stringify(results.jobs));

  const tasks = (await rest(token, `tasks?select=title,branch,status,result&table_id=eq.${owner.tableId}`)).body;
  results.tasks = tasks;
  check("one task, with a title and a branch of its own, finished", tasks.length === 1 && tasks[0].status === "done" && /^longtable\/[a-z0-9-]+-[0-9a-f]{8}$/.test(tasks[0].branch), JSON.stringify(tasks));
  const branch = tasks[0]?.branch;
  const branches = git(scratch, "--git-dir", remote, "branch", "--list").split(/\r?\n/).map((b) => b.replace(/^[* ]+/, ""));
  results.branches = branches;
  if (branch && branches.includes(branch)) {
    const code = git(scratch, "--git-dir", remote, "show", `${branch}:greet.js`);
    const readme = git(scratch, "--git-dir", remote, "show", `${branch}:README.md`);
    check("both parts are on the one branch", /hi/.test(code) && /usage/i.test(readme), JSON.stringify({ code, readme: readme.slice(0, 300) }));
  } else check("both parts are on the one branch", false, JSON.stringify(branches));
  check("no part was left on a side branch", branches.filter((b) => b.startsWith("longtable/")).length === 1, JSON.stringify(branches));
  check("the default branch is untouched", git(scratch, "--git-dir", remote, "show", "main:greet.js").includes('"hello"'), "");

  // The panel keeps the finished task as history; Clear takes it away and the panel with it, for that person only.
  const panel = dev.page.locator("[data-testid=work-panel]");
  results.panelAfter = (await panel.textContent()).slice(0, 300);
  check("the finished task stays in the panel with its branch", results.panelAfter.includes(`On ${branch}`), results.panelAfter);
  if (process.env.SCREENSHOTS) { await dev.page.setViewportSize({ width: 1440, height: 1000 }); await dev.page.screenshot({ path: `${process.env.SCREENSHOTS}/step14-panel.png` }); }
  await dev.page.click("[data-testid=work-clear]");
  await dev.page.waitForSelector("[data-testid=work-panel]", { state: "detached", timeout: 5000 }).then(() => check("Clear closes the panel", true), () => check("Clear closes the panel", false));
  await owner.page.reload();
  await owner.page.goto(owner.page.url().split("?")[0] + "?c=general");
  check("the other person still has theirs", (await owner.page.locator("[data-testid=work-task]").count()) === 1, "");
  await dev.page.reload();
  check("it stays cleared after a reload", (await dev.page.locator("[data-testid=work-panel]").count()) === 0, "");
} finally {
  for (const r of runners) r.kill();
  await browser.close();
  for (const h of [...homes, scratch]) { try { rmSync(h, { recursive: true, force: true }); } catch {} }
}

const failed = Object.values(results.checks).filter((v) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
