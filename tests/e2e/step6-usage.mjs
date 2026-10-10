// Step 6 check, usage: a developer's own Claude answers a question, reports its plan's limits on the way out, and
// the team's Usage page shows them (each window's use and when it resets) beside the work done at this table. A
// client cannot open the page, and nobody can write limits without a device token.
//
//   node tests/e2e/step6-usage.mjs

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP, accessToken, inviteLink, join as joinTable, launch, rest, rpc, startTable } from "./lib.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const bin = join(repoRoot, "packages", "connect", "bin", "longtable.mjs");
const run = Date.now().toString(36);
const results = { checks: {} };
const check = (name, ok, detail) => { results.checks[name] = ok ? "pass" : `FAIL ${detail ?? ""}`.trim(); };

const testHome = mkdtempSync(join(tmpdir(), "longtable-home-"));
const saved = join(homedir(), ".longtable", "secrets", "claude-token.bin");
if (!existsSync(saved)) throw new Error("No saved Claude sign-in on this computer.");
mkdirSync(join(testHome, "secrets"), { recursive: true });
copyFileSync(saved, join(testHome, "secrets", "claude-token.bin"));
const env = { ...process.env, LONGTABLE_HOME: testHome, LONGTABLE_MODEL: "haiku" };

const browser = await launch();
let runner;
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Booking app", "Maya");
  const tableId = owner.tableId;
  const dev = await joinTable(browser, await inviteLink(owner.page, "developer"), `dev-${run}@example.test`, "Sam");
  const client = await joinTable(browser, await inviteLink(owner.page, "client"), `client-${run}@example.test`, "Dr. Ruiz");

  await dev.page.click("button:has-text('Connect my AI')");
  await dev.page.click("[data-testid=pick-claude]");
  await dev.page.click("text=It is only on my computer");
  const message = await dev.page.locator("[data-testid=connect-message]").textContent();
  const m = message.match(/connect ([0-9A-F]{20}) --app (\S+)/);
  const connected = spawnSync(process.execPath, [bin, "connect", m[1], "--app", m[2], "--repo", repoRoot, "--no-autostart", "--no-run"], { env, encoding: "utf8" });
  check("Sam's Claude connects", connected.status === 0, connected.stderr || connected.stdout);
  runner = spawn(process.execPath, [bin, "run"], { env, stdio: "ignore", windowsHide: true });

  const ownerToken = await accessToken(owner.context);
  const general = (await rest(ownerToken, `chats?select=id&table_id=eq.${tableId}&is_general=eq.true`)).body[0].id;
  await rpc(ownerToken, "ask_table", { c: general, body: "What license does this project use?" });

  // Wait for the answer and the limits report that follows it.
  let limits = null;
  for (let i = 0; i < 90 && !limits?.windows?.length; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const row = (await rest(ownerToken, `connections?select=limits,limits_at&table_id=eq.${tableId}&revoked_at=is.null`)).body[0];
    limits = row?.limits;
  }
  results.limits = limits;
  const names = (limits?.windows ?? []).map((w) => w.name);
  check("his Claude reports its plan's limits after answering", limits?.ai === "claude" && names.includes("5-hour") && names.includes("weekly")
    && limits.windows.every((w) => w.used >= 0 && w.used <= 100 && w.resets), JSON.stringify(limits));

  await owner.page.goto(`${APP}/t/${tableId}/usage`);
  await owner.page.waitForFunction(() => /Resets/.test(document.querySelector("[data-person='Sam']")?.textContent || ""), null, { timeout: 15000 }).catch(() => {});
  const card = await owner.page.textContent("[data-person='Sam']");
  results.card = card;
  check("the Usage page shows them, with reset times and his work here", /5-hour limit/.test(card) && /Weekly limit/.test(card)
    && /Resets/.test(card) && /\d+%/.test(card) && /1 answer/.test(card), card);
  const clientCard = await owner.page.textContent("[data-person='Dr. Ruiz']");
  check("people without an AI show as not connected", clientCard.includes("Not connected"), clientCard);
  if (process.env.SCREENSHOTS) await owner.page.screenshot({ path: `${process.env.SCREENSHOTS}/step6-usage.png`, fullPage: true });

  await client.page.goto(`${APP}/t/${tableId}/usage`);
  check("a client cannot open it", !client.page.url().endsWith("/usage"), client.page.url());
  const forged = await rpc(ownerToken, "runner_report", { token: "0".repeat(64), limits: { ai: "claude", windows: [] } });
  check("nobody writes limits without a device token", forged.status >= 400, String(forged.status));
} finally {
  if (runner) runner.kill();
  await browser.close();
  try { results.runnerLog = readFileSync(join(testHome, "runner.log"), "utf8").split("\n").slice(-12); } catch {}
  rmSync(testHome, { recursive: true, force: true });
}

const failed = Object.values(results.checks).filter((v) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
