// Work at a table with two Claudes: the asker's Claude does the work, the other one says what it thinks before and
// looks it over after, and the table answers once. The change lands on the chat's branch, never the default one.
// Done when a request for a change puts a commit on the task's own branch in the project's repository, a review job ran,
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
import { accessToken, inviteLink, join as joinTable, launch, rest, startTable, tableRepo } from "./lib.mjs";

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
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => /It is only on my computer/.test(b.textContent || ""))
    || /connect [0-9A-F]{20}/.test(document.querySelector("[data-testid=connect-message]")?.textContent || ""));
  if (await page.locator("text=It is only on my computer").count()) await page.click("text=It is only on my computer");
  const message = await page.locator("[data-testid=connect-message]").textContent();
  const [, code, app] = message.match(/connect ([0-9A-F]{20})(?: --repo \S+)? --app (\S+)/);
  const env = { ...process.env, LONGTABLE_HOME: dir, LONGTABLE_MODEL: "haiku" };
  const r = spawnSync(process.execPath, [bin, "connect", code, "--app", app, "--repo", project, "--no-autostart", "--no-run"], { env, encoding: "utf8" });
  // The team shares its code in the stand-in for GitHub, set as the table's repository.
  await tableRepo(new URL(page.url()).pathname.split("/")[2], remote);
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

  // Sam asks for a change, so Sam's Claude does it and Maya's looks it over.
  const asked = Date.now();
  await dev.page.fill("textarea", "Change the greeting in greet.js to say hi, and add a farewell export that says bye.");
  await dev.page.click("button:has-text('Send')");
  await dev.page.waitForFunction(() => [...document.querySelectorAll("[data-ai='true']")].some((el) => el.textContent.includes("one answer from")), null, { timeout: 420000 });
  results.seconds = Math.round((Date.now() - asked) / 1000);
  const answer = dev.page.locator("[data-ai='true']").filter({ hasText: "one answer from" }).last();
  results.answer = (await answer.textContent()).slice(-700);
  check("the table's answer names the branch the change is on", results.answer.includes(" on longtable/") && /changed \d+ files? on longtable\//.test(results.answer), results.answer);

  const branches = git(scratch, "--git-dir", remote, "branch", "--list").split(/\r?\n/).map((b) => b.replace(/^[* ]+/, ""));
  results.branches = branches;
  const made = branches.find((b) => b.startsWith("longtable/"));
  check("the change is on the task's own branch in the repository", !!made, JSON.stringify(branches));
  const main = git(scratch, "--git-dir", remote, "show", "main:greet.js");
  check("the default branch is untouched", main.includes('"hello"') && !main.includes("farewell"), main);
  if (made) {
    const changed = git(scratch, "--git-dir", remote, "show", `${made}:greet.js`);
    results.file = changed;
    check("the file says what was asked", /hi/.test(changed) && /farewell/.test(changed) && /bye/.test(changed), changed);
  }

  const token = await accessToken(owner.context);
  const jobs = (await rest(token, `jobs?select=kind,status,stage,member_id,outcome&table_id=eq.${owner.tableId}&order=created_at`)).body;
  results.jobs = jobs.map((j) => `${j.kind}${j.stage ? j.stage : ""}:${j.status}`);
  const members = (await rest(token, `members?select=id,display_name&table_id=eq.${owner.tableId}`)).body;
  const sam = members.find((m) => m.display_name === "Sam")?.id;
  const works = jobs.filter((j) => j.kind === "work");
  check("the asker's Claude did the work", works.length >= 1 && works.every((j) => j.member_id === sam), JSON.stringify(results.jobs));
  check("the other Claude looked it over", jobs.some((j) => j.kind === "review" && j.member_id !== sam && j.status === "done"), JSON.stringify(results.jobs));
  check("the round stopped by itself: at most three goes, one answer", works.length <= 3 && jobs.filter((j) => j.kind === "combine").length === 1
    && jobs.every((j) => ["done", "skipped"].includes(j.status)), JSON.stringify(results.jobs));

  await answer.locator("button:has-text('How they got here')").click();
  const how = await answer.locator("[data-testid=how]").textContent();
  results.how = how.slice(0, 900);
  check("How they got here shows the work and the look over", /did the work/.test(how) && /looked it over|found a problem/.test(how), how);
  check("nobody is told to commit by hand", !/not committed|needs to (commit|push)|commit it yourself/i.test(results.answer), results.answer);

  if (process.env.SCREENSHOTS) {
    await dev.page.setViewportSize({ width: 1440, height: 1000 });
    await answer.scrollIntoViewIfNeeded();
    await dev.page.screenshot({ path: `${process.env.SCREENSHOTS}/step12-work.png` });
  }
} finally {
  for (const r of runners) r.kill();
  await browser.close();
  for (const h of [...homes, scratch]) { try { rmSync(h, { recursive: true, force: true }); } catch {} }
}

const failed = Object.values(results.checks).filter((v) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
