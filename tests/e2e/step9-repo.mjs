// Where the code is: the first person to connect says where the project's repository is, once. After that the
// setup message carries the address, so an AI can be opened in any folder. The client can never read it.
//
//   node tests/e2e/step9-repo.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accessToken, inviteLink, join as joinTable, launch, rest, startTable } from "./lib.mjs";

const bin = join(resolve(fileURLToPath(new URL("../..", import.meta.url))), "packages", "connect", "bin", "longtable.mjs");

const run = Date.now().toString(36);
const results = { checks: {} };
const check = (name, ok, detail) => { results.checks[name] = ok ? "pass" : `FAIL ${detail ?? ""}`.trim(); };
const REPO = "https://github.com/example/booking-app";

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Booking app", "Maya");
  const dev = await joinTable(browser, await inviteLink(owner.page, "developer"), `dev-${run}@example.test`, "Sam");
  const client = await joinTable(browser, await inviteLink(owner.page, "client"), `client-${run}@example.test`, "Dr. Ruiz");

  await owner.page.click("[data-testid=me-menu]");
  await owner.page.click("button:has-text('Connect my AI')");
  await owner.page.click("[data-testid=pick-claude]");
  await owner.page.fill("#repo", "not an address");
  await owner.page.click("div[role=dialog] button:has-text('Save')");
  await owner.page.waitForSelector("div[role=dialog] .error");
  check("a wrong address is refused", /repository address/.test(await owner.page.textContent("div[role=dialog] .error")));
  await owner.page.fill("#repo", REPO);
  await owner.page.click("div[role=dialog] button:has-text('Save')");

  const mine = await owner.page.locator("[data-testid=connect-message]").textContent();
  check("the setup message carries the address and no longer asks for a folder", mine.includes(` --repo ${REPO} `) && !/in this folder/.test(mine) && /Only its answers leave this computer/.test(mine), mine);

  await dev.page.click("[data-testid=me-menu]");
  await dev.page.click("button:has-text('Connect my AI')");
  await dev.page.click("[data-testid=pick-codex]");
  const sams = await dev.page.locator("[data-testid=connect-message]").textContent();
  check("the next person is not asked again", sams.includes(` --repo ${REPO} `) && sams.includes("--ai codex"), sams);

  const seen = await rest(await accessToken(client.context), `table_code?table_id=eq.${owner.tableId}&select=repo_url`);
  check("the client cannot read where the code is", Array.isArray(seen.body) && seen.body.length === 0, JSON.stringify(seen.body));
  const set = await rest(await accessToken(client.context), "rpc/set_table_repo", { method: "POST", body: JSON.stringify({ t: owner.tableId, url: "https://github.com/evil/x" }) });
  check("the client cannot change it", set.status >= 400, JSON.stringify(set.body));

  // A connect that cannot find the project takes itself off the table again: nobody sees a connected AI that is
  // not running.
  const other = await startTable(browser, `owner2-${run}@example.test`, "Other app", "Noor");
  await other.page.click("[data-testid=me-menu]");
  await other.page.click("button:has-text('Connect my AI')");
  await other.page.click("[data-testid=pick-claude]");
  await other.page.click("text=It is only on my computer");
  const msg = await other.page.locator("[data-testid=connect-message]").textContent();
  const m = msg.match(/connect ([0-9A-F]{20}) --app (\S+)/);
  const empty = mkdtempSync(join(tmpdir(), "longtable-empty-"));
  const env = { ...process.env, LONGTABLE_HOME: mkdtempSync(join(tmpdir(), "longtable-home-")) };
  const out = spawnSync(process.execPath, [bin, "connect", m[1], "--app", m[2], "--no-autostart", "--no-run"], { cwd: empty, env, encoding: "utf8" });
  check("connecting from a folder that is not the project says so", out.status !== 0 && /not the project/.test(out.stderr), out.stderr || out.stdout);
  const left = await rest(await accessToken(other.context), `connections?table_id=eq.${other.tableId}&revoked_at=is.null&select=id`);
  check("and leaves no connection at the table", Array.isArray(left.body) && left.body.length === 0, JSON.stringify(left.body));
} finally {
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
if (Object.values(results.checks).some((v) => v !== "pass")) process.exit(1);
