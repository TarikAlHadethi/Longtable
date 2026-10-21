// Pictures of where the code is: the table's repository in Settings, and what an AI's window says it reads, with the
// switches for working in your folder and pushing. A stand-in connection reports what it reads; no AI runs.
//
//   node --experimental-websocket tests/e2e/look-repo.mjs

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { API, KEY, accessToken, launch, rest, rpc, startTable } from "./lib.mjs";

const out = new URL("../../tmp/look-repo/", import.meta.url);
mkdirSync(out, { recursive: true });
const run = Date.now().toString(36);
const anon = async (fn, args) => {
  const text = await (await fetch(`${API}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(args) })).text();
  try { return JSON.parse(text); } catch { return text; }
};

const browser = await launch();
const results = { checks: {} };
const check = (name, ok, detail) => { results.checks[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 300)}`; };
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Where the code is", "Maya");
  const { page, tableId } = owner;
  const tok = await accessToken(owner.context);
  const code = (await rpc(tok, "start_pairing", { t: tableId, ai_kind: "claude" })).body;
  const device = (await anon("pair_connection", { code, device_label: "look" })).token;
  await anon("runner_report", { token: device, limits: { ai: "claude", version: "0.1.37", reads: { repo: null, folder: "booking", known: false }, tools: ["git", "node", "npm", "docker", "bash"] } });
  await anon("runner_hello", { token: device });

  // Settings, General: the table's repository.
  await page.goto(`${page.url().split("?")[0]}/settings`);
  await page.waitForSelector("[data-testid=table-repo]");
  await page.fill("[data-testid=table-repo]", "https://github.com/fernhill/booking");
  await page.click("form[aria-label='Where the code is'] button:has-text('Save')");
  await page.waitForSelector("form[aria-label='Where the code is'] [role=status]");
  await page.screenshot({ path: new URL("settings-repo.png", out).pathname.slice(1), fullPage: true });
  const saved = (await rest(tok, `table_code?table_id=eq.${tableId}&select=repo_url`)).body;
  check("the repository typed in Settings is what was saved", saved?.[0]?.repo_url === "https://github.com/fernhill/booking", saved);

  // Her AI's window.
  await page.goto(page.url().replace(/\/settings.*$/, ""));
  await page.click("[data-testid=me-menu]");
  await page.click("text=Settings");
  await page.waitForSelector("[data-testid=ai-window]");
  await page.waitForTimeout(700);
  const reads = await page.locator("[data-testid=ai-reads]").textContent().catch(() => "");
  check("the window says it reads only the folder on her computer", /booking, only on your computer/.test(reads || ""), reads);
  // The table names a repository her connection was not connected with: it asks her, once, before using it.
  await page.waitForSelector("[data-testid=use-repo]");
  check("her AI asks her before using the table's repository", /github\.com\/fernhill\/booking/.test(await page.textContent("[data-testid=use-repo]")));
  await page.locator("[data-testid=use-repo]").screenshot({ path: new URL("use-repo.png", out).pathname.slice(1) });
  await page.click("[data-testid=use-repo-yes]");
  await page.waitForSelector("[data-testid=use-repo]", { state: "detached" });
  let yes = null;
  for (let i = 0; i < 20 && !yes?.[0]?.use_repo; i++) { await page.waitForTimeout(250); yes = (await rest(tok, `connections?table_id=eq.${tableId}&revoked_at=is.null&select=use_repo`)).body; }
  check("her yes is kept for exactly that address", yes?.[0]?.use_repo === "https://github.com/fernhill/booking", yes);
  check("working in her folder and pushing anywhere are switches of hers", (await page.locator("[data-testid=opt-in-folder]").count()) === 1 && (await page.locator("[data-testid=opt-push-anywhere]").count()) === 1);
  await page.locator("[data-testid=ai-window]").screenshot({ path: new URL("ai-window.png", out).pathname.slice(1) });
  await page.locator("[data-testid=opt-push-anywhere]").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: new URL("ai-window-switches.png", out).pathname.slice(1) });
  check("its window says which tools its Claude found", /Git, Node, npm/i.test(await page.locator("[data-testid=ai-tools]").textContent().catch(() => "")));
  await page.keyboard.press("Escape");

  // A finished task on a branch of the GitHub repository offers a pull request; a file an answer names links to it.
  const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
  const chat = sql(`select id from public.chats where table_id = '${tableId}' and is_general`);
  const maya = sql(`select id from public.members where table_id = '${tableId}'`);
  sql(`insert into public.tasks (table_id, chat_id, member_id, title, branch, status, result, finished_at) values ('${tableId}', '${chat}', '${maya}', 'Fix the login page', 'longtable/fix-login-1a2b3c4d', 'done', 'changed 2 files on longtable/fix-login-1a2b3c4d @ 1a2b3c4', now())`);
  sql(`insert into public.messages (table_id, chat_id, member_id, body, by_ai, kind, meta) values ('${tableId}', '${chat}', '${maya}', 'The redirect lives in \`src/auth/login.tsx:42\`.', true, 'answer', '{"read": "longtable/fix-login-1a2b3c4d @ 1a2b3c4"}')`);
  await page.reload();
  await page.click("text=# General").catch(async () => { await page.click("text=General"); });
  await page.waitForSelector("[data-testid=open-pr]", { timeout: 20000 });
  check("a finished branch offers a pull request on GitHub", await page.getAttribute("[data-testid=open-pr]", "href") === "https://github.com/fernhill/booking/compare/longtable/fix-login-1a2b3c4d?expand=1");
  const fileHref = await page.locator("a.code-link").first().getAttribute("href").catch(() => null);
  check("a file an answer names links to it, at what the answer read", fileHref === "https://github.com/fernhill/booking/blob/1a2b3c4/src/auth/login.tsx#L42", fileHref);
  await page.screenshot({ path: new URL("links.png", out).pathname.slice(1) });
} catch (e) {
  check("the run did not crash", false, e.stack || String(e));
} finally {
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
process.exit(Object.values(results.checks).some((v) => v !== "pass") ? 1 : 0);
