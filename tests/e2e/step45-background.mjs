// Programs a person's own Claude starts and leaves running, on the real model: a server started in one message keeps
// running for the next, as in a Claude Code session at home, and is stopped once the chat's session goes quiet; one
// started outside a session (with "Work in my folder" off) is stopped as soon as its run ends.
//
// The connection runs here on this computer's saved Claude sign-in, on Haiku; the project is a scratch repository.
//
//   node --experimental-websocket tests/e2e/step45-background.mjs

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
const answers = async (url) => { try { return await (await fetch(url, { signal: AbortSignal.timeout(2000) })).text(); } catch { return null; } };
const PORT = 47000 + Math.floor(Math.random() * 1500);
const PORT2 = PORT + 1;

const scratch = mkdtempSync(join(tmpdir(), "longtable-bg-"));
const remote = join(scratch, "remote.git");
const project = join(scratch, "project");
git(scratch, "init", "-q", "--bare", "-b", "main", remote);
git(scratch, "clone", "-q", remote, project);
writeFileSync(join(project, "README.md"), "A scratch project.\n");
git(project, "add", "-A");
git(project, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-q", "-m", "start");
git(project, "push", "-q", "origin", "HEAD:main");

const home = mkdtempSync(join(tmpdir(), "longtable-home-"));
mkdirSync(join(home, "secrets"), { recursive: true });
copyFileSync(savedSignIn, join(home, "secrets", "claude-token.bin"));

let runner = null;
const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Servers", "Maya");
  const page = owner.page;
  await page.click("[data-testid=me-menu]");
  await page.click("button:has-text('Connect my AI')");
  await page.click("[data-testid=pick-claude]");
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => /It is only on my computer/.test(b.textContent || ""))
    || /connect [0-9A-F]{20}/.test(document.querySelector("[data-testid=connect-message]")?.textContent || ""));
  if (await page.locator("text=It is only on my computer").count()) await page.click("text=It is only on my computer");
  const message = await page.locator("[data-testid=connect-message]").textContent();
  const [, code, app] = message.match(/connect ([0-9A-F]{20})(?: --repo \S+)? --app (\S+)/);
  // A session that goes quiet for a minute has ended, so the test need not wait two hours.
  const env = { ...process.env, LONGTABLE_HOME: home, LONGTABLE_MODEL: "haiku", LONGTABLE_FULL: "on", LONGTABLE_SESSION_IDLE_MS: "60000" };
  const r = spawnSync(process.execPath, [bin, "connect", code, "--app", app, "--repo", project, "--no-autostart", "--no-run"], { env, cwd: project, encoding: "utf8" });
  await tableRepo(owner.tableId, remote);
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  await page.locator("[role=dialog] button").last().click();
  runner = spawn(process.execPath, [bin, "run"], { env, cwd: project, stdio: "ignore", windowsHide: true });
  await page.waitForFunction(() => document.querySelectorAll("[data-ai='intro']").length >= 1, null, { timeout: 180000 });
  const token = await accessToken(owner.context);
  const conn = (await rest(token, `connections?select=id&table_id=eq.${owner.tableId}&revoked_at=is.null`)).body[0];
  // Accept edits asks about every command, and every request is allowed here.
  await rpc(token, "set_ai_mode", { conn: conn.id, mode: "acceptEdits" });

  const ask = async (words) => {
    const before = await page.locator("[data-ai='true']").count();
    await page.fill("textarea", words);
    await page.keyboard.press("Control+Enter");
    for (let i = 0; i < 480; i++) {
      if ((await page.locator("[data-ai='true']").count()) > before) break;
      const ok = page.locator("[data-testid=approvals] [data-approval] [data-testid=allow]").first();
      if (await ok.count()) await ok.click().catch(() => {});
      await page.waitForTimeout(1000);
    }
    return (await page.locator("[data-ai='true']").last().textContent()) || "";
  };

  const UP = `UP-${run}`;
  const said1 = await ask(`Start a small web server that keeps running in the background: run node -e "require('http').createServer((q, s) => s.end('${UP}')).listen(${PORT})" with the Bash tool's run_in_background option. Do not wait for it to stop. Then reply with the single word started.`);
  results.said1 = said1.slice(-200);
  await sleep(2000);
  check("the server it started keeps running after its answer", (await answers(`http://127.0.0.1:${PORT}`)) === UP, said1.slice(-200));

  const said2 = await ask(`Fetch http://127.0.0.1:${PORT} with node and tell me exactly what it returned.`);
  results.said2 = said2.slice(-200);
  check("her next request in the same session uses it, as at home", said2.includes(UP), said2.slice(-300));

  // Nobody uses the session for a minute: it has ended, and what it left running is stopped.
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) { await sleep(5000); gone = (await answers(`http://127.0.0.1:${PORT}`)) === null; }
  check("once the session has gone quiet, its server is stopped", gone);

  // Outside a session (her folder switch off, so this request runs fresh in a worktree), nothing outlives the run.
  await rpc(token, "set_work_in_folder", { conn: conn.id, on_: false });
  const UP2 = `UP2-${run}`;
  const said3 = await ask(`Start a small web server that keeps running in the background: run node -e "require('http').createServer((q, s) => s.end('${UP2}')).listen(${PORT2})" with the Bash tool's run_in_background option, then reply with the single word started.`);
  results.said3 = said3.slice(-200);
  await sleep(6000);
  check("a server started outside a session is stopped when its run ends", (await answers(`http://127.0.0.1:${PORT2}`)) === null, said3.slice(-200));
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
