// What one person's AI read from their own computer is handed to the other AIs on the same request, and to nobody
// else. Fake connections hold each step still: no AI is asked anything.
//
//   node --experimental-websocket tests/e2e/step24-share.mjs

import { execFileSync } from "node:child_process";
import { accessToken, API, inviteLink, join as joinTable, KEY, launch, rest, rpc, sleep, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "")}`.slice(0, 500); };
const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
const anon = async (fn, args) => { const r = await fetch(`${API}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(args) }); return { status: r.status, body: await r.json().catch(() => null) }; };

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Booking app", "Maya");
  const table = owner.tableId;
  const dev = await joinTable(browser, await inviteLink(owner.page, "developer"), `dev-${run}@example.test`, "Sam");
  const elena = await joinTable(browser, await inviteLink(owner.page, "client"), `client-${run}@example.test`, "Elena Ruiz");
  const tokens = { Maya: await accessToken(owner.context), Sam: await accessToken(dev.context), Elena: await accessToken(elena.context) };
  const device = {};
  for (const name of ["Maya", "Sam"]) {
    const code = (await rpc(tokens[name], "start_pairing", { t: table, ai_kind: "claude" })).body;
    device[name] = (await anon("pair_connection", { code, device_label: "share" })).body.token;
  }
  sql(`update public.jobs set status = 'skipped' where table_id = '${table}' and kind = 'intro'`);
  const chat = (await rest(tokens.Maya, `chats?select=id&table_id=eq.${table}`)).body[0].id;
  const pulse = setInterval(() => { for (const d of Object.values(device)) anon("runner_hello", { token: d }); }, 8000);
  const take = async (name, lane) => { for (let i = 0; i < 40; i++) { const j = (await anon("runner_claim", { token: device[name], lane })).body; if (j) return j; await sleep(500); } return null; };
  const fin = (name, job, answer, info) => anon("runner_finish", { token: device[name], job: job.job_id, answer, info });

  // Her commands, by name.
  const told = await anon("runner_commands", { token: device.Maya, list: [{ name: "ship-it", about: "Ship with the key sk-ant-REDACTME1234567890abcdef", kind: "command" }, { name: "bad name!", about: "x" }, { name: "plan", about: "Plan the work", kind: "skill" }] });
  const kept = (await rest(tokens.Sam, `connections?select=commands,member_id&table_id=eq.${table}&revoked_at=is.null`)).body;
  const hers = kept.find((c) => c.commands.length)?.commands ?? [];
  check("a connection's commands are kept by name, bad names dropped", told.body === 2 && hers.length === 2 && hers.some((c) => c.name === "ship-it") && hers.some((c) => c.kind === "skill"), hers);
  check("nothing shaped like a key is kept in what a command is for", !JSON.stringify(hers).includes("REDACTME"), hers);

  // Maya asks for work, pointing at a file on her own computer.
  await rpc(tokens.Maya, "ask_table", { c: chat, body: 'Build the importer from the spec at "C:\\Users\\maya\\specs\\importer.md"' });
  const view = await take("Sam", "light");
  check("the other AI is told nothing is its own to open", view?.own_paths === false && view.share_paths === false && Array.isArray(view.materials) && view.materials.length === 0, view && { own: view.own_paths, m: view.materials });
  // Sam's connection cannot share into Maya's request, whatever it sends.
  const wrong = await anon("runner_share", { token: device.Sam, job: view.job_id, files: [{ name: "C:\\x.md", body: "planted" }] });
  check("only the asker's own connection can share for a request", wrong.body === 0, wrong);
  await fin("Sam", view, "view", {});
  const plan = await take("Maya", "light");
  check("the asker's own AI may open what she points at, and share it", plan?.own_paths === true && plan.share_paths === true, plan && { own: plan.own_paths, share: plan.share_paths });
  const shared = await anon("runner_share", { token: device.Maya, job: plan.job_id, files: [
    { name: "C:\\Users\\maya\\specs\\importer.md", body: "The importer reads CSV. The staging password is sk-ant-SECRETSECRET1234567890abcd, do not lose it." },
    { name: "", body: "no name" }, { name: "too-big.txt", body: "x".repeat(130000) }] });
  check("what she pointed at is kept for the others: named, small, text", shared.body === 1, shared);
  check("nobody at the table reads the shared files directly", [tokens.Maya, tokens.Sam, tokens.Elena].every(async (t) => ((await rest(t, "round_materials?select=id")).body.length ?? 0) === 0)
    && ((await rest(tokens.Sam, "round_materials?select=id")).body.length ?? 0) === 0 && ((await rest(tokens.Elena, "round_materials?select=id")).body.length ?? 0) === 0);
  await fin("Maya", plan, "plan", { mine: "x", handoffs: [] });
  const work = await take("Maya", "heavy");
  check("her own AI is not handed her own file back", work?.kind === "work" && work.materials.length === 0, work && work.materials);
  await fin("Maya", work, "done", { changed: true, read: `changed 1 file on ${work.branch} @ a1b2c3d` });
  const review = await take("Sam", "light");
  const m = review?.materials?.[0];
  check("the AI that looks the work over is handed the file, said to be from her computer", review?.kind === "review" && review.materials.length === 1 && m.from === "Maya" && /importer\.md$/.test(m.name) && /reads CSV/.test(m.body), review && review.materials);
  check("with anything shaped like a secret hidden", !!m && !m.body.includes("SECRETSECRET"), m?.body);
  await fin("Sam", review, "ok", { ok: true });
  const combine = await take("Maya", "light");
  await fin("Maya", combine, "It is done.", { read: combine?.work_read });

  // With the switch off nothing is shared, and with opening off nothing is hers to open.
  const conn = sql(`select id from public.connections where token_hash is not null and member_id = (select id from public.members where table_id = '${table}' and role = 'owner') and revoked_at is null`);
  check("someone else cannot flip her switches", (await rpc(tokens.Sam, "set_connection_options", { conn, open: false, share: false })).status >= 400);
  await rpc(tokens.Maya, "set_connection_options", { conn, open: null, share: false });
  await rpc(tokens.Maya, "ask_table", { c: chat, body: 'And the exporter, from "C:\\Users\\maya\\specs\\exporter.md"' });
  await fin("Sam", await take("Sam", "light"), "view", {});
  const plan2 = await take("Maya", "light");
  const no = await anon("runner_share", { token: device.Maya, job: plan2.job_id, files: [{ name: "C:\\Users\\maya\\specs\\exporter.md", body: "The exporter." }] });
  check("with sharing off she may still open it, and nothing is shared", plan2.own_paths === true && plan2.share_paths === false && no.body === 0, { own: plan2.own_paths, share: plan2.share_paths, no: no.body });
  await rpc(tokens.Maya, "set_connection_options", { conn, open: false, share: null });
  await fin("Maya", plan2, "plan", { mine: "x", handoffs: [] });
  const work2 = await take("Maya", "heavy");
  check("with opening off nothing on her computer is hers to open from the table", work2?.own_paths === false && work2.share_paths === false, work2 && { own: work2.own_paths });
  clearInterval(pulse);
} catch (e) {
  check("the run did not crash", false, e.stack || String(e));
} finally {
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
process.exit(Object.values(results).some((v) => v !== "pass") ? 1 : 0);
