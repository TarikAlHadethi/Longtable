// Two people ask for different things at the same moment: two tasks, two branches, both AIs busy at once, the
// room showing what each is on. Then a follow-up that goes back to its own task. (Setup as in step 12.)
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

  const token = await accessToken(owner.context);
  const jobs = async () => (await rest(token, `jobs?select=kind,status,stage,member_id,task_id,progress,started_at&table_id=eq.${owner.tableId}&kind=neq.intro&order=created_at`)).body;
  const tasks = async () => (await rest(token, `tasks?select=id,title,branch,status,member_id&table_id=eq.${owner.tableId}&order=created_at`)).body;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Both ask at once, in plain words, through Send.
  await owner.page.fill("textarea", "Please add a file docs/colors.md that lists ten colour names, one per line, each with a one-sentence description.");
  await dev.page.fill("textarea", "Please add a file docs/animals.md that lists ten animals, one per line, each with a one-sentence description.");
  await Promise.all([owner.page.click("button:has-text('Send')"), dev.page.click("button:has-text('Send')")]);

  // Watch until both are done, noting what the room was told along the way.
  const seen = { progress: new Set(), together: false, panelTwo: false };
  const until = Date.now() + 9 * 60 * 1000;
  let ts = [];
  for (;;) {
    const js = await jobs();
    ts = await tasks();
    for (const j of js) if (j.progress) seen.progress.add(j.progress);
    const working = js.filter((j) => j.kind === "work" && j.status === "running");
    if (new Set(working.map((j) => j.task_id)).size >= 2) seen.together = true;
    if ((await owner.page.locator("[data-testid=work-task]").count()) >= 2) seen.panelTwo = true;
    if (ts.length >= 2 && ts.every((t) => t.status !== "working") && js.every((j) => !["queued", "running", "waiting"].includes(j.status))) break;
    if (Date.now() > until) break;
    await wait(1500);
  }
  results.tasks = ts;
  results.progress = [...seen.progress].slice(0, 12);
  results.jobs = (await jobs()).map((j) => `${j.kind}${j.stage ? j.stage : ""}:${j.status}`);
  check("two asks at once became two tasks, each its own person's", ts.length === 2 && new Set(ts.map((t) => t.member_id)).size === 2 && ts[0].branch !== ts[1].branch, ts);
  check("both finished", ts.length === 2 && ts.every((t) => t.status === "done"), { ts, jobs: results.jobs });
  check("the panel showed both", seen.panelTwo);
  check("the room was told what an AI was doing while it worked", [...seen.progress].some((p) => /editing|reading|searching/.test(p)), results.progress);
  const branches = git(scratch, "--git-dir", remote, "branch", "--list").split(/\r?\n/).map((b) => b.replace(/^[* ]+/, ""));
  results.branches = branches;
  const has = (branch, file) => { try { return git(scratch, "--git-dir", remote, "show", `${branch}:${file}`); } catch { return null; } };
  const colors = ts.find((t) => has(t.branch, "docs/colors.md"));
  const animals = ts.find((t) => has(t.branch, "docs/animals.md"));
  check("each change is on its own task's branch and not on the other's", !!colors && !!animals && colors.id !== animals.id && !has(colors.branch, "docs/animals.md") && !has(animals.branch, "docs/colors.md"), branches);
  check("the default branch has neither", !has("main", "docs/colors.md") && !has("main", "docs/animals.md"));
  await owner.page.waitForFunction(() => [...document.querySelectorAll("[data-ai='true']")].filter((el) => el.textContent.includes("The table")).length >= 2, null, { timeout: 30000 }).catch(() => {});
  check("there are two answers in the chat, one for each", (await owner.page.locator("[data-ai='true']").filter({ hasText: "The table" }).count()) === 2);

  // A follow-up to one of them goes back onto that task's branch.
  if (colors) {
    await owner.page.fill("textarea", "For the colours file you just made: add an eleventh colour, teal, at the end.");
    await owner.page.click("button:has-text('Send')");
    const end = Date.now() + 6 * 60 * 1000;
    for (;;) {
      ts = await tasks();
      const js = await jobs();
      if (js.some((j) => j.kind === "work" || j.kind === "answer") && js.length > results.jobs.length + 1 && js.every((j) => !["queued", "running", "waiting"].includes(j.status)) && ts.every((t) => t.status !== "working")) break;
      if (Date.now() > end) break;
      await wait(1500);
    }
    results.after = ts;
    results.followJobs = (await rest(token, `jobs?select=kind,status,outcome,task_id&table_id=eq.${owner.tableId}&kind=neq.intro&order=created_at`)).body.slice(results.jobs.length).map((j) => `${j.kind}:${j.status}:${j.outcome?.act ?? ""}:${(j.task_id ?? "").slice(0, 4)}`);
    results.lastAnswer = (await owner.page.locator("[data-ai='true']").last().textContent()).slice(0, 400);
    const text = has(colors.branch, "docs/colors.md") ?? "";
    check("a follow-up goes on with its own task: no third task, and the change is on that branch", ts.length === 2 && /teal/i.test(text), { count: ts.length, tail: text.slice(-200) });
  }
} finally {
  for (const r of runners) r.kill();
  await browser.close();
  for (const h of [...homes, scratch]) { try { rmSync(h, { recursive: true, force: true }); } catch {} }
}

const failed = Object.values(results.checks).filter((v) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
