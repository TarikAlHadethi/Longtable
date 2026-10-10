// One Send button, one Claude at the table. (Header below is from step 12; the setup is the same.)
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

const homes = [home()];
const runners = [];
const browser = await launch();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Greeter", "Maya");
  const dev = await joinTable(browser, await inviteLink(owner.page, "developer"), `dev-${run}@example.test`, "Sam");
  runners.push(await connect(owner.page, homes[0]));
  await owner.page.waitForFunction(() => document.querySelectorAll("[data-ai='intro']").length >= 1, null, { timeout: 180000 });
  const token = await accessToken(owner.context);
  const jobs = async () => (await rest(token, `jobs?select=kind,status,outcome,error&table_id=eq.${owner.tableId}&kind=neq.intro&order=created_at`)).body;
  const say = async (page, text) => { await page.fill("textarea", text); await page.click("button:has-text('Send')"); };
  const settle = async (n, ms = 120000) => {
    const until = Date.now() + ms;
    for (;;) {
      const all = await jobs();
      if (all.length >= n && all.every((j) => ["done", "skipped", "failed"].includes(j.status))) return all;
      if (Date.now() > until) return all;
      await wait(1500);
    }
  };

  // Small talk costs nothing: no model is asked at all.
  await say(dev.page, "lol brb");
  await say(owner.page, "k");
  await wait(10000);
  let all = await jobs();
  check("small talk asks no model", all.length === 0, JSON.stringify(all));

  // People talking to each other: the listener hears it and stays out.
  await say(dev.page, "Maya can you send me the figma link later? I need it for the meeting tomorrow");
  all = await settle(1);
  check("people talking to each other get no AI", all.length === 1 && all[0].kind === "listen" && all[0].outcome?.act === "silent", JSON.stringify(all));
  const aiBefore = await owner.page.locator("[data-ai='true']").count();

  // A question about the code: one look, no change.
  await say(owner.page, "what does greet.js export right now?");
  all = await settle(3);
  results.look = all.map((j) => `${j.kind}:${j.status}:${j.outcome?.act ?? ""}`);
  check("a question about the code gets one look", all.length === 3 && all[1].outcome?.act === "look" && all[2].kind === "look" && all[2].status === "done", JSON.stringify(results.look));
  await owner.page.waitForFunction((n) => document.querySelectorAll("[data-ai='true']").length > n, aiBefore, { timeout: 30000 });
  check("nothing was pushed for a question", !git(scratch, "--git-dir", remote, "branch", "--list").includes("longtable/"), "");

  // A request for a change, then Stop.
  await say(owner.page, "Please write a long file docs/guide.md, at least 300 lines, explaining every part of this project in detail, then add ten more example files under examples/.");
  await owner.page.waitForSelector("[data-testid=stop-job]", { timeout: 60000 });
  await wait(8000);
  await owner.page.click("[data-testid=stop-job]");
  all = await settle(5, 60000);
  results.stopped = all.slice(3).map((j) => `${j.kind}:${j.status}:${j.outcome?.act ?? j.error ?? ""}`);
  check("the listener sent it to work, and Stop stopped it", all[3]?.outcome?.act === "work" && all[4]?.kind === "answer" && all[4]?.status === "skipped" && /stopped by Maya/.test(all[4]?.error ?? ""), JSON.stringify(results.stopped));
  await wait(26000);
  check("a stopped job stays stopped", (await jobs())[4]?.status === "skipped", "");
} finally {
  for (const r of runners) r.kill();
  await browser.close();
  for (const h of [...homes, scratch]) { try { rmSync(h, { recursive: true, force: true }); } catch {} }
}

const failed = Object.values(results.checks).filter((v) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
