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
import { accessToken, launch, rest, rpc, startTable, tableRepo } from "./lib.mjs";

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
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => /It is only on my computer/.test(b.textContent || ""))
    || /connect [0-9A-F]{20}/.test(document.querySelector("[data-testid=connect-message]")?.textContent || ""));
  if (await page.locator("text=It is only on my computer").count()) await page.click("text=It is only on my computer");
  const message = await page.locator("[data-testid=connect-message]").textContent();
  const [, code, app] = message.match(/connect ([0-9A-F]{20})(?: --repo \S+)? --app (\S+)/);
  const env = { ...process.env, LONGTABLE_HOME: home, LONGTABLE_MODEL: "haiku", LONGTABLE_FULL: "on" };
  const r = spawnSync(process.execPath, [bin, "connect", code, "--app", app, "--repo", project, "--no-autostart", "--no-run"], { env, cwd: project, encoding: "utf8" });
  // The team shares its code in the stand-in for GitHub, set as the table's repository.
  await tableRepo(owner.tableId, remote);
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  await page.locator("[role=dialog] button").last().click();
  runner = spawn(process.execPath, [bin, "run"], { env, cwd: project, stdio: "ignore", windowsHide: true });
  await page.waitForFunction(() => document.querySelectorAll("[data-ai='intro']").length >= 1, null, { timeout: 180000 });

  // Her full Claude Code is on from the start, in her own folder, in Auto.
  const token = await accessToken(owner.context);
  const conn = (await rest(token, `connections?select=id,full_claude,in_folder,mode&table_id=eq.${owner.tableId}&revoked_at=is.null`)).body[0];
  check("full Claude Code starts on, working in her own folder, in Auto", conn && conn.full_claude === true && conn.in_folder === true && conn.mode === "auto", conn);
  // Auto would run a harmless command without asking; Accept edits changes files and asks about every command, which
  // is what is checked here.
  const asks = await rpc(token, "set_ai_mode", { conn: conn.id, mode: "acceptEdits" });
  check("she switches to Accept edits", asks.status < 300, asks);

  // She asks for something that needs a command run.
  await page.fill("textarea", "Add a farewell export to greet.js that says bye. Then run `node check.js` and tell me exactly what it printed.");
  await page.keyboard.press("Control+Enter");
  const card = page.locator("[data-testid=approvals] [data-approval]").first();
  await card.waitFor({ timeout: 300000 });
  const what = await card.textContent();
  results.asked = what;
  check("her Claude's request reaches her in Longtable", /wants to run/.test(what), what);
  const why = await card.locator("[data-testid=approval-why]").textContent().catch(() => null);
  results.why = why;
  check("it says why in plain words, as Claude wrote it", !!why && why.trim().length > 3, why);
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

  // Her next request carries on the same session, as at home: what it ran last time is still there. The command's
  // output is only in the session (she asks it not to say it), so only a session that carried on can answer.
  // A plain number nobody could guess (an id-like marker made it decline to repeat it).
  const ADD = 1000 + Math.floor(Math.random() * 8000);
  const MARK2 = String(6 * 7 + ADD);
  const count0 = await page.locator("[data-ai='true']").count();
  await page.fill("textarea", `Run node -e "console.log('The number is ' + (6 * 7 + ${ADD}))" and read what it prints yourself, but do not repeat it in your reply: just reply with the single word done.`);
  await page.keyboard.press("Control+Enter");
  for (let i = 0; i < 420; i++) {
    if ((await page.locator("[data-ai='true']").count()) > count0) break;
    const ok = page.locator("[data-testid=approvals] [data-approval] [data-testid=allow]").first();
    if (await ok.count()) await ok.click().catch(() => {});
    await page.waitForTimeout(1000);
  }
  const quiet = (await page.locator("[data-ai='true']").last().textContent()) || "";
  const count1 = await page.locator("[data-ai='true']").count();
  await page.fill("textarea", "What exactly did that last command print? Do not run anything again; answer from what you already saw.");
  await page.keyboard.press("Control+Enter");
  for (let i = 0; i < 420; i++) {
    if ((await page.locator("[data-ai='true']").count()) > count1) break;
    const no = page.locator("[data-testid=approvals] [data-approval] [data-testid=deny]").first();
    if (await no.count()) await no.click().catch(() => {});
    await page.waitForTimeout(1000);
  }
  const recalled = (await page.locator("[data-ai='true']").last().textContent()) || "";
  results.session = { quiet: quiet.slice(-200), recalled: recalled.slice(-300) };
  check("the output stayed out of the chat", !quiet.includes(MARK2), quiet.slice(-200));
  check("her next request carries on the same session and knows what the command printed", recalled.includes(MARK2), recalled.slice(-300));
  const runLog = readFileSync(join(home, "runner.log"), "utf8");
  check("the connection says it carried the chat's session on", /carrying on this chat's session/.test(runLog));

  // Her Claude asks her a question with choices: a card with a button each, and it carries on with her answer.
  const count2 = await page.locator("[data-ai='true']").count();
  await page.fill("textarea", "Before anything else, ask me with your question tool whether I want red or blue (those two choices). Then reply with only the colour I chose.");
  await page.keyboard.press("Control+Enter");
  const qcard = page.locator("[data-testid=approvals] [data-kind=question]").first();
  await qcard.waitFor({ timeout: 300000 });
  results.questionCard = (await qcard.textContent()).slice(0, 200);
  check("her Claude's question reaches her as a card with a button for each choice", (await qcard.locator("[data-testid=choice]").count()) >= 2, results.questionCard);
  await qcard.locator("[data-testid=choice]", { hasText: /blue/i }).first().click();
  for (let i = 0; i < 300; i++) { if ((await page.locator("[data-ai='true']").count()) > count2) break; await page.waitForTimeout(1000); }
  const chose = (await page.locator("[data-ai='true']").last().textContent()) || "";
  results.chose = chose.slice(-200);
  check("and it carries on with what she chose", /blue/i.test(chose) && !/\bred\b/i.test(chose.replace(/blue/gi, "")), chose.slice(-200));

  // While it works, what she types reaches it at its next step, as at home, instead of becoming a request of its own.
  const MARK3 = `PAPAYA-${run}`;
  const count3 = await page.locator("[data-ai='true']").count();
  await page.fill("textarea", `Run node -e "setTimeout(() => console.log('waited'), 20000)" (it takes about twenty seconds), then tell me it finished.`);
  await page.keyboard.press("Control+Enter");
  const waitCard = page.locator("[data-testid=approvals] [data-approval] [data-testid=allow]").first();
  await waitCard.waitFor({ timeout: 300000 });
  await waitCard.click();
  await page.waitForTimeout(3000);
  await page.fill("textarea", `Also end your reply with the word ${MARK3}.`);
  await page.keyboard.press("Enter");
  let sawWords = false;
  for (let i = 0; i < 300; i++) {
    if ((await page.locator("[data-ai='true']").count()) > count3) break;
    if (await page.locator("[data-testid=said-between]").count()) sawWords = true;
    const more = page.locator("[data-testid=approvals] [data-approval] [data-testid=allow]").first();
    if (await more.count()) await more.click().catch(() => {});
    await page.waitForTimeout(1000);
  }
  results.sawWords = sawWords;
  await page.waitForTimeout(15000);
  const answersNow = await page.locator("[data-ai='true']").count();
  const midway = (await page.locator("[data-ai='true']").nth(count3).textContent()) || "";
  results.midway = midway.slice(-250);
  check("what she typed while it worked reached the same run", midway.includes(MARK3), midway.slice(-250));
  check("and did not become a request of its own", answersNow === count3 + 1, { answersNow, expected: count3 + 1 });
  check("what it wrote between steps showed in the back room while it worked", sawWords);

  // It puts a file on its answer, as Claude in the app sends one.
  const count4 = await page.locator("[data-ai='true']").count();
  await page.fill("textarea", "Create a file named note.txt in the project containing the word hello, then share that file with me using your file-sharing tool, then reply with the single word done.");
  await page.keyboard.press("Control+Enter");
  for (let i = 0; i < 300; i++) {
    if ((await page.locator("[data-ai='true']").count()) > count4) break;
    const ok = page.locator("[data-testid=approvals] [data-approval] [data-testid=allow]").first();
    if (await ok.count()) await ok.click().catch(() => {});
    await page.waitForTimeout(1000);
  }
  let shared = "";
  for (let i = 0; i < 30 && !/note.txt/.test(shared); i++) { await page.waitForTimeout(1000); shared = (await page.locator("[data-ai='true']").last().locator("[data-testid=files]").textContent().catch(() => "")) || ""; }
  results.shared = shared;
  check("the file it shared shows on its answer", /note.txt/.test(shared), shared);

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
