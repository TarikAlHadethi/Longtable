// The same Claude: what a person and their Claude know on their own computer is there at the table too.
// (Setup as in step 12.)
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

// What this person's Claude knows on their own computer, planted for the test: instructions that are not in the
// repository, a memory file, and the end of a conversation.
const claudeHome = mkdtempSync(join(tmpdir(), "longtable-claude-"));
const slug = resolve(project).replace(/[^a-zA-Z0-9]/g, "-");
mkdirSync(join(claudeHome, "projects", slug, "memory"), { recursive: true });
writeFileSync(join(project, "CLAUDE.md"), "# Greeter, for Maya\n\nThe client is Dana Okafor, who runs the front desk. She is not technical.\n" + "Filler line that makes this file long.\n".repeat(900) + "\n## What Dana is waiting on\n- A Welsh greeting, which she calls the bore da one. She wants it before the open day.\n");
writeFileSync(join(claudeHome, "projects", slug, "memory", "MEMORY.md"), "- [Dana's deadline](dana-deadline.md) - the open day\n");
writeFileSync(join(claudeHome, "projects", slug, "memory", "dana-deadline.md"), "The open day is on 14 November. Dana wants the Welsh greeting live two days before it.\n");
const turn = (type, text) => JSON.stringify({ type, message: { role: type, content: type === "user" ? text : [{ type: "text", text }] } });
writeFileSync(join(claudeHome, "projects", slug, "session-1.jsonl"), [
  turn("user", "dana just called. she also wants the greeting to be in capitals on the big screen, she said it twice"),
  turn("assistant", "Noted: capitals on the big screen. I have not started it. The Welsh greeting comes first."),
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ignored tool output XYZZY" }] } }),
  turn("user", "<system-reminder>not something anyone said</system-reminder>"),
].join("\n") + "\n");

const homes = [home()];
const runners = [];
const browser = await launch();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const NLre = /\r?\n/;
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Greeter", "Maya");
  process.env.LONGTABLE_CLAUDE_HOME = claudeHome;
  runners.push(await connect(owner.page, homes[0]));
  await owner.page.waitForFunction(() => document.querySelectorAll("[data-ai='intro']").length >= 1, null, { timeout: 180000 });
  const token = await accessToken(owner.context);
  const jobs = async () => (await rest(token, `jobs?select=kind,status,outcome,member_id&table_id=eq.${owner.tableId}&kind=neq.intro&order=created_at`)).body;
  const lastAi = async () => (await owner.page.locator("[data-ai='true']").last().textContent());
  const ask = async (text, n) => {
    await owner.page.fill("textarea", text);
    await owner.page.click("button:has-text('Send')");
    await owner.page.waitForFunction((k) => document.querySelectorAll("[data-ai='true']").length >= k, n, { timeout: 300000 });
    await wait(800);
    return lastAi();
  };

  // A question asked for real. Nothing in the repository or the chat answers it; only what her Claude knows does.
  const a1 = await ask("does dana want anything from me?", 1);
  results.a1 = a1.slice(0, 700);
  const js = await jobs();
  results.jobs = js.map((j) => `${j.kind}:${j.status}:${j.outcome?.act ?? ""}`);
  check("a question that needs knowing the project goes to her own Claude, not the quick listener", js[0]?.outcome?.act === "look" && js[1]?.kind === "look" && /Maya's Claude/.test(a1), results.jobs);
  check("it knows what is only in her instructions, far down a long file", /welsh|bore da/i.test(a1), a1.slice(0, 500));
  check("it knows what is only in her Claude's memory", /14 November|open day/i.test(a1), a1.slice(0, 500));
  check("it knows what was only said in her own conversation with her Claude", /capital/i.test(a1), a1.slice(0, 500));
  check("it does not name where it knows it from, or repeat the app's own notes", !/longtable-yours|recent-conversation|project-instructions|MEMORY\.md|XYZZY|system-reminder/i.test(a1), a1.slice(0, 500));

  // Work after that: what her Claude knows is laid beside the code to read, and none of it is ever committed.
  const a2 = await ask("please add a welsh greeting export called bore to greet.js that says bore da", 2);
  results.a2 = a2.slice(0, 300);
  const branches = git(scratch, "--git-dir", remote, "branch", "--list").split(NLre).map((b) => b.replace(/^[* ]+/, "")).filter(Boolean);
  const made = branches.find((b) => b.startsWith("longtable/"));
  const tree = made ? git(scratch, "--git-dir", remote, "ls-tree", "-r", "--name-only", made).split(NLre) : [];
  results.tree = tree;
  check("the change is made", !!made && /bore da/i.test(git(scratch, "--git-dir", remote, "show", `${made}:greet.js`)), { branches });
  check("and nothing of what her Claude knows is in the commit", tree.length > 0 && !tree.some((f) => /longtable-yours|CLAUDE\.md|recent-conversation|memory\//.test(f)), tree);
} finally {
  for (const r of runners) r.kill();
  await browser.close();
  for (const h of [...homes, scratch, claudeHome]) { try { rmSync(h, { recursive: true, force: true }); } catch {} }
}

const failed = Object.values(results.checks).filter((v) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
