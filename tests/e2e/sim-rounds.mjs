// Every way a round can go, played straight against the database with no AI at all: this file is the connections.
// It pairs fake connections, takes their jobs through the same functions a real connection calls, and answers with
// whatever each scenario needs. Fast, repeatable, and it can do what a real AI will not do on demand: fail, go
// quiet, lie about whose job it is, or hand work to someone who is not there.
//
//   node --experimental-websocket tests/e2e/sim-rounds.mjs

import { execFileSync } from "node:child_process";
import { accessToken, API, inviteLink, join as joinTable, KEY, launch, rest, rpc, sleep, startTable } from "./lib.mjs";

const run = Date.now().toString(36);
const results = { checks: {} };
const check = (name, ok, detail) => {
  results.checks[name] = ok ? "pass" : `FAIL ${typeof detail === "string" ? detail : JSON.stringify(detail ?? "")}`.trim().slice(0, 700);
  if (!ok) console.error("FAIL", name, typeof detail === "string" ? detail.slice(0, 300) : JSON.stringify(detail ?? "").slice(0, 300));
};
const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();

// A connection's calls: the publishable key and its device token, nothing else.
async function anon(fn, args) {
  const res = await fetch(`${API}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

const browser = await launch();
let table;
const people = {};
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Sim table", "Maya");
  table = owner.tableId;
  people.Maya = { ...owner, role: "owner" };
  people.Sam = { ...(await joinTable(browser, await inviteLink(owner.page, "developer"), `sam-${run}@example.test`, "Sam")), role: "developer" };
  people.Lee = { ...(await joinTable(browser, await inviteLink(owner.page, "developer"), `lee-${run}@example.test`, "Lee")), role: "developer" };
  people.Dana = { ...(await joinTable(browser, await inviteLink(owner.page, "client"), `dana-${run}@example.test`, "Dana")), role: "client" };
  for (const p of Object.values(people)) p.token = await accessToken(p.context);
  const members = (await rest(people.Maya.token, `members?select=id,display_name&table_id=eq.${table}`)).body;
  for (const m of members) if (people[m.display_name]) people[m.display_name].id = m.id;
  const nameOf = (id) => members.find((m) => m.id === id)?.display_name ?? id;

  // ---- helpers
  async function pair(name, kind = "claude") {
    const code = (await rpc(people[name].token, "start_pairing", { t: table, ai_kind: kind })).body;
    const paired = (await anon("pair_connection", { code, device_label: "sim" })).body;
    people[name].device = paired.token;
    // The introduction is not what this file is about.
    sql(`update public.jobs set status = 'skipped' where table_id = '${table}' and kind = 'intro' and status in ('queued','running')`);
    return paired.token;
  }
  const unpair = (name) => { awake.delete(name); sql(`update public.connections set revoked_at = now() where member_id = '${people[name].id}' and revoked_at is null`); people[name].device = null; };
  // A real connection asks for work every two seconds, which is what keeps it "on". These stay on the same way
  // until a scenario takes one off.
  const awake = new Set();
  const pulse = globalThis.simPulse = setInterval(() => { for (const n of awake) if (people[n].device) anon("runner_hello", { token: people[n].device }).catch(() => {}); }, 8000);
  const online = async (...names) => { for (const n of names) { awake.add(n); await anon("runner_hello", { token: people[n].device }); } };
  const offline = (...names) => { for (const n of names) { awake.delete(n); sql(`update public.connections set last_seen = now() - interval '10 minutes' where member_id = '${people[n].id}' and revoked_at is null`); } };
  const claim = async (name, lane) => (await anon("runner_claim", { token: people[name].device, lane })).body;
  const finish = (name, job, answer, info = {}) => { if (!job) throw new Error(`no job for ${name} to finish: "${answer}"`); return fin(name, job, answer, info); };
  const fin = (name, job, answer, info = {}) => anon("runner_finish", { token: people[name].device, job: job.job_id, answer, info });
  const jobsOf = (where = "") => JSON.parse(sql(`select coalesce(json_agg(x order by x.created_at, x.id), '[]') from (select id, kind, status, stage, member_id, round, task_id, brief, error, outcome, chat_id, created_at from public.jobs where table_id = '${table}' and kind <> 'intro' ${where}) x`));
  const tasksOf = (where = "") => JSON.parse(sql(`select coalesce(json_agg(x order by x.created_at), '[]') from (select id, title, branch, status, chat_id, member_id, created_at from public.tasks where table_id = '${table}' ${where}) x`));
  const show = (js) => js.map((j) => `${j.kind}${j.stage ? j.stage : ""}:${nameOf(j.member_id)}:${j.status}`);
  let chatNo = 0;
  async function newChat() {
    const r = await rpc(people.Maya.token, "create_chat", { t: table, chat_name: `c${++chatNo}-${run}` });
    return r.body;
  }
  const say = (name, chat, body) => rest(people[name].token, "messages", { method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ table_id: table, chat_id: chat, member_id: people[name].id, body }) });
  const ask = (name, chat, body) => rpc(people[name].token, "ask_table", { c: chat, body });
  async function until(fn, ms = 20000, every = 500) {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) return null;
      await sleep(every);
    }
  }
  // Take the next job for this person, waiting for the database's own clock to hand it out.
  const take = (name, lane, ms = 20000) => until(() => claim(name, lane), ms);
  const inChat = (chat) => jobsOf(`and chat_id = '${chat}'`);
  const settled = (chat, ms = 25000) => until(async () => { const js = inChat(chat); return js.length && js.every((j) => !["queued", "running", "waiting"].includes(j.status)) ? js : null; }, ms);
  const cleanSlate = () => sql(`update public.jobs set status = 'skipped', error = 'sim cleanup' where table_id = '${table}' and status in ('queued','running','waiting'); delete from public.listens where table_id = '${table}'`);

  // ================= 1. One AI at the table
  await pair("Maya");
  {
    const chat = await newChat();
    await say("Sam", chat, "lol");
    await say("Maya", chat, "k");
    await say("Sam", chat, "brb food");
    await sleep(9000);
    check("1a small talk asks no model", inChat(chat).length === 0, show(inChat(chat)));
    check("1a the heard row is gone, not left behind", sql(`select count(*) from public.listens where chat_id = '${chat}'`) === "0");

    await say("Sam", chat, "yes");
    await sleep(8000);
    check("1b a bare yes with no AI before it asks no model", inChat(chat).length === 0, show(inChat(chat)));

    await say("Dana", chat, "can you add a dark mode please?");
    await sleep(8000);
    check("1c a client's words in a team chat never start the AIs", inChat(chat).length === 0, show(inChat(chat)));

    await online("Maya");
    await say("Sam", chat, "can someone fix the login redirect?");
    await say("Sam", chat, "it breaks after the code email");
    let j = await take("Maya", "light");
    check("1d two quick messages are one listen, about the newest", j?.kind === "listen" && /code email/.test(j.question) && j.history.some((m) => /login redirect/.test(m.body)), j);
    check("1d the listener is handed the whole chat", j?.history?.length >= 5, j?.history?.length);
    await finish("Maya", j, "", { act: "silent" });
    await sleep(3000);
    check("1d silent leaves nothing in the chat", sql(`select count(*) from public.messages where chat_id = '${chat}' and by_ai`) === "0");

    await say("Sam", chat, "hello table, are you there?");
    j = await take("Maya", "light");
    await finish("Maya", j, "I am here.", { act: "reply", model: "haiku" });
    check("1e reply posts the listener's own words", sql(`select body from public.messages where chat_id = '${chat}' and by_ai`) === "I am here.");

    await say("Sam", chat, "yes");
    j = await take("Maya", "light", 12000);
    check("1f a bare yes right after an AI spoke is heard", j?.kind === "listen", j);
    await finish("Maya", j, "", { act: "look" });
    j = await take("Maya", "light");
    check("1g look makes one read-only job on the light lane", j?.kind === "look" && !j.branch, j);
    check("1g and long work's lane does not see it", (await claim("Maya", "heavy")) === null);
    await finish("Maya", j, "The redirect is in auth.ts.", { read: "main @ abc1234", sources: ["auth.ts"] });
    check("1g a look makes no task", tasksOf(`and chat_id = '${chat}'`).length === 0);

    await say("Sam", chat, "please fix that redirect");
    j = await take("Maya", "light");
    await finish("Maya", j, "", { act: "work", title: "Fix the login redirect" });
    const t = tasksOf(`and chat_id = '${chat}'`);
    check("1h work from the listener opens a task with a safe branch", t.length === 1 && t[0].title === "Fix the login redirect" && /^longtable\/fix-the-login-redirect-[0-9a-f]{8}$/.test(t[0].branch) && t[0].member_id === people.Sam.id, t);
    check("1h the quick lane cannot take the work", (await claim("Maya", "light")) === null);
    j = await take("Maya", "heavy");
    check("1h the lone AI's job carries the task's branch", j?.kind === "answer" && j.branch === t[0].branch && j.task_title === "Fix the login redirect", j);
    const beat = await anon("runner_beat", { token: people.Maya.device, job: j.job_id, note: "editing auth.ts" });
    check("1h a heartbeat is taken and shown", beat.body === true && sql(`select progress from public.jobs where id = '${j.job_id}'`) === "editing auth.ts", beat);
    await finish("Maya", j, "Fixed.", { changed: true, read: `changed 1 file on ${t[0].branch} @ abc1234` });
    check("1h finishing closes the task", tasksOf(`and chat_id = '${chat}'`)[0].status === "done");

    // A follow-up goes back to its task.
    await say("Sam", chat, "can you also handle the logout redirect the same way?");
    j = await take("Maya", "light");
    check("1i the listener is shown the work taken on lately", (j.tasks || []).some((x) => x.id === t[0].id), j.tasks);
    await finish("Maya", j, "", { act: "work", task: t[0].id, title: "ignored" });
    j = await take("Maya", "heavy");
    check("1i a follow-up reopens its task and keeps its branch", j?.branch === t[0].branch && tasksOf(`and chat_id = '${chat}'`).length === 1 && tasksOf(`and chat_id = '${chat}'`)[0].status === "working", j?.branch);
    await finish("Maya", j, "Done too.", { changed: false });
    check("1i and closes it again", tasksOf(`and chat_id = '${chat}'`)[0].status === "done");

    // A listener that fails is not retried.
    await say("Sam", chat, "what is the plan for tomorrow?");
    j = await take("Maya", "light");
    await anon("runner_finish", { token: people.Maya.device, job: j.job_id, answer: "", info: { act: "nonsense" } });
    await sleep(3000);
    check("1j an unknown act does nothing", inChat(chat).filter((x) => ["queued", "running", "waiting"].includes(x.status)).length === 0, show(inChat(chat)));
  }

  // ================= 1k. Two people writing in the same instant
  {
    cleanSlate();
    const chat = await newChat();
    await online("Maya");
    // The second to land carries the earlier time, as happens when two sends cross.
    sql(`insert into public.messages (table_id, chat_id, member_id, body, created_at) values ('${table}', '${chat}', '${people.Lee.id}', 'please add the colours page', now());
         insert into public.messages (table_id, chat_id, member_id, body, created_at) values ('${table}', '${chat}', '${people.Sam.id}', 'please add the animals page', now() - interval '900 milliseconds')`);
    const a = await take("Maya", "light");
    const b = await take("Maya", "light", 6000);
    const askers = [a?.asker, b?.asker].sort().join();
    check("1k two people asking in the same instant are heard as two requests, whichever landed first", a?.kind === "listen" && b?.kind === "listen" && askers === "Lee,Sam", { a: a?.asker, b: b?.asker });
    if (a) await finish("Maya", a, "", { act: "silent" });
    if (b) await finish("Maya", b, "", { act: "silent" });

    // Something said right after an AI spoke is heard even when it does not look like a request.
    await say("Sam", chat, "hey table?");
    const l = await take("Maya", "light");
    await finish("Maya", l, "Yes?", { act: "reply" });
    await say("Sam", chat, "for the colours page: teal too");
    const f = await take("Maya", "light", 12000);
    check("1l words that follow an AI are heard whatever their shape", f?.kind === "listen" && /teal/.test(f.question), f?.kind);
    if (f) await finish("Maya", f, "", { act: "silent" });
    await say("Sam", chat, "nice one");
    await sleep(8000);
    check("1l but small talk between people later is still free", inChat(chat).filter((j) => j.kind === "listen").length === 4, show(inChat(chat)));
  }

  // ================= 2. Two Claudes: the full round
  await pair("Sam");
  {
    const chat = await newChat();
    await online("Maya", "Sam");
    const r = (await ask("Sam", chat, "Add rate limiting to the API")).body;
    check("2a asking outright skips the listener", inChat(chat).every((j) => j.kind !== "listen") && !!r.task, r);
    check("2a the asker's Claude leads, the other gives a view", show(inChat(chat)).sort().join() === "plan:Sam:waiting,view:Maya:queued", show(inChat(chat)));
    check("2a nothing can be taken before the view is in", (await claim("Sam", "light")) === null && (await claim("Sam", "heavy")) === null);
    let v = await take("Maya", "light");
    await finish("Maya", v, "Watch the login route.", { confidence: "high" });
    let p = await take("Sam", "light");
    check("2b the plan comes after the view, with the view and the team in it", p?.kind === "plan" && p.views.length === 1 && JSON.stringify(p.team) === '["Maya"]', p);
    await finish("Sam", p, "I will do all of it.", { mine: "all of it", handoffs: [] });
    let w = await take("Sam", "heavy");
    check("2c no handoff: one piece of work for the lead, with no brief", w?.kind === "work" && !w.brief && show(inChat(chat)).filter((x) => x.startsWith("work")).length === 1, show(inChat(chat)));
    await finish("Sam", w, "Added a limiter.", { changed: true, read: `changed 2 files on ${w.branch} @ aaa1111` });
    let rv = await take("Maya", "light");
    check("2d the other one looks it over, and knows where the work is", rv?.kind === "review" && /changed 2 files/.test(rv.work_read ?? "") && (await claim("Sam", "light")) === null, rv);
    await finish("Maya", rv, "Looks right.", { ok: true });
    let c = await take("Maya", "light");
    check("2e then the table's seat reports, once", c?.kind === "combine" && c.worker === "Sam" && c.views.length >= 4, { kind: c?.kind, views: c?.views?.length });
    await finish("Maya", c, "Sam's Claude added rate limiting.", { read: c.work_read, how: "One did it, one checked." });
    const js = await settled(chat);
    check("2e the round ends: every job done, the task done", js.every((j) => j.status === "done") && tasksOf(`and chat_id = '${chat}'`)[0].status === "done", show(js));
    await sleep(5000);
    check("2e and stays ended", inChat(chat).length === js.length);
    check("2e the back room is not in the chat", sql(`select count(*) from public.messages where chat_id = '${chat}' and kind = 'answer'`) === "1"
      && sql(`select count(*) from public.messages where chat_id = '${chat}' and kind = 'view'`) === "4");
  }

  // ================= 3. Reviews that keep finding problems: the guard
  {
    const chat = await newChat();
    await online("Maya", "Sam");
    await ask("Maya", chat, "Rewrite the importer");
    await finish("Sam", await take("Sam", "light"), "ok", { confidence: "low" });
    await finish("Maya", await take("Maya", "light"), "mine", { mine: "x", handoffs: [] });
    for (let go = 0; go < 3; go++) {
      const w = await take("Maya", "heavy");
      check(`3 go ${go + 1} is the lead's, at stage ${go}`, w?.kind === "work" && w.stage === go, w && { kind: w.kind, stage: w.stage });
      await finish("Maya", w, `go ${go + 1}`, { changed: true, read: "changed 1 file on b @ c" });
      if (go < 2) await finish("Sam", await take("Sam", "light"), "Still broken.", { ok: false });
    }
    const c = await take("Maya", "light");
    check("3 after three goes it reports, with no fourth go and no third review", c?.kind === "combine"
      && show(inChat(chat)).filter((x) => x.startsWith("work")).length === 3 && show(inChat(chat)).filter((x) => x.startsWith("review")).length === 2, show(inChat(chat)));
    await finish("Maya", c, "Reported.", {});
  }

  // ================= 4. Handing parts over
  await pair("Lee");
  {
    const chat = await newChat();
    await online("Maya", "Sam", "Lee");
    offline("Lee");
    await ask("Maya", chat, "Ship the settings page");
    await finish("Sam", await take("Sam", "light"), "fine", {});
    check("4 an AI whose computer is closed is not asked for a view", inChat(chat).filter((j) => j.kind === "view").length === 1, show(inChat(chat)));
    const p = await take("Maya", "light");
    await finish("Maya", p, "split", { mine: "the form", handoffs: [
      { to: "sam", what: "the API route" }, { to: "Sam", what: "and its tests" },
      { to: "Lee", what: "the docs" }, { to: "Dana", what: "the copy" }, { to: "Nobody", what: "the icons" },
      { to: "Maya", what: "the layout" }, { to: "%", what: "wildcard" }, { to: "", what: "nameless" }, { to: "Sam", what: "   " },
    ] });
    const works = inChat(chat).filter((j) => j.kind === "work");
    const mine = works.find((j) => j.member_id === people.Maya.id);
    const sams = works.find((j) => j.member_id === people.Sam.id);
    check("4a parts go only to team Claudes that are on: the lead and Sam", works.length === 2 && !!mine && !!sams, show(works));
    check("4a Sam's two parts are one job", /the API route/.test(sams?.brief ?? "") && /and its tests/.test(sams?.brief ?? ""), sams?.brief);
    check("4a what was for an absent person, a client, nobody, or the lead stays with the lead", ["the form", "the docs", "the copy", "the icons", "the layout", "wildcard", "nameless"].every((x) => (mine?.brief ?? "").includes(x)), mine?.brief);
    const a = await take("Maya", "heavy");
    const b = await take("Sam", "heavy");
    check("4b both parts can be taken at the same time", a?.kind === "work" && b?.kind === "work" && a.branch === b.branch, { a: a?.kind, b: b?.kind });
    await finish("Sam", b, "API done.", { changed: true, read: `changed 1 file on ${b.branch} @ b1` });
    check("4b nobody looks it over until every part is in", inChat(chat).filter((j) => j.kind === "review").length === 0);
    await finish("Maya", a, "Form done.", { changed: false });
    const rs = await until(() => { const x = inChat(chat).filter((j) => j.kind === "review"); return x.length ? x : null; });
    check("4c with two workers, everyone who is on looks over the whole of it", rs?.length === 2 && rs.every((j) => [people.Maya.id, people.Sam.id].includes(j.member_id)), show(rs ?? []));
    await finish("Maya", await take("Maya", "light"), "ok", { ok: true });
    await finish("Sam", await take("Sam", "light"), "ok", { ok: true });
    const c = await take("Maya", "light");
    await finish("Maya", c, "Both parts are in.", {});
    check("4c and it ends", (await settled(chat)).every((j) => ["done", "skipped"].includes(j.status)), show(inChat(chat)));
  }

  // ================= 5. People who are not there
  {
    // The view never comes.
    let chat = await newChat();
    await online("Maya", "Sam", "Lee");
    await ask("Maya", chat, "Tidy the logs");
    offline("Lee");
    await finish("Sam", await take("Sam", "light"), "v", {});
    check("5a an absent AI's view holds the plan back at first", (await claim("Maya", "light")) === null);
    sql(`update public.jobs set created_at = now() - interval '2 minutes' where chat_id = '${chat}' and status = 'waiting'`);
    const p = await take("Maya", "light");
    check("5a after ninety seconds the plan starts without it", p?.kind === "plan" && inChat(chat).some((j) => j.kind === "view" && j.status === "skipped"), show(inChat(chat)));
    await finish("Maya", p, "all mine", { mine: "x", handoffs: [] });

    // The worker's computer never picks the work up.
    sql(`update public.jobs set created_at = now() - interval '11 minutes' where chat_id = '${chat}' and kind = 'work'`);
    const c = await take("Maya", "light");
    check("5b work nobody picks up for ten minutes is given up on, and the table says so", c?.kind === "combine" && inChat(chat).find((j) => j.kind === "work").status === "skipped", show(inChat(chat)));
    await finish("Maya", c, "Nothing was done.", {});

    // The worker goes quiet in the middle.
    cleanSlate();
    chat = await newChat();
    await online("Maya", "Sam");
    await ask("Sam", chat, "Long thing");
    await finish("Maya", await take("Maya", "light"), "v", {});
    await finish("Sam", await take("Sam", "light"), "p", { mine: "x", handoffs: [] });
    const w = await take("Sam", "heavy");
    sql(`update public.jobs set started_at = now() - interval '9 hours' where id = '${w.job_id}'`);
    await anon("runner_beat", { token: people.Sam.device, job: w.job_id, note: "still going" });
    await sleep(5000);
    check("5c nine hours of work with a heartbeat is still working", inChat(chat).find((j) => j.kind === "work").status === "running", show(inChat(chat)));
    sql(`update public.jobs set lease_until = now() - interval '11 minutes' where id = '${w.job_id}'`);
    const c2 = await take("Maya", "light");
    check("5c work that stops saying it is alive is given up on", c2?.kind === "combine" && inChat(chat).find((j) => j.kind === "work").status === "skipped", show(inChat(chat)));
    const late = await finish("Sam", w, "late", { changed: true });
    check("5c and its late answer is refused", !late.ok, late);
    await finish("Maya", c2, "It stopped.", {});

    // A reviewer who never answers.
    cleanSlate();
    chat = await newChat();
    await online("Maya", "Sam");
    await ask("Sam", chat, "Review timeout");
    await finish("Maya", await take("Maya", "light"), "v", {});
    await finish("Sam", await take("Sam", "light"), "p", { mine: "x", handoffs: [] });
    await finish("Sam", await take("Sam", "heavy"), "did", { changed: true, read: "changed 1 file on b @ c" });
    await until(() => inChat(chat).some((j) => j.kind === "review"));
    sql(`update public.jobs set created_at = now() - interval '3 minutes' where chat_id = '${chat}' and kind = 'review'`);
    await until(() => inChat(chat).some((j) => j.kind === "combine"));
    const c3 = await take("Maya", "light");
    check("5d a look-over nobody gives is skipped after two minutes", c3?.kind === "combine" && inChat(chat).find((j) => j.kind === "review").status === "skipped", show(inChat(chat)));
    await finish("Maya", c3, "Unreviewed.", {});
  }

  // ================= 6. Stop, at every point
  {
    const stopAt = async (label, advance) => {
      cleanSlate();
      const chat = await newChat();
      await online("Maya", "Sam");
      await ask("Sam", chat, `Stop me at ${label}`);
      const running = await advance(chat);
      const target = inChat(chat).find((j) => ["queued", "running", "waiting"].includes(j.status));
      const r = await rpc(people.Maya.token, "stop_job", { job: target.id });
      await sleep(5000);
      const js = inChat(chat);
      check(`6 stop during ${label}: nothing is left running and nothing new starts`, r.status < 300 && js.every((j) => ["done", "skipped"].includes(j.status)) && js.filter((j) => j.kind === "combine").every((j) => j.status === "skipped"), show(js));
      check(`6 stop during ${label}: the task says stopped`, tasksOf(`and chat_id = '${chat}'`)[0]?.status === "stopped", tasksOf(`and chat_id = '${chat}'`));
      if (running) {
        const b = await anon("runner_beat", { token: people[running.who].device, job: running.job.job_id, note: "x" });
        const f = await finish(running.who, running.job, "too late", { changed: true });
        check(`6 stop during ${label}: the connection is told to stop and cannot finish`, b.body === false && !f.ok, { b: b.body, f: f.status });
      }
    };
    await stopAt("the views", async () => null);
    await stopAt("the plan", async () => { await finish("Maya", await take("Maya", "light"), "v", {}); return { who: "Sam", job: await take("Sam", "light") }; });
    await stopAt("the work", async () => {
      await finish("Maya", await take("Maya", "light"), "v", {});
      await finish("Sam", await take("Sam", "light"), "p", { mine: "x", handoffs: [] });
      return { who: "Sam", job: await take("Sam", "heavy") };
    });
    await stopAt("the look-over", async (chat) => {
      await finish("Maya", await take("Maya", "light"), "v", {});
      await finish("Sam", await take("Sam", "light"), "p", { mine: "x", handoffs: [] });
      await finish("Sam", await take("Sam", "heavy"), "did", { changed: true, read: "changed 1 file on b @ c" });
      await until(() => inChat(chat).some((j) => j.kind === "review"));
      return { who: "Maya", job: await take("Maya", "light") };
    });
  }

  // ================= 7. Two people asking at once, and talking while it runs
  {
    cleanSlate();
    const chat = await newChat();
    await online("Maya", "Sam");
    offline("Lee");
    await ask("Maya", chat, "Task one from Maya");
    await ask("Sam", chat, "Task two from Sam");
    const ts = tasksOf(`and chat_id = '${chat}'`);
    check("7a two asks are two tasks on two branches", ts.length === 2 && ts[0].branch !== ts[1].branch, ts);
    // Each AI owes the other a view; each leads its own.
    await finish("Sam", await take("Sam", "light"), "v1", {});
    await finish("Maya", await take("Maya", "light"), "v2", {});
    const pm = await take("Maya", "light");
    const ps = await take("Sam", "light");
    check("7a each leads its own task", pm?.kind === "plan" && ps?.kind === "plan" && pm.branch !== ps.branch && pm.task_title !== ps.task_title, { pm: pm?.task_title, ps: ps?.task_title });
    await finish("Maya", pm, "p", { mine: "x", handoffs: [] });
    await finish("Sam", ps, "p", { mine: "y", handoffs: [] });
    const wm = await take("Maya", "heavy");
    const ws = await take("Sam", "heavy");
    check("7b both work at the same time, each on its own branch", wm?.kind === "work" && ws?.kind === "work" && wm.branch !== ws.branch, { wm: wm?.branch, ws: ws?.branch });

    // While they work, people keep talking, and the listener still hears.
    await say("Lee", chat, "by the way, what does the importer do with empty rows?");
    const l = await take("Maya", "light");
    check("7c the table still hears people while long work runs", l?.kind === "listen" && (l.tasks || []).filter((t) => t.status === "working").length >= 2, { kind: l?.kind, tasks: l?.tasks?.length });
    await finish("Maya", l, "", { act: "silent" });

    await finish("Maya", wm, "one done", { changed: true, read: `changed 1 file on ${wm.branch} @ m1` });
    await finish("Sam", ws, "two done", { changed: true, read: `changed 1 file on ${ws.branch} @ s1` });
    const r1 = await take("Sam", "light");
    const r2 = await take("Maya", "light");
    check("7d each looks over the other's task, not its own", r1?.kind === "review" && r2?.kind === "review" && r1.branch === wm.branch && r2.branch === ws.branch, { r1: r1?.branch, r2: r2?.branch });
    await finish("Sam", r1, "ok", { ok: true });
    await finish("Maya", r2, "ok", { ok: true });
    for (let i = 0; i < 2; i++) { const c = await take("Maya", "light"); await finish("Maya", c, `report ${i}`, { read: c.work_read }); }
    const done = tasksOf(`and chat_id = '${chat}'`);
    check("7e both tasks finish, separately", done.every((t) => t.status === "done") && (await settled(chat)).every((j) => ["done", "skipped"].includes(j.status)), done);

    // One person's AI gets a second long job while busy: it waits its turn, and is not given up on.
    const chat2 = await newChat();
    await ask("Sam", chat2, "First long job");
    await finish("Maya", await take("Maya", "light"), "v", {});
    await finish("Sam", await take("Sam", "light"), "p", { mine: "x", handoffs: [] });
    const first = await take("Sam", "heavy");
    const chat3 = await newChat();
    await ask("Sam", chat3, "Second long job");
    await finish("Maya", await take("Maya", "light"), "v", {});
    await finish("Sam", await take("Sam", "light"), "p", { mine: "x", handoffs: [] });
    sql(`update public.jobs set created_at = now() - interval '3 hours' where chat_id = '${chat3}' and kind = 'work'`);
    await sleep(5000);
    check("7f work waiting behind the same AI's long job is not given up on", inChat(chat3).find((j) => j.kind === "work").status === "queued", show(inChat(chat3)));
    await finish("Sam", first, "first done", { changed: false });
    const second = await take("Sam", "heavy");
    check("7f and it starts when the first is done", second?.kind === "work" && second.question === "Second long job", second?.question);
    await finish("Sam", second, "second done", { changed: false });
    for (let i = 0; i < 2; i++) { const c = await take("Maya", "light"); if (c) await finish("Maya", c, "r", {}); }
  }

  // ================= 8. The wall, and tokens used wrongly
  {
    cleanSlate();
    const chat = await newChat();
    await online("Maya", "Sam");
    const asked = (await ask("Sam", chat, "Wall check")).body;
    const dana = people.Dana.token;
    const read = async (path) => (await rest(dana, path)).body;
    check("8a a client reads no tasks, jobs, or heard rows", [await read(`tasks?select=id&table_id=eq.${table}`), await read(`jobs?select=id&table_id=eq.${table}&kind=neq.client`)].every((b) => Array.isArray(b) && b.length === 0)
      && !Array.isArray(await read("listens?select=chat_id")), [await read(`tasks?select=id`), await read("listens?select=chat_id")]);
    const target = inChat(chat)[0];
    const tries = {
      stop: await rpc(dana, "stop_job", { job: target.id }),
      clear: await rpc(dana, "clear_tasks", { t: table }),
      ask: await rpc(dana, "ask_table", { c: chat, body: "do it" }),
      start: await rpc(dana, "start_round", { t: table, c: chat, q: asked.message_id, me: people.Dana.id }),
      advance: await rpc(dana, "advance_round", { r: target.round }),
      listen: await rpc(dana, "listen_now", {}),
      final: await rpc(dana, "final_seat_now", { t: table }),
      insert: await rest(dana, "tasks", { method: "POST", body: JSON.stringify({ table_id: table, chat_id: chat, title: "x", branch: "main" }) }),
    };
    check("8b a client can stop, clear, ask, start or steer nothing", Object.values(tries).every((r) => r.status >= 400), Object.fromEntries(Object.entries(tries).map(([k, v]) => [k, v.status])));
    const jobsBefore = show(inChat(chat)).join();
    const team = {
      start: await rpc(people.Sam.token, "start_round", { t: table, c: chat, q: asked.message_id, me: people.Sam.id }),
      advance: await rpc(people.Sam.token, "advance_round", { r: target.round }),
      close: await rpc(people.Sam.token, "close_failed_tasks", {}),
      insert: await rest(people.Sam.token, "tasks", { method: "POST", body: JSON.stringify({ table_id: table, chat_id: chat, title: "x", branch: "main" }) }),
      update: await rest(people.Sam.token, `tasks?table_id=eq.${table}`, { method: "PATCH", body: JSON.stringify({ branch: "main" }) }),
      jobs: await rest(people.Sam.token, `jobs?table_id=eq.${table}`, { method: "PATCH", body: JSON.stringify({ status: "done" }) }),
    };
    check("8c the team cannot call the inner workings or write tasks and jobs by hand", Object.values(team).every((r) => r.status >= 400) && show(inChat(chat)).join() === jobsBefore
      && sql(`select count(*) from public.tasks where table_id = '${table}' and branch = 'main'`) === "0", Object.fromEntries(Object.entries(team).map(([k, v]) => [k, v.status])));
    const none = {
      claim: await anon("runner_claim", { token: "x".repeat(64) }),
      beat: await anon("runner_beat", { token: "nope", job: target.id }),
      tasks: await fetch(`${API}/rest/v1/tasks?select=id`, { headers: { apikey: KEY } }).then(async (r) => ({ status: r.status, body: await r.json() })),
      stop: await anon("stop_job", { job: target.id }),
      clear: await anon("clear_tasks", { t: table }),
      ask: await anon("ask_table", { c: chat, body: "x" }),
    };
    check("8d with no sign-in and no real device token, nothing answers", none.claim.status >= 400 && none.beat.status >= 400 && none.stop.status >= 400 && none.clear.status >= 400 && none.ask.status >= 400
      && (none.tasks.status >= 400 || none.tasks.body.length === 0), Object.fromEntries(Object.entries(none).map(([k, v]) => [k, v.status])));

    // One person's connection reaching for another's job.
    const v = await take("Maya", "light");
    const wrong = {
      finish: await anon("runner_finish", { token: people.Sam.device, job: v.job_id, answer: "mine now", info: {} }),
      fail: await anon("runner_fail", { token: people.Sam.device, job: v.job_id, reason: "x" }),
      beat: await anon("runner_beat", { token: people.Sam.device, job: v.job_id, note: "x" }),
    };
    check("8e one person's connection cannot finish, fail or keep alive another's job", !wrong.finish.ok && !wrong.fail.ok && wrong.beat.body === false, { finish: wrong.finish.status, fail: wrong.fail.status, beat: wrong.beat.body });
    await finish("Maya", v, "v", { parts: [{ member: people.Lee.id, brief: "sneaked in" }], act: "work", task: "not-a-uuid", changed: true });
    const p = await take("Sam", "light");
    // A plan that tries everything.
    const big = "x".repeat(200000);
    const evil = await finish("Sam", p, "plan " + big, {
      mine: big, handoffs: [...Array(300)].map((_, i) => ({ to: "Maya", what: `part ${i} ${"y".repeat(500)}` })).concat([{ to: "Maya'; drop table public.tasks; --", what: "sql" }, { to: null, what: null }, "not an object", 7]),
      parts: [{ member: "00000000-0000-0000-0000-000000000000", brief: "not a member" }], task: asked.task,
    });
    const works = inChat(chat).filter((j) => j.kind === "work");
    check("8f a view cannot plant parts, and a huge or hostile plan stays in bounds", evil.ok && works.length === 2 && works.every((j) => (j.brief ?? "").length <= 4000 * 2 + 10)
      && works.every((j) => [people.Maya.id, people.Sam.id].includes(j.member_id)) && sql("select count(*) from public.tasks") !== "", { ok: evil.ok, status: evil.status, body: JSON.stringify(evil.body).slice(0, 200), works: show(works), lens: works.map((j) => (j.brief ?? "").length) });
    check("8f the stored plan text is cut to size", Number(sql(`select max(char_length(body)) from public.messages where chat_id = '${chat}'`)) <= 8000);
    cleanSlate();

    // Another table's task cannot be continued from here.
    const other = await startTable(browser, `other-${run}@example.test`, "Other table", "Olga");
    const otherToken = await accessToken(other.context);
    const otherChat = (await rest(otherToken, `chats?select=id&table_id=eq.${other.tableId}`)).body[0].id;
    const cross = {
      tasks: (await rest(otherToken, `tasks?select=id&table_id=eq.${table}`)).body,
      stop: await rpc(otherToken, "stop_job", { job: target.id }),
      clear: await rpc(otherToken, "clear_tasks", { t: table }),
      ask: await rpc(otherToken, "ask_table", { c: chat, body: "x" }),
    };
    check("8g someone at another table sees and touches nothing here", cross.tasks.length === 0 && cross.stop.status >= 400 && cross.clear.status >= 400 && cross.ask.status >= 400, { stop: cross.stop.status, clear: cross.clear.status, ask: cross.ask.status });
    const oCode = (await rpc(otherToken, "start_pairing", { t: other.tableId, ai_kind: "claude" })).body;
    const oDev = (await anon("pair_connection", { code: oCode, device_label: "sim" })).body.token;
    sql(`update public.jobs set status = 'skipped' where table_id = '${other.tableId}' and kind = 'intro'`);
    await rest(otherToken, "messages", { method: "POST", body: JSON.stringify({ table_id: other.tableId, chat_id: otherChat, member_id: (await rest(otherToken, `members?select=id&table_id=eq.${other.tableId}`)).body[0].id, body: "please build the thing?" }) });
    const oj = await until(async () => (await anon("runner_claim", { token: oDev, lane: "light" })).body, 15000);
    const mine = tasksOf()[0];
    await anon("runner_finish", { token: oDev, job: oj.job_id, answer: "", info: { act: "work", task: mine.id, title: "Hijack" } });
    const after = JSON.parse(sql(`select coalesce(json_agg(x), '[]') from (select table_id, title, status from public.tasks where id = '${mine.id}' or table_id = '${other.tableId}') x`));
    check("8h a listener at one table cannot reopen or attach to another table's task", after.find((t) => t.table_id === table).status === mine.status && after.filter((t) => t.table_id === other.tableId).length === 1
      && (await anon("runner_claim", { token: oDev, lane: "heavy" })).body?.branch !== mine.branch, after);
    await other.context.close();
  }

  // ================= 9. Leaving in the middle
  {
    cleanSlate();
    // The lead disconnects while its work is running.
    let chat = await newChat();
    await online("Maya", "Sam");
    await ask("Sam", chat, "Leave mid work");
    await finish("Maya", await take("Maya", "light"), "v", {});
    await finish("Sam", await take("Sam", "light"), "p", { mine: "x", handoffs: [] });
    await take("Sam", "heavy");
    const conn = sql(`select id from public.connections where member_id = '${people.Sam.id}' and revoked_at is null`);
    await rpc(people.Sam.token, "disconnect", { conn });
    const c = await take("Maya", "light", 30000);
    check("9a the lead disconnects mid work: the table still reports", c?.kind === "combine", show(inChat(chat)));
    if (c) await finish("Maya", c, "Sam's AI left.", {});
    check("9a and the task closes", (await until(() => tasksOf(`and chat_id = '${chat}'`)[0].status !== "working", 45000)) === true, tasksOf(`and chat_id = '${chat}'`));

    // The only AI disconnects while its lone job waits: the task does not stay open for ever.
    cleanSlate();
    unpair("Lee");
    chat = await newChat();
    await online("Maya");
    const r = (await ask("Maya", chat, "Lone and leaving")).body;
    const lone = inChat(chat);
    const mconn = sql(`select id from public.connections where member_id = '${people.Maya.id}' and revoked_at is null`);
    await rpc(people.Maya.token, "disconnect", { conn: mconn });
    sql(`update public.tasks set created_at = now() - interval '2 minutes' where id = '${r.task}'`);
    check("9b a task whose AIs are all gone is closed, not left working", (await until(() => tasksOf(`and chat_id = '${chat}'`)[0].status !== "working", 45000)) === true, { lone: show(lone), task: tasksOf(`and chat_id = '${chat}'`) });

    // Nobody connected at all: asking and talking make nothing.
    chat = await newChat();
    const quiet = (await ask("Maya", chat, "Anyone?")).body;
    await say("Maya", chat, "can anybody hear this?");
    await sleep(8000);
    check("9c with no AI connected, nothing is queued and no task is opened", quiet.answered_by === null && inChat(chat).length === 0 && tasksOf(`and chat_id = '${chat}'`).length === 0, { quiet, jobs: show(inChat(chat)), tasks: tasksOf(`and chat_id = '${chat}'`) });

    // A person taken off the table mid round.
    await pair("Maya");
    await pair("Sam");
    chat = await newChat();
    await online("Maya", "Sam");
    await ask("Maya", chat, "Removed mid round");
    await rpc(people.Maya.token, "remove_member", { m: people.Sam.id });
    sql(`update public.jobs set created_at = now() - interval '2 minutes' where chat_id = '${chat}' and status = 'waiting'`);
    const p = await take("Maya", "light", 30000);
    check("9d someone taken off mid round: the round goes on without them", p?.kind === "plan" && JSON.stringify(p.team) === "[]", { kind: p?.kind, team: p?.team, jobs: show(inChat(chat)) });
    if (p) {
      await finish("Maya", p, "p", { mine: "x", handoffs: [{ to: "Sam", what: "gone" }] });
      const w = await take("Maya", "heavy");
      check("9d and a part for them stays with the lead", w?.kind === "work" && inChat(chat).filter((j) => j.kind === "work").length === 1, show(inChat(chat)));
      await finish("Maya", w, "done", { changed: true, read: "changed 1 file on b @ c" });
      const c2 = await take("Maya", "light");
      check("9d with nobody left to look it over, it reports", c2?.kind === "combine", show(inChat(chat)));
      if (c2) await finish("Maya", c2, "done", {});
    }
  }

  // ================= 9e. A view that is still going when the answer comes
  {
    cleanSlate();
    await pair("Lee");
    const chat = await newChat();
    await online("Maya", "Lee");
    await ask("Maya", chat, "Slow view");
    const slow = await take("Lee", "light");
    check("9e the other AI starts its view", slow?.kind === "view", slow?.kind);
    sql(`update public.jobs set created_at = now() - interval '2 minutes' where chat_id = '${chat}' and status = 'waiting'`);
    const first = await take("Maya", "light");
    check("9e after ninety seconds the lead goes ahead without it", first && ["plan", "work"].includes(first.kind), first?.kind);
    if (first?.kind === "plan") await finish("Maya", first, "p", { mine: "x", handoffs: [] });
    const w = first?.kind === "plan" ? await take("Maya", "heavy") : first;
    await finish("Maya", w, "nothing to change", { changed: false });
    const c = await take("Maya", "light");
    await finish("Maya", c, "Answered.", {});
    const js = inChat(chat);
    check("9e once the table has answered, the slow view is closed and the task is done, not left working", js.find((j) => j.kind === "view").status === "skipped" && tasksOf(`and chat_id = '${chat}'`)[0].status === "done", { jobs: show(js), task: tasksOf(`and chat_id = '${chat}'`)[0].status });
    const late = await finish("Lee", slow, "late view", {});
    check("9e and its late words are refused", !late.ok, late.status);

    // A table's answer that stopped saying it is alive, on a computer that is still on.
    const chat2 = await newChat();
    await ask("Maya", chat2, "Dead answer");
    sql(`update public.jobs set status = 'skipped' where chat_id = '${chat2}' and kind = 'view'`);
    let j = await take("Maya", "light");
    if (j?.kind === "plan") { await finish("Maya", j, "p", { mine: "x", handoffs: [] }); j = await take("Maya", "heavy"); }
    await finish("Maya", j, "n", { changed: false });
    const dead = await take("Maya", "light");
    sql(`update public.jobs set lease_until = now() - interval '11 minutes', attempts = 3 where id = '${dead.job_id}'`);
    sql(`update public.tasks set created_at = now() - interval '5 minutes' where chat_id = '${chat2}'`);
    check("9f an answer that went quiet is given up on even though its computer is on, and its task closes", (await until(() => tasksOf(`and chat_id = '${chat2}'`)[0].status !== "working", 45000)) === true, { jobs: show(inChat(chat2)), task: tasksOf(`and chat_id = '${chat2}'`) });
    unpair("Lee");
  }

  // ================= 10. Clearing the list, and what a title can be
  {
    const before = (await rest(people.Maya.token, `tasks?select=id&table_id=eq.${table}`)).body.length;
    const at = (await rpc(people.Maya.token, "clear_tasks", { t: table })).body;
    const row = sql(`select tasks_cleared_at is not null from public.members where id = '${people.Maya.id}'`);
    const lee = sql(`select tasks_cleared_at is null from public.members where id = '${people.Lee.id}'`);
    check("10a clearing is the person's own and takes nothing away for the others", before > 5 && !!at && row === "t" && lee === "t"
      && (await rest(people.Maya.token, `tasks?select=id&table_id=eq.${table}`)).body.length === before, { before, at, row, lee });

    const chat = await newChat();
    await online("Maya");
    const odd = ["", "   ", "../../etc/passwd", "--upload-pack=touch /tmp/x", "main", "ünïcödé ✨ タイトル", "a".repeat(500), "refs/heads/main", "-x", "..", "HEAD", "a b\nc\td", "sk-ant-" + "A".repeat(40)];
    const made = [];
    for (const title of odd) {
      await say("Maya", chat, `please do thing number ${made.length}?`);
      const l = await take("Maya", "light");
      await finish("Maya", l, "", { act: "work", title });
      const j = await take("Maya", "heavy");
      made.push({ title, branch: j?.branch, shown: j?.task_title });
      if (j) await finish("Maya", j, "ok", { changed: false });
    }
    results.branches = made;
    const safe = /^longtable\/[a-z0-9]+(-[a-z0-9]+)*-[0-9a-f]{8}$/;
    check("10b whatever a title is, the branch is a plain safe name under longtable/", made.every((m) => safe.test(m.branch ?? "") && m.branch.length <= 60), made.filter((m) => !safe.test(m.branch ?? "") || (m.branch ?? "").length > 60));
    check("10b titles are cut to size and never empty", made.every((m) => m.shown && m.shown.length <= 120), made.map((m) => (m.shown ?? "").length));
    check("10b a key in a title is hidden", !made.some((m) => /sk-ant-A/.test(m.shown ?? "") || /sk-ant-a/.test(m.branch ?? "")), made.at(-1));
  }

  // ================= 11. A client's own copy
  {
    cleanSlate();
    const { createHmac } = await import("node:crypto");
    await online("Maya");
    const dana = people.Dana;
    const changesOf = () => JSON.parse(sql(`select coalesce(json_agg(x order by x.created_at), '[]') from (select id, words, status, summary, detail, files, commit, verdict, note, task_id, request_id, created_at from public.sandbox_changes where member_id = '${dana.id}' and not test) x`));
    const mine = async () => (await rpc(dana.token, "client_sandbox", { t: table })).body;
    const sayAs = (body) => rpc(dana.token, "client_say", { t: table, body });

    // By default a client has no copy: their words go to the team as before.
    const plain = (await sayAs("Could the booking page be blue?")).body;
    // With one of the team's AIs on, it answers her for the team: only what she may know, on the quick lane.
    const desk = await take("Maya", "light");
    check("11a a client with no copy is answered by the team's AI, from her side only", !!plain.line && !plain.change && (await mine()).on === false && changesOf().length === 0
      && desk?.kind === "client" && desk.for_team === true && desk.me === "Dana" && desk.question === "Could the booking page be blue?" && !("history" in desk && desk.history.some((h) => h.name)) && !("pinned" in desk) && !("views" in desk),
      { plain, desk: desk && Object.keys(desk) });
    await fin("Maya", desk, "Passed on to the team.", { pass_on: true, title: "A blue booking page" });
    const deskLines = JSON.parse(sql(`select coalesce(json_agg(json_build_object('who', who, 'by_table', by_table, 'req', request_id is not null) order by created_at), '[]') from public.client_lines where member_id = '${dana.id}'`));
    check("11a2 what it cannot answer becomes a request, and the team can read the exchange", deskLines.length === 2 && deskLines.every((l) => l.by_table) && deskLines[1].who === "assistant" && deskLines[1].req === true
      && (await rest(people.Maya.token, `client_lines?select=id&member_id=eq.${dana.id}`)).body.length === 2, deskLines);

    // Only the owner gives one.
    const tries = { lee: await rpc(people.Lee.token, "set_client_sandbox", { m: dana.id, enabled: true, made_up_data: true, no_real_keys: true }), dana: await rpc(dana.token, "set_client_sandbox", { m: dana.id, enabled: true, made_up_data: true, no_real_keys: true }),
      onDev: await rpc(people.Maya.token, "set_client_sandbox", { m: people.Lee.id, enabled: true, made_up_data: true, no_real_keys: true }) };
    check("11b only the owner gives a copy, and only to a client", Object.values(tries).every((r) => r.status >= 400), Object.fromEntries(Object.entries(tries).map(([k, v]) => [k, v.status])));
    // Setting it up comes first: the place for the copy is made by the connection, with no AI asked anything.
    const early = await rpc(people.Maya.token, "set_client_sandbox", { m: dana.id, enabled: true, made_up_data: true, no_real_keys: true });
    check("11b0 a copy cannot be given before it is set up", early.status >= 400, early.status);
    const prepTries = { lee: await rpc(people.Lee.token, "prepare_client_sandbox", { m: dana.id }), dana: await rpc(dana.token, "prepare_client_sandbox", { m: dana.id }),
      notClient: await rpc(people.Maya.token, "prepare_client_sandbox", { m: people.Lee.id }) };
    const prep = await rpc(people.Maya.token, "prepare_client_sandbox", { m: dana.id });
    const again = await rpc(people.Maya.token, "prepare_client_sandbox", { m: dana.id });
    const probe = await take("Maya", "heavy");
    check("11b1 only the owner sets a copy up; doing it makes one job that only makes the branch", Object.values(prepTries).every((r) => r.status >= 400) && prep.status < 300 && again.status < 300
      && probe?.kind === "sandbox" && probe.probe === true && probe.branch === prep.body && !("words" in probe) && (await claim("Maya", "heavy")) === null,
      { tries: Object.fromEntries(Object.entries(prepTries).map(([k, v]) => [k, v.status])), probe });
    check("11b1 while it is being set up the client has nothing new", (await mine()).on === false && (await mine()).url === null);
    await fin("Maya", probe, "", { commit: "f".repeat(40) });
    const boxNow = JSON.parse(sql(`select row_to_json(s) from public.sandboxes s where member_id = '${dana.id}'`));
    check("11b2 the place is made: the branch is noted, and it is still the team's", boxNow.mode === "chat" && !!boxNow.opened_at && boxNow.tip === "f".repeat(40) && boxNow.url === null, boxNow);
    const stillNo = await rpc(people.Maya.token, "set_client_sandbox", { m: dana.id, enabled: true, made_up_data: true, no_real_keys: true });
    check("11b2 it still cannot be given without somewhere to open it", stillNo.status >= 400, stillNo.status);

    // The hosting reports the address by the commit that made the place.
    await rpc(people.Maya.token, "connect_github", { t: table });
    const secret0 = sql(`select secret from public.github_hooks where table_id = '${table}'`);
    const send0 = (body) => { const payload = JSON.stringify(body); return anon("github_event", { t: table, signature: "sha256=" + createHmac("sha256", secret0).update(payload).digest("hex"), event: "deployment_status", payload }); };
    const first = await send0({ deployment_status: { state: "success", environment_url: "https://dana-first.example.test" }, deployment: { ref: "f".repeat(40), sha: "f".repeat(40) }, repository: { full_name: "x/y" } });
    check("11b3 the address arrives by itself from the first deploy of the place", first.body === "noted" && sql(`select url from public.sandboxes where member_id = '${dana.id}'`) === "https://dana-first.example.test", first.body);

    // Whether it opens without a sign-in is noted by the owner's check, and by nobody else.
    const notes = { lee: await rpc(people.Lee.token, "note_sandbox_open", { m: dana.id, ok: true }), dana: await rpc(dana.token, "note_sandbox_open", { m: dana.id, ok: true }) };
    const noted = await rpc(people.Maya.token, "note_sandbox_open", { m: dana.id, ok: true });
    check("11b4 only the owner's check is noted", Object.values(notes).every((r) => r.status >= 400) && noted.status < 300 && sql(`select open_ok from public.sandboxes where member_id = '${dana.id}'`) === "t");

    // The team tries a change of its own before the client ever has the copy.
    // The owner's own, from the copy's set-up (since the access sweep of 16 Oct 2026): not the client, not a developer.
    const tTries = { dana: await rpc(dana.token, "team_sandbox_change", { m: dana.id, body: "x" }), lee: await rpc(people.Lee.token, "team_sandbox_change", { m: dana.id, body: "x" }),
      empty: await rpc(people.Maya.token, "team_sandbox_change", { m: dana.id, body: "  " }) };
    const tried = await rpc(people.Maya.token, "team_sandbox_change", { m: dana.id, body: "Make the title blue" });
    const tj = await take("Maya", "heavy");
    check("11b5 a test change of the owner's own is built like any other", Object.values(tTries).every((r) => r.status >= 400) && tried.status < 300 && tj?.kind === "sandbox" && tj.test === true && tj.words === "Make the title blue", { tries: Object.fromEntries(Object.entries(tTries).map(([k, v]) => [k, v.status])), tj: tj && { kind: tj.kind, test: tj.test } });
    await fin("Maya", tj, "The title is blue.", { changed: true, commit: "9".repeat(40), files: ["app/page.tsx"], detail: "Blue title." });
    const testRow = JSON.parse(sql(`select row_to_json(c) from public.sandbox_changes c where id = '${tried.body}'`));
    check("11b5 the client never sees the team's test, and it is not theirs to be answered", testRow.status === "ready" && testRow.test === true && (await mine()).changes.length === 0
      && (await rpc(people.Maya.token, "judge_change", { change: tried.body, answer: "take" })).status >= 400, { status: testRow.status, hers: (await mine()).changes.length });

    const unticked = await rpc(people.Maya.token, "set_client_sandbox", { m: dana.id, enabled: true });
    check("a copy is not given until the owner has said its previews hold made-up data and no real keys", unticked.status >= 400 && /made-up data/.test(JSON.stringify(unticked.body)), unticked);
    const given = await rpc(people.Maya.token, "set_client_sandbox", { m: dana.id, enabled: true, made_up_data: true, no_real_keys: true });
    const branch = sql(`select branch from public.sandboxes where member_id = '${dana.id}'`);
    check("11b the owner gives it, on a plain branch of its own", given.status < 300 && /^longtable\/sandbox-dana-[0-9a-f]{8}$/.test(branch) && (await mine()).on === true && (await mine()).left === 20, { status: given.status, branch, left: (await mine()).left });

    // The owner tried a change in it first, so giving it puts the copy back as the product stands: no AI asked.
    const clean = await take("Maya", "heavy");
    check("11b6 giving a copy the owner tried things in first makes it clean", clean?.kind === "sandbox" && clean.probe === true && clean.fresh === true && clean.branch === branch, clean && Object.keys(clean));
    await fin("Maya", clean, "", { commit: "8".repeat(40) });

    // What they say is now a change in their copy, done by the team's Claude.
    const said = (await sayAs("Make the header green and bigger")).body;
    check("11c with a copy, their words are a change there, and they are told how many are left", !!said.change && said.left === 19, said);
    check("11c the quick lane does not take it", (await claim("Maya", "light")) === null);
    const j = await take("Maya", "heavy");
    check("11c the team's Claude gets the client's words, the branch, and nothing of the team's chats", j?.kind === "sandbox" && j.words === "Make the header green and bigger" && j.branch === branch && j.client === "Dana"
      && !("history" in j) && !("pinned" in j) && !("views" in j), j && Object.keys(j));
    const seenWorking = await mine();
    check("11c she sees it being built", seenWorking.changes[0]?.status === "working" && seenWorking.changes[0].words === "Make the header green and bigger", seenWorking.changes[0]);
    await anon("runner_beat", { token: people.Maya.device, job: j.job_id, note: "editing header.tsx" });
    const fin1 = await fin("Maya", j, "The header is green now, and larger. Open any page to see it.", { changed: true, commit: "a".repeat(40), files: ["src/header.tsx", "src/theme.css"], detail: "Changed header.tsx and theme.css. Colours are hard-coded." });
    const row = changesOf().at(-1);
    check("11d when it is done the team's row has everything", fin1.ok && row.status === "ready" && row.files.length === 2 && /hard-coded/.test(row.detail) && row.commit === "a".repeat(40), row);
    const hers = (await mine()).changes[0];
    check("11d she gets the plain words and none of the team's part", hers.status === "ready" && /green now/.test(hers.summary) && !("detail" in hers) && !("files" in hers) && !("commit" in hers), hers);
    const direct = (await rest(dana.token, `sandbox_changes?select=*&table_id=eq.${table}`)).body;
    const jobsSeen = (await rest(dana.token, `jobs?select=id,kind&table_id=eq.${table}&kind=eq.sandbox`)).body;
    check("11d she cannot read the changes table or the job itself", Array.isArray(direct) && direct.length === 0 && Array.isArray(jobsSeen) && jobsSeen.length === 0, { direct, jobsSeen });

    // A question, or something only the team may do, is passed on.
    await sayAs("When does this go live?");
    const q = await take("Maya", "heavy");
    await fin("Maya", q, "That one is for the team, so I passed it on. You will hear here what they decide.", { pass_on: true, title: "When does it go live" });
    const passed = changesOf().at(-1);
    check("11e what is not a change goes to the team as a request", passed.status === "passed" && !!passed.request_id
      && sql(`select title from public.requests where id = '${passed.request_id}'`) === "When does it go live", passed);
    check("11e and it still counts against her changes for the day, since it was a run of the team's AI", (await mine()).left === 18, (await mine()).left);

    // What a connection sends is cleaned and cut.
    await sayAs("Tidy the footer");
    const big = await take("Maya", "heavy");
    await fin("Maya", big, "x".repeat(5000) + " sk-ant-" + "Q".repeat(40), { changed: true, commit: "not a commit; drop table", files: [...Array(300)].map((_, i) => `f${i}/` + "y".repeat(600)), detail: "d".repeat(9000) });
    const cut = changesOf().at(-1);
    check("11f an oversized or odd answer is cut to size, and a bad commit name is dropped", cut.summary.length <= 1200 && cut.detail.length <= 4000 && cut.files.length <= 80 && cut.files.every((f) => f.length <= 300) && cut.commit === null, { s: cut.summary.length, d: cut.detail.length, f: cut.files.length, c: cut.commit });

    // The team answers each one.
    const ready = changesOf().filter((c) => c.status === "ready");
    const wrong = { dana: await rpc(dana.token, "judge_change", { change: ready[0].id, answer: "take" }), bad: await rpc(people.Maya.token, "judge_change", { change: ready[0].id, answer: "merge it" }),
      notReady: await rpc(people.Maya.token, "judge_change", { change: passed.id, answer: "take" }) };
    check("11g a client cannot answer for the team, and only a ready change can be answered", Object.values(wrong).every((r) => r.status >= 400), Object.fromEntries(Object.entries(wrong).map(([k, v]) => [k, v.status])));
    const no = await rpc(people.Maya.token, "judge_change", { change: ready[1].id, answer: "no", said: "We are keeping the footer as it is for launch." });
    const toldNo = (await mine()).changes.find((c) => c.id === ready[1].id);
    check("11g not this: she reads the team's reason on that change", no.status < 300 && toldNo.verdict === "no" && /keeping the footer/.test(toldNo.note), toldNo);
    const took = await rpc(people.Maya.token, "judge_change", { change: ready[0].id, answer: "take" });
    const task = tasksOf().find((t) => t.id === took.body);
    const ref = JSON.parse(sql(`select reference from public.tasks where id = '${took.body}'`));
    check("11h take it: the team's own work starts, pointing at her copy", took.status < 300 && !!task && /^From Dana: /.test(task.title) && ref.branch === branch && ref.commit === "a".repeat(40) && ref.client === "Dana", { task, ref });
    const w = await take("Maya", "heavy");
    check("11h the team's work is handed where to look, on the task's own branch and not hers", ["answer", "work", "plan"].includes(w?.kind) && w.reference?.branch === branch && w.branch !== branch && /from Dana's sandbox/.test(w.question) && !/header green/.test(w.question) && /header green/.test(w.reference?.words ?? ""), w && { kind: w.kind, ref: w.reference, branch: w.branch });
    await fin("Maya", w, "Built properly.", { changed: false });
    check("11h she is told the team is building it", (await mine()).changes.find((c) => c.id === ready[0].id).verdict === "take");
    check("11h a taken change cannot be taken twice", (await rpc(people.Maya.token, "judge_change", { change: ready[0].id, answer: "take" })).status >= 400);

    // The day's limit, and a team whose computers are off.
    await rpc(people.Maya.token, "set_sandbox_links", { t: table, ours: "https://ours.example.test", cap: 3, m: dana.id, theirs: "https://dana.example.test/app" });
    const full = (await sayAs("One more thing")).body;
    check("11i past the day's limit her words go to the team, and she is told why", !!full.request && full.why === "full" && (await mine()).left === 0, full);
    await rpc(people.Maya.token, "set_sandbox_links", { t: table, ours: "https://ours.example.test", cap: 50, m: dana.id, theirs: "https://dana.example.test/app" });
    offline("Maya");
    const asleep = (await sayAs("Is anyone there")).body;
    check("11i with no team Claude on, her words go to the team, and she is told why", !!asleep.request && asleep.why === "asleep", asleep);
    await online("Maya");

    // Addresses.
    const urls = { js: await rpc(people.Maya.token, "set_sandbox_links", { t: table, ours: "javascript:alert(1)", cap: 50 }), http: await rpc(people.Maya.token, "set_sandbox_links", { t: table, ours: "http://plain.example.test", cap: 50 }),
      theirs: await rpc(people.Maya.token, "set_sandbox_links", { t: table, ours: "", cap: 50, m: dana.id, theirs: "https://x.test/\"><script>" }), lee: await rpc(people.Lee.token, "set_sandbox_links", { t: table, ours: "https://a.test", cap: 5 }) };
    check("11j only plain https addresses are kept, and only the owner sets them", Object.values(urls).every((r) => r.status >= 400) && (await mine()).url === "https://dana.example.test/app", { ...Object.fromEntries(Object.entries(urls).map(([k, v]) => [k, v.status])), url: (await mine()).url });

    // GitHub says where the copy was put up.
    const secret = sql(`select secret from public.github_hooks where table_id = '${table}'`);
    const send = (event, body) => { const payload = JSON.stringify(body); return anon("github_event", { t: table, signature: "sha256=" + createHmac("sha256", secret).update(payload).digest("hex"), event, payload }); };
    const dep = await send("deployment_status", { deployment_status: { state: "success", environment_url: "https://sandbox-dana-abc.example.test" }, deployment: { ref: "deadbeef", sha: "a".repeat(40) }, repository: { full_name: "x/y" } });
    check("11k when the hosting reports where her copy is, its address fills itself in", dep.body === "noted" && (await mine()).url === "https://sandbox-dana-abc.example.test", { dep: dep.body, url: (await mine()).url });
    const other = await send("deployment_status", { deployment_status: { state: "success", environment_url: "https://production.example.test" }, deployment: { ref: "main", sha: "b".repeat(40) }, repository: { full_name: "x/y" } });
    const evil = await send("deployment_status", { deployment_status: { state: "success", environment_url: "javascript:alert(1)" }, deployment: { ref: branch, sha: "a".repeat(40) }, repository: { full_name: "x/y" } });
    // A build of her copy that names an address that is not https still counts as online; the address is never taken.
    check("11k a deployment of anything else changes nothing, and an address that is not https never replaces hers", other.body === "ignored" && evil.body === "noted" && (await mine()).url === "https://sandbox-dana-abc.example.test", { other: other.body, evil: evil.body });

    // Taking a change with no AI on is refused, so nobody is told the team is building something it is not.
    await sayAs("Round the corners");
    const rc = await take("Maya", "heavy");
    await fin("Maya", rc, "Rounded.", { changed: true, commit: "e".repeat(40), files: ["a.css"] });
    const rcId = changesOf().at(-1).id;
    awake.delete("Maya");
    sql(`update public.connections set revoked_at = now() where table_id = '${table}' and revoked_at is null`);
    const noAi2 = await rpc(people.Maya.token, "judge_change", { change: rcId, answer: "take" });
    check("11k2 with no AI connected, Take is refused and the change stays open", noAi2.status >= 400 && changesOf().find((c) => c.id === rcId).verdict === null, { status: noAi2.status, body: noAi2.body });
    await pair("Maya");
    await online("Maya");
    sql(`delete from public.sandbox_changes where id = '${rcId}' or task_id is not null and words = 'Round the corners'`);

    // Folders the owner sets, and what a folder may be.
    const f1 = await rpc(people.Maya.token, "set_sandbox_links", { t: table, ours: "", cap: 50, folders: " /app/ , components" + String.fromCharCode(10) + "ui " });
    const kept = sql(`select paths from public.table_sandbox where table_id = '${table}'`);
    const f2 = await rpc(people.Maya.token, "set_sandbox_links", { t: table, ours: "", cap: 50, folders: "../../etc, app" });
    const f3 = await rpc(people.Maya.token, "set_sandbox_links", { t: table, ours: "", cap: 50, folders: "app; rm -rf" });
    check("11k3 the folders a copy may change are plain paths, tidied, and nothing else is kept", f1.status < 300 && kept === "app, components, ui" && f2.status >= 400 && f3.status >= 400, { kept, f2: f2.status, f3: f3.status });
    await sayAs("Check folders");
    const fj = await take("Maya", "heavy");
    check("11k3 and the connection is told them", fj?.paths === "app, components, ui", fj?.paths);
    await fin("Maya", fj, "ok", { changed: false });
    await rpc(people.Maya.token, "set_sandbox_links", { t: table, ours: "", cap: 50, folders: "" });

    // A client cannot read where anyone's copy lives, or the team's own address.
    const peek = { boxes: (await rest(dana.token, `sandboxes?select=*`)).body, settings: (await rest(dana.token, `table_sandbox?select=*`)).body,
      members: (await rest(dana.token, `members?select=*&table_id=eq.${table}`)).body };
    check("11k4 a client cannot read any copy's branch or address, or the team's own", Array.isArray(peek.boxes) && peek.boxes.length === 0 && Array.isArray(peek.settings) && peek.settings.length === 0
      && !JSON.stringify(peek.members).includes("sandbox"), { boxes: peek.boxes, settings: peek.settings });

    // Stop, and a job nobody takes.
    await sayAs("Change everything");
    const run1 = await take("Maya", "heavy");
    await rpc(people.Lee.token, "stop_job", { job: run1.job_id });
    check("11l the team stops one: she is told it was stopped", (await until(async () => (await mine()).changes[0].status === "stopped", 30000)) === true && (await anon("runner_beat", { token: people.Maya.device, job: run1.job_id, note: "x" })).body === false, (await mine()).changes[0]);
    await sayAs("And another");
    sql(`update public.jobs set created_at = now() - interval '11 minutes' where kind = 'sandbox' and status = 'queued' and table_id = '${table}'`);
    await sleep(14000);
    check("11l one that is only waiting behind a busy computer is kept", (await mine()).changes[0].status === "working", (await mine()).changes[0]);
    offline("Maya");
    check("11l one the team's computer never takes is closed, not left being built for ever", (await until(async () => (await mine()).changes[0].status === "failed", 30000)) === true, (await mine()).changes[0]);

    await online("Maya");

    // Taking the copy away.
    await rpc(people.Maya.token, "set_client_sandbox", { m: dana.id, enabled: false });
    const after = (await sayAs("Back to talking")).body;
    check("11m with the copy taken away she is back to talking to the team, and her history is kept", (!!after.request || !!after.line) && !after.change && (await mine()).on === false && (await mine()).changes.length >= 5 && sql(`select branch from public.sandboxes where member_id = '${dana.id}'`) === branch, after);

    // Someone at another table.
    const other2 = await startTable(browser, `other2-${run}@example.test`, "Elsewhere", "Olga");
    const oTok = await accessToken(other2.context);
    const cross = { read: (await rest(oTok, `sandbox_changes?select=id&table_id=eq.${table}`)).body, judge: await rpc(oTok, "judge_change", { change: ready[1].id, answer: "take" }),
      give: await rpc(oTok, "set_client_sandbox", { m: dana.id, enabled: true, made_up_data: true, no_real_keys: true }), mine: await rpc(oTok, "client_sandbox", { t: table }) };
    check("11n someone at another table sees and touches none of it", cross.read.length === 0 && cross.judge.status >= 400 && cross.give.status >= 400 && cross.mine.status >= 400, { judge: cross.judge.status, give: cross.give.status, mine: cross.mine.status });
    await other2.context.close();
  }
} catch (e) {
  check("the run did not crash", false, e.stack || String(e));
} finally {
  clearInterval(globalThis.simPulse);
  await browser.close();
}

const failed = Object.values(results.checks).filter((v) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
console.log(`${Object.keys(results.checks).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
