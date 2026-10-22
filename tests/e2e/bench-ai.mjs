// How fast the table answers, stage by stage, on the real model: from a message being said to the table's answer
// (heard, listener, the answering job picked up, the answering run), with the tokens each job used. One person, their
// own full Claude Code in their own folder (the everyday path), on Haiku unless BENCH_MODEL says otherwise.
//
//   node --experimental-websocket tests/e2e/bench-ai.mjs            (writes tests/e2e/bench-ai.json too)

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, startTable, tableRepo } from "./lib.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const bin = join(repoRoot, "packages", "connect", "bin", "longtable.mjs");
const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-F", "|", "-c", q], { encoding: "utf8" }).trim();
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const savedSignIn = join(homedir(), ".longtable", "secrets", "claude-token.bin");
if (!existsSync(savedSignIn)) throw new Error("No saved Claude sign-in on this computer.");

// A small project with a little in it to read.
const scratch = mkdtempSync(join(tmpdir(), "longtable-bench-"));
const remote = join(scratch, "remote.git");
const project = join(scratch, "project");
git(scratch, "init", "-q", "--bare", "-b", "main", remote);
git(scratch, "clone", "-q", remote, project);
writeFileSync(join(project, "greet.js"), 'export const greeting = "hello";\nexport function greet(name) { return `${greeting}, ${name}!`; }\n');
writeFileSync(join(project, "README.md"), "# Greeter\n\nA tiny library: greet.js exports a greeting and a greet(name) function.\n");
git(project, "add", "-A");
git(project, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-q", "-m", "start");
git(project, "push", "-q", "origin", "HEAD:main");

const home = mkdtempSync(join(tmpdir(), "longtable-bench-home-"));
mkdirSync(join(home, "secrets"), { recursive: true });
copyFileSync(savedSignIn, join(home, "secrets", "claude-token.bin"));

const SAYS = [
  { kind: "question", body: "what does greet.js export?" },
  { kind: "follow-up", body: "and what would greet('Sam') return?" },
  { kind: "small talk", body: "nice, thanks" },
  { kind: "question", body: "how is the README describing this project, in one line?" },
];

const browser = await launch();
let runner = null;
const out = { model: process.env.BENCH_MODEL || "haiku", at: new Date().toISOString(), messages: [] };
try {
  const owner = await startTable(browser, `bench-${Date.now().toString(36)}@example.test`, "Greeter", "Maya");
  const { page, tableId } = owner;
  await page.click("[data-testid=me-menu]");
  await page.click("button:has-text('Connect my AI')");
  await page.click("[data-testid=pick-claude]");
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => /It is only on my computer/.test(b.textContent || ""))
    || /connect [0-9A-F]{20}/.test(document.querySelector("[data-testid=connect-message]")?.textContent || ""));
  if (await page.locator("text=It is only on my computer").count()) await page.click("text=It is only on my computer");
  const message = await page.locator("[data-testid=connect-message]").textContent();
  const [, code, app] = message.match(/connect ([0-9A-F]{20})(?: --repo \S+)? --app (\S+)/);
  const env = { ...process.env, LONGTABLE_HOME: home, LONGTABLE_MODEL: out.model, LONGTABLE_FULL: "on", LONGTABLE_NO_UPDATE: "1" };
  const r = spawnSync(process.execPath, [bin, "connect", code, "--app", app, "--repo", project, "--no-autostart", "--no-run"], { env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  await tableRepo(tableId, remote);
  sql(`update public.jobs set status = 'skipped' where table_id = '${tableId}' and kind = 'intro'`);
  runner = spawn(process.execPath, [bin, "run"], { env, stdio: "ignore", windowsHide: true });
  const me = sql(`select id from public.members where table_id = '${tableId}' and role = 'owner'`);
  const general = sql(`select id from public.chats where table_id = '${tableId}' and is_general`);
  for (let i = 0; i < 30 && sql(`select count(*) from public.connections where table_id = '${tableId}' and last_seen > now() - interval '20 seconds'`) !== "1"; i++) await sleep(1000);

  for (const say of SAYS) {
    const id = sql(`insert into public.messages (table_id, chat_id, member_id, body) values ('${tableId}', '${general}', '${me}', '${say.body.replace(/'/g, "''")}') returning id`).split("\n")[0];
    const t0 = Date.now();
    let done = false;
    // Finished when an answer lands after it, or when every job on it is over and nothing more is coming.
    while (!done && Date.now() - t0 < 240000) {
      await sleep(1000);
      const open = sql(`select count(*) from public.jobs where table_id = '${tableId}' and status in ('queued','running','waiting')`);
      const answered = sql(`select count(*) from public.messages where chat_id = '${general}' and by_ai and created_at > (select created_at from public.messages where id = '${id}')`);
      const listened = sql(`select count(*) from public.jobs where question_id = '${id}' and kind = 'listen' and status in ('done','failed','skipped')`);
      const heardAtAll = sql(`select count(*) from public.listens where chat_id = '${general}'`) !== "0" || sql(`select count(*) from public.jobs where question_id = '${id}'`) !== "0";
      done = open === "0" && (answered !== "0" || listened !== "0" || (!heardAtAll && Date.now() - t0 > 8000));
    }
    const rows = sql(`select j.kind, extract(epoch from j.created_at - m.created_at), extract(epoch from j.started_at - j.created_at), extract(epoch from j.finished_at - j.started_at), j.status, coalesce(j.usage::text, '{}'), coalesce(j.outcome ->> 'route', j.outcome ->> 'action', '')
      from public.jobs j join public.messages m on m.id = '${id}' where j.table_id = '${tableId}' and j.created_at >= m.created_at - interval '1 second' order by j.created_at`).split("\n").filter(Boolean).map((l) => {
      const [kind, after, wait, ran, status, usage, route] = l.split("|");
      let u = {};
      try { u = JSON.parse(usage); } catch {}
      return { kind, startsAfter: +(+after).toFixed(1), waitedToStart: +(+wait).toFixed(1), ran: ran ? +(+ran).toFixed(1) : null, status, route, tokensIn: (u.input || 0) + (u.cache_read || 0) + (u.cache_write || 0), cacheRead: u.cache_read || 0, cacheWrite: u.cache_write || 0, tokensOut: u.output || 0, turns: u.turns || null, modelMs: u.model_ms || null };
    });
    const ans = sql(`select extract(epoch from a.created_at - m.created_at) from public.messages a, public.messages m where m.id = '${id}' and a.chat_id = m.chat_id and a.by_ai and a.created_at > m.created_at order by a.created_at limit 1`);
    out.messages.push({ ...say, answeredAfter: ans ? +(+ans).toFixed(1) : null, jobs: rows });
    console.log(JSON.stringify(out.messages[out.messages.length - 1]));
    await sleep(2000);
  }
  // Where Claude Code's own time went, from the connection's log.
  out.claude = readFileSync(join(home, "runner.log"), "utf8").split("\n").filter((l) => /claude: started in/.test(l)).map((l) => l.slice(25));
} catch (e) {
  out.error = String(e?.stack || e).slice(0, 900);
} finally {
  if (runner) { if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(runner.pid), "/T", "/F"], { stdio: "ignore" }); else runner.kill(); }
  await browser.close();
  await sleep(800);
  try { rmSync(home, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }); } catch {}
}
writeFileSync(new URL("./bench-ai.json", import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ claude: out.claude, error: out.error }, null, 2));
