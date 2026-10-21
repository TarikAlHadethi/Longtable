// Co-owners and what each teammate may change: only the main owner makes co-owners, deletes the table or takes an
// owner off; a co-owner does everything else; a developer changes the table, invites or handles clients only when an
// owner turned that on for them.
//
//   node --experimental-websocket tests/e2e/step44-co-owners.mjs

import { execFileSync } from "node:child_process";
import { accessToken, inviteLink, join as joinTable, launch, rpc, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 300)}`; };
const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
const ok = (r) => r.status < 300;

const browser = await launch();
try {
  const owner = await startTable(browser, `main-${run}@example.test`, "Co-owners", "Maya Stone");
  const T = owner.tableId;
  const sam = await joinTable(browser, await inviteLink(owner.page, "developer"), `sam-${run}@example.test`, "Sam Ali");
  const lee = await joinTable(browser, await inviteLink(owner.page, "developer"), `lee-${run}@example.test`, "Lee Park");
  const elena = await joinTable(browser, await inviteLink(owner.page, "client"), `elena-${run}@example.test`, "Elena");
  const tok = { maya: await accessToken(owner.context), sam: await accessToken(sam.context), lee: await accessToken(lee.context), elena: await accessToken(elena.context) };
  const id = (name) => sql(`select id from public.members where table_id = '${T}' and display_name = '${name}'`);
  const [mayaId, samId, leeId, elenaId] = ["Maya Stone", "Sam Ali", "Lee Park", "Elena"].map(id);

  check("the table knows its main owner", sql(`select main_owner from public.tables where id = '${T}'`) === mayaId);

  // Plain developers change nothing of the table's.
  check("a developer cannot rename the table", !ok(await rpc(tok.sam, "update_table", { t: T, table_name: "Mine now", undo: 10, requests_chat: null })));
  check("or invite", !ok(await rpc(tok.sam, "create_invite", { t: T, invite_role: "developer" })));
  check("or set who answers a client", !ok(await rpc(tok.sam, "set_client_answerer", { m: elenaId, who: "table" })));
  check("or give themselves access", !ok(await rpc(tok.sam, "set_member_access", { m: samId, settings: true, invite: true, clients: true })));
  check("or make anyone a co-owner", !ok(await rpc(tok.sam, "set_co_owner", { m: samId, co: true })));

  // Each switch opens exactly its own part.
  check("the owner gives Sam the table's settings", ok(await rpc(tok.maya, "set_member_access", { m: samId, settings: true, invite: false, clients: false })));
  check("then Sam renames the table", ok(await rpc(tok.sam, "update_table", { t: T, table_name: "Co-owners", undo: 10, requests_chat: null })));
  check("but still cannot invite or handle clients", !ok(await rpc(tok.sam, "create_invite", { t: T, invite_role: "developer" })) && !ok(await rpc(tok.sam, "set_client_answerer", { m: elenaId, who: "table" })));
  await rpc(tok.maya, "set_member_access", { m: samId, settings: null, invite: true, clients: null });
  check("with invite on, Sam invites", ok(await rpc(tok.sam, "create_invite", { t: T, invite_role: "client" })));
  await rpc(tok.maya, "set_member_access", { m: samId, settings: null, invite: null, clients: true });
  check("with clients on, Sam sets who answers a client", ok(await rpc(tok.sam, "set_client_answerer", { m: elenaId, who: "table" })));
  check("but cannot take a developer off", !ok(await rpc(tok.sam, "remove_member", { m: leeId })));
  check("a client cannot be given access", !ok(await rpc(tok.maya, "set_member_access", { m: elenaId, settings: true, invite: true, clients: true })));

  // Co-owners.
  check("the main owner makes Lee a co-owner", ok(await rpc(tok.maya, "set_co_owner", { m: leeId, co: true })) && sql(`select role from public.members where id = '${leeId}'`) === "owner");
  check("the table now has two owners", sql(`select count(*) from public.members where table_id = '${T}' and role = 'owner' and removed_at is null`) === "2");
  check("a co-owner renames the table and sets access", ok(await rpc(tok.lee, "update_table", { t: T, table_name: "Co-owners", undo: 10, requests_chat: null }))
    && ok(await rpc(tok.lee, "set_member_access", { m: samId, settings: false, invite: null, clients: null })));
  check("a co-owner cannot delete the table", !ok(await rpc(tok.lee, "delete_table", { t: T, confirm_name: "Co-owners" })) && sql(`select count(*) from public.tables where id = '${T}'`) === "1");
  check("or take the main owner off", !ok(await rpc(tok.lee, "remove_member", { m: mayaId })));
  check("or hand the table over", !ok(await rpc(tok.lee, "transfer_ownership", { m: samId })));
  check("or make more co-owners", !ok(await rpc(tok.lee, "set_co_owner", { m: samId, co: true })));
  check("a co-owner takes a developer off", ok(await rpc(tok.lee, "remove_member", { m: samId })));
  check("the main owner cannot be made a developer or taken off", !ok(await rpc(tok.maya, "set_co_owner", { m: mayaId, co: false })) && !ok(await rpc(tok.maya, "remove_member", { m: mayaId })));

  // With two owners at the table, the table still works: a question still finds the one whose AI writes the answer.
  const chat = sql(`select id from public.chats where table_id = '${T}' and is_general`);
  check("asking the table works with two owners", ok(await rpc(tok.maya, "ask_table", { c: chat, body: "Does anything break with two owners?" })));
  check("the main owner makes Lee a developer again", ok(await rpc(tok.maya, "set_co_owner", { m: leeId, co: false })) && sql(`select role from public.members where id = '${leeId}'`) === "developer");

  // On the screen: a switch the owner turns on stays on once the live change comes back (it used to be wiped by it).
  const p = owner.page;
  await p.goto(`${p.url().split("?")[0].replace(/\/settings.*$/, "")}/settings`);
  await p.click("button:has-text('People')");
  await p.click("[data-person='Lee Park'] summary");
  const lees = p.locator("[data-person='Lee Park'] [data-testid=may-invite]");
  const before = await lees.isChecked();
  await lees.click();
  await p.waitForTimeout(2500);
  const shown = await lees.isChecked();
  const kept = sql(`select can_invite from public.members where id = '${leeId}'`);
  check("a switch pressed in Settings stays as pressed after the live change", shown === !before && kept === (before ? "f" : "t"), { before, shown, kept });
} catch (e) {
  check("the run did not crash", false, e.stack || e.message);
} finally {
  await browser.close();
}
console.log(JSON.stringify({ checks: results }, null, 2));
const failed = Object.values(results).filter((v) => v !== "pass").length;
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
