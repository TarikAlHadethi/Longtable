// Pages on the real model (Haiku, the saved sign-in): asked for one, a Claude at the table makes a page; asked a plain
// question, it makes none; sent a comment, it changes the page as a new version.
//
//   node --experimental-websocket tests/e2e/step36-pages-ai.mjs

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

const scratch = mkdtempSync(join(tmpdir(), "longtable-pages-"));
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
  const owner = await startTable(browser, `owner-${run}@example.test`, "Pages AI", "Maya");
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
  const pages = () => Number(sql(`select count(*) from public.pages where table_id = '${tableId}'`));
  const ask = async (text) => {
    const n = await page.locator("[data-ai='true']").count();
    await page.fill("textarea", text);
    await page.click("button:has-text('Send')");
    await page.waitForFunction((k) => document.querySelectorAll("[data-ai='true']").length > k, n, { timeout: 300000 });
    await wait(1500);
    return page.locator("[data-ai='true']").last().textContent();
  };

  const plain = await ask("what does greet.js export?");
  check("a plain question gets words, not a page", pages() === 0 && /greeting|hello/i.test(plain), plain.slice(0, 200));

  const a = await ask("Make me a page: a small table comparing three hosting options (Vercel, Netlify, Render) on price, speed and ease. Keep it short.");
  results.a = a.slice(0, 300);
  check("asked for a page, it makes one", pages() === 1, a.slice(0, 300));
  const pageId = sql(`select id from public.pages where table_id = '${tableId}' limit 1`);
  const html = pageId ? sql(`select html from public.page_versions where page_id = '${pageId}' and n = 1`) : "";
  check("it is a whole page with what was asked in it", /<html|<!doctype/i.test(html) && /Netlify/.test(html) && /Render/.test(html), html.slice(0, 300));
  check("it loads nothing from the network but the allowed CDNs", ![...html.matchAll(/(?:src|href)\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi)].some((m) => !/^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|fonts\.(googleapis|gstatic)\.com)\//.test(m[1])), html.slice(0, 300));
  await page.waitForSelector("[data-testid=page-card]", { timeout: 20000 });
  check("its answer carries the page's card", (await page.locator("[data-testid=page-card]").count()) === 1);

  const before = await page.locator("[data-ai='true']").count();
  await rpc(tok, "comment_page", { p: pageId, body: "Add a fourth row for Fly.io", to_ai: true });
  await page.waitForFunction((k) => document.querySelectorAll("[data-ai='true']").length > k, before, { timeout: 300000 });
  await wait(1500);
  const v = Number(sql(`select version from public.pages where id = '${pageId}'`));
  const html2 = sql(`select html from public.page_versions where page_id = '${pageId}' and n = ${v}`);
  check("sent a comment, it changes the same page as a new version", v === 2 && /Fly\.io/i.test(html2) && pages() === 1, { v, pages: pages() });
} catch (e) {
  check("the run did not crash", false, e.stack || String(e));
} finally {
  if (runner) runner.kill();
  await browser.close();
  for (const h of [dir, scratch]) { try { rmSync(h, { recursive: true, force: true }); } catch {} }
}
console.log(JSON.stringify(results, null, 2));
process.exit(Object.values(results.checks).some((v) => v !== "pass") ? 1 : 0);
