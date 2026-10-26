// A client's copy that keeps up with them: "Try it" waits for the hosting to put the newest change online, a build
// that fails is said plainly to the client and to the team, a change can be taken back (by the client, or by the
// team's "Not this"), and opening the page brings the copy up to the team's latest. Fake connection, real GitHub
// deliveries signed with the table's secret, no AI.
//
//   node --experimental-websocket tests/e2e/step49-copy-keeps-up.mjs

import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { API, APP, KEY, accessToken, launch, rpc, startTable, sleep } from "./lib.mjs";

const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
const anon = async (fn, args) => { const r = await fetch(`${API}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(args) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const run = Date.now().toString(36);
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 300)}`; };
const sha = (c) => c.repeat(40);
const browser = await launch();
try {
  const o = await startTable(browser, `copy-${run}@example.test`, "Fernhill Dental", "Maya Stone");
  const t = o.tableId;
  const tok = await accessToken(o.context);
  const code = (await rpc(tok, "start_pairing", { t, ai_kind: "claude" })).body;
  const device = (await anon("pair_connection", { code, device_label: "maya" })).body.token;
  sql(`update public.jobs set status = 'skipped' where table_id = '${t}' and kind = 'intro'`);
  const on = () => sql(`update public.connections set last_seen = now() where table_id = '${t}'`);
  await rpc(tok, "add_test_client", { t });
  const client = sql(`select id from public.members where table_id = '${t}' and test`);
  const maya = sql(`select id from public.members where table_id = '${t}' and role = 'owner'`);
  const branch = `longtable/sandbox-test-${client.slice(0, 8)}`;
  sql(`insert into public.sandboxes (member_id, table_id, mode, branch, url) values ('${client}', '${t}', 'sandbox', '${branch}', 'https://copy.example.test')`);
  const secret = (await rpc(tok, "connect_github", { t })).body;
  const deliver = async (state, commit, ref = branch) => {
    const text = JSON.stringify({ deployment: { sha: commit, ref }, deployment_status: { state, environment_url: "https://copy.example.test" }, repository: { full_name: "maya/booking", default_branch: "main" } });
    const sig = "sha256=" + createHmac("sha256", secret).update(text).digest("hex");
    return (await fetch(`${APP}/api/github/${t}`, { method: "POST", headers: { "Content-Type": "application/json", "X-GitHub-Event": "deployment_status", "X-Hub-Signature-256": sig, "X-GitHub-Delivery": `${run}-${state}-${commit}` }, body: text })).status;
  };
  const copy = async () => (await rpc(tok, "client_sandbox", { t })).body;
  // A change built by the team's Claude, finished as the connection finishes one.
  const built = async (words, commit) => {
    const ch = sql(`insert into public.sandbox_changes (table_id, member_id, words, status) values ('${t}', '${client}', '${words}', 'working') returning id`).split("\n")[0];
    const job = sql(`insert into public.jobs (table_id, member_id, kind, subject, change_id, status, started_at, lease_until) values ('${t}', '${maya}', 'sandbox', '${client}', '${ch}', 'running', now(), now() + interval '5 minutes') returning id`).split("\n")[0];
    await anon("runner_finish", { token: device, job, answer: "It is blue now.", info: { changed: true, commit, files: ["src/button.css"] } });
    return ch;
  };

  // 1. With hosting that has never reported a build, "Try it" is there at once, as before.
  on();
  const c1 = await built("make the button blue", sha("a"));
  let s = await copy();
  check("a copy whose hosting never reported a build is not held back", s.building === false && s.broken === false, s);

  // 2. Once the hosting reports builds, the newest change waits for its own to be online.
  check("a build starting is heard", (await deliver("in_progress", sha("a"))) === 204);
  s = await copy();
  check("while the newest change is not online yet, the copy is building", s.building === true, s);
  await deliver("success", sha("a"));
  s = await copy();
  check("once it is online, it is not", s.building === false && s.broken === false, s);

  // 3. A change that does not build: the client is told on that change, the team in General.
  const c2 = await built("move the widget", sha("b"));
  check("a new change is building again", (await copy()).building === true);
  await deliver("failure", sha("b"));
  s = await copy();
  const change2 = s.changes.find((c) => c.id === c2);
  check("a failed build is said on that change, and the copy is not building any more", s.broken === true && s.building === false && change2?.did_not_build === true, { broken: s.broken, change2 });
  check("the team hears it in General, in plain words", sql(`select count(*) from public.messages where table_id = '${t}' and kind = 'github' and body like '%copy did not build after "move the widget"%'`) === "1");

  // 4. The client takes their newest change back.
  on();
  const undone = await rpc(tok, "client_undo_change", { t });
  check("the client can take back their newest change", undone.body === c2, undone);
  check("it shows as being taken back", (await copy()).changes.find((c) => c.id === c2)?.undone === "undoing");
  check("only one is taken back at a time", (await rpc(tok, "client_undo_change", { t })).status >= 400);
  const claim = (await anon("runner_claim", { token: device, lane: "heavy" })).body;
  check("its computer is handed the commit to take back, marked so an older connection only looks", claim?.undo === true && claim.probe === true && claim.commit === sha("b") && claim.branch === branch, claim);
  await anon("runner_finish", { token: device, job: claim.job_id, answer: "", info: { undone: true, commit: sha("c") } });
  s = await copy();
  check("taken back, and the copy's newest commit is the one that took it back", s.changes.find((c) => c.id === c2)?.undone === "undone" && s.building === true && s.broken === false, s);

  // 5. The team's "Not this" takes a change back out too.
  const nay = await rpc(tok, "judge_change", { change: c1, answer: "no" });
  check("the team's Not this takes the change back out of the copy", nay.status < 300 && sql(`select undone from public.sandbox_changes where id = '${c1}'`) === "undoing", nay);
  // A connection from before undo only looks at the branch: nothing happened, and it can be asked again.
  const old = (await anon("runner_claim", { token: device, lane: "heavy" })).body;
  await anon("runner_finish", { token: device, job: old.job_id, answer: "", info: { commit: sha("c") } });
  check("an older connection's answer leaves the change as it was, to be taken back later", sql(`select coalesce(undone, 'none') from public.sandbox_changes where id = '${c1}'`) === "none");
  // One whose job went away is freed the same way.
  sql(`update public.sandbox_changes set undone = 'undoing' where id = '${c1}'`);
  sql(`select public.close_sandbox()`);
  check("a take-back whose job is gone is freed", sql(`select coalesce(undone, 'none') from public.sandbox_changes where id = '${c1}'`) === "none");

  // 6. Opening the page brings the copy up to the team's latest, at most hourly.
  on();
  check("opening the page catches the copy up", (await rpc(tok, "client_refresh_copy", { t })).body === true
    && sql(`select count(*) from public.jobs where subject = '${client}' and kind = 'sandbox' and brief = 'refresh' and status = 'queued'`) === "1");
  check("but not again within the hour", (await rpc(tok, "client_refresh_copy", { t })).body === false);
  // The team's latest clashes with their changes: the copy is behind, said plainly to them and once to the team.
  const refresh = (await anon("runner_claim", { token: device, lane: "heavy" })).body;
  await anon("runner_finish", { token: device, job: refresh.job_id, answer: "", info: { stale: true } });
  check("a copy that cannot take in the team's latest says it is behind", (await copy()).behind === true);
  check("the team hears it once in General", sql(`select count(*) from public.messages where table_id = '${t}' and meta ->> 'event' = 'copy_behind'`) === "1");
  sql(`update public.sandboxes set refreshed_at = null where member_id = '${client}'`); on();
  await rpc(tok, "client_refresh_copy", { t });
  const again = (await anon("runner_claim", { token: device, lane: "heavy" })).body;
  await anon("runner_finish", { token: device, job: again.job_id, answer: "", info: { stale: true } });
  check("still behind is not said to the team twice", sql(`select count(*) from public.messages where table_id = '${t}' and meta ->> 'event' = 'copy_behind'`) === "1");
  sql(`update public.sandboxes set refreshed_at = null where member_id = '${client}'`); on();
  await rpc(tok, "client_refresh_copy", { t });
  const fits = (await anon("runner_claim", { token: device, lane: "heavy" })).body;
  await anon("runner_finish", { token: device, job: fits.job_id, answer: "", info: { stale: false, commit: sha("e") } });
  check("once it fits again, it is not behind any more", (await copy()).behind === false);
  // With nothing to take back, it says so.
  sql(`update public.sandbox_changes set undone = 'undone' where member_id = '${client}'`);
  const none = await rpc(tok, "client_undo_change", { t });
  check("with nothing left in the copy, there is nothing to take back", none.status >= 400 && /nothing to take back/.test(JSON.stringify(none.body)), none);
  // 6. The table's copy rules: screens only unless the owner says otherwise, and their own list of paths kept out.
  const ch6 = sql(`insert into public.sandbox_changes (table_id, member_id, words, status) values ('${t}', '${client}', 'a rule check', 'working') returning id`).split("\n")[0];
  const job6 = sql(`insert into public.jobs (table_id, member_id, kind, subject, change_id, status) values ('${t}', '${maya}', 'sandbox', '${client}', '${ch6}', 'skipped') returning id`).split("\n")[0];
  const payload = () => JSON.parse(sql(`select public.sandbox_job_payload(j)::text from public.jobs j where id = '${job6}'`));
  check("a copy changes screens only by default, with nothing extra kept out", payload().scope === "screens" && payload().blocked === "", payload());
  check("someone signed out cannot set the rules", (await anon("set_copy_rules", { t, scope: "code", blocked: "" })).status >= 400);
  check("a mode that does not exist is refused", (await rpc(tok, "set_copy_rules", { t, scope: "everything", blocked: "" })).status >= 400);
  check("a path that climbs out is refused", (await rpc(tok, "set_copy_rules", { t, scope: "code", blocked: "../secrets, proxy.ts" })).status >= 400);
  check("odd characters in a path are refused", (await rpc(tok, "set_copy_rules", { t, scope: "code", blocked: "prisma/; drop" })).status >= 400);
  const set = await rpc(tok, "set_copy_rules", { t, scope: "code", blocked: " prisma/,\nsrc/infrastructure/ai/ , , proxy.ts" });
  check("the owner sets the code rules and a tidy list", set.status < 300 && payload().scope === "code" && payload().blocked === "prisma/, src/infrastructure/ai/, proxy.ts", { set, p: payload() });
  check("saving the other copy settings keeps the rules", (await rpc(tok, "set_sandbox_links", { t, ours: "", cap: 20, folders: "" })).status < 300 && payload().scope === "code" && payload().blocked.includes("proxy.ts"), payload());
  check("the change is in the log", sql(`select count(*) from public.activity where table_id = '${t}' and action = 'sandbox.rules'`) !== "0");

  // The team never reads client_sandbox for another client's copy: it is the client's own (or the owner acting as the test client).
  check("a delivery for another branch changes nothing", (await deliver("failure", sha("d"), "longtable/someone-else")) === 204 && (await copy()).broken === false);
} catch (e) { check("the run did not crash", false, e.stack || e.message); }
await browser.close();
console.log(JSON.stringify({ checks: results }, null, 2));
const failed = Object.values(results).filter((v) => v !== "pass").length;
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
