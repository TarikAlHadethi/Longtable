// Everything behind "/" on the real model (Haiku, the saved sign-in): her effort and fast mode reach her Claude's runs
// and it still answers, Claude Code's own list of commands reaches the table by name, and a command the table runs in
// its own words (/recap) is done by her Claude.
//
//   node --experimental-websocket tests/e2e/step39-every-command-ai.mjs

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accessToken, launch, rpc, startTable } from "./lib.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const bin = join(repoRoot, "packages", "connect", "bin", "longtable.mjs");
const run = Date.now().toString(36);
const results = { checks: {} };
const check = (name, ok, detail) => { results.checks[name] = ok ? "pass" : `FAIL ${typeof detail === "string" ? detail : JSON.stringify(detail ?? "")}`.trim().slice(0, 500); };
const savedSignIn = join(homedir(), ".longtable", "secrets", "claude-token.bin");
if (!existsSync(savedSignIn)) throw new Error("No saved Claude sign-in on this computer.");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const scratch = mkdtempSync(join(tmpdir(), "longtable-cmds-"));
const remote = join(scratch, "remote.git");
const project = join(scratch, "project");
git(scratch, "init", "-q", "--bare", "-b", "main", remote);
git(scratch, "clone", "-q", remote, project);
writeFileSync(join(project, "greet.js"), 'export const greeting = "hello";\n');
git(project, "add", "-A");
git(project, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-q", "-m", "start");
git(project, "push", "-q", "origin", "HEAD:main");
const dir = mkdtempSync(join(tmpdir(), "longtable-home-"));
mkdirSync(join(dir, "secrets"), { recursive: true });
copyFileSync(savedSignIn, join(dir, "secrets", "claude-token.bin"));

const browser = await launch();
let runner = null;
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Commands AI", "Maya");
  const { page, tableId } = owner;
  const tok = await accessToken(owner.context);
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
  runner = spawn(process.execPath, [bin, "run"], { env, stdio: "ignore", windowsHide: true });
  await page.waitForFunction(() => document.querySelectorAll("[data-ai='intro']").length >= 1, null, { timeout: 180000 });
  const ask = async (text) => {
    const n = await page.locator("[data-ai='true']").count();
    await page.fill("textarea", text);
    await page.click("button:has-text('Send')");
    await page.waitForFunction((k) => document.querySelectorAll("[data-ai='true']").length > k, n, { timeout: 300000 });
    await wait(1500);
    return page.locator("[data-ai='true']").last().textContent();
  };
  const connId = sql(`select id from public.connections where table_id = '${tableId}' and revoked_at is null`);
  await rpc(tok, "set_ai_speed", { conn: connId, effort: "low", fast: true });
  const a = await ask("what does greet.js export? one sentence");
  check("with low effort and fast mode on, her Claude still answers", /greeting|hello/i.test(a), a.slice(0, 200));
  let fast = "";
  for (let i = 0; i < 20 && !fast; i++) { fast = sql(`select coalesce(limits ->> 'fast', '') || ' ' || coalesce(limits ->> 'fast_why', '') from public.connections where id = '${connId}'`).trim(); if (!fast) await wait(500); }
  results.fast = fast;
  check("her connection says whether fast mode can serve her", /^(on|off|cooldown)/.test(fast), fast);
  let names = [];
  for (let i = 0; i < 90 && !names.includes("compact"); i++) { names = JSON.parse(sql(`select coalesce(jsonb_agg(c ->> 'name'), '[]') from public.connections, jsonb_array_elements(commands) c where id = '${connId}'`) || "[]"); if (!names.includes("compact")) await wait(1000); }
  check("Claude Code's own list of commands reaches the table by name", ["compact", "model", "effort", "review"].every((n) => names.includes(n)), names.slice(0, 30));
  const recap = await ask("/recap");
  check("/recap is done by her Claude, from the conversation", recap.length > 40 && /greet|export|hello/i.test(recap), recap.slice(0, 300));
} catch (e) {
  check("the run did not crash", false, e.stack || String(e));
} finally {
  if (runner) runner.kill();
  await browser.close();
  for (const h of [dir, scratch]) { try { rmSync(h, { recursive: true, force: true }); } catch {} }
}
console.log(JSON.stringify(results, null, 2));
process.exit(Object.values(results.checks).some((v) => v !== "pass") ? 1 : 0);
