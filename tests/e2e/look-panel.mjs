// Pictures of the work panel in the states that are hard to catch with a real AI: long work in progress with a
// heartbeat, a queue behind it, awkward titles and names, dark mode, a phone. A fake connection holds each state
// still. Writes PNGs to the folder in SCREENSHOTS; checks only that nothing spills out of the panel.
//
//   SCREENSHOTS=<folder> node --experimental-websocket tests/e2e/look-panel.mjs

import { execFileSync } from "node:child_process";
import { accessToken, API, inviteLink, join as joinTable, KEY, launch, rest, rpc, sleep, startTable } from "./lib.mjs";

const out = process.env.SCREENSHOTS;
if (!out) throw new Error("Set SCREENSHOTS to a folder.");
const run = Date.now().toString(36);
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "")}`.slice(0, 400); };
const sql = (q) => execFileSync("docker", ["exec", "-i", "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
const anon = async (fn, args) => (await fetch(`${API}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(args) })).json().catch(() => null);

const browser = await launch();
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Booking app", "Maya");
  const table = owner.tableId;
  const dev = await joinTable(browser, await inviteLink(owner.page, "developer"), `dev-${run}@example.test`, "Bartholomew Featherstonehaugh-Montgomery");
  const tokens = { Maya: await accessToken(owner.context), Dev: await accessToken(dev.context) };
  const device = {};
  for (const [name, token] of Object.entries(tokens)) {
    const code = (await rpc(token, "start_pairing", { t: table, ai_kind: "claude" })).body;
    device[name] = (await anon("pair_connection", { code, device_label: "look" })).token;
  }
  sql(`update public.jobs set status = 'skipped' where table_id = '${table}' and kind = 'intro'`);
  const chat = (await rest(tokens.Maya, `chats?select=id&table_id=eq.${table}`)).body[0].id;
  const pulse = setInterval(() => { for (const d of Object.values(device)) anon("runner_hello", { token: d }); }, 8000);
  const take = async (name, lane) => { for (let i = 0; i < 40; i++) { const j = await anon("runner_claim", { token: device[name], lane }); if (j) return j; await sleep(500); } return null; };
  const fin = (name, job, answer, info) => anon("runner_finish", { token: device[name], job: job.job_id, answer, info });

  // One finished, one stopped, one with an awkward title, then two in progress and one queued.
  const work = async (asker, text, title, end) => {
    await rpc(tokens[asker], "ask_table", { c: chat, body: text });
    const other = asker === "Maya" ? "Dev" : "Maya";
    await fin(other, await take(other, "light"), "view", {});
    const p = await take(asker, "light");
    await fin(asker, p, "plan", { mine: "x", handoffs: [] });
    if (title) sql(`update public.tasks set title = '${title}' where id = (select task_id from public.jobs where id = '${p.job_id}')`);
    const w = await take(asker, "heavy");
    if (end === "done") {
      await fin(asker, w, "done", { changed: true, read: `changed 3 files on ${w.branch} @ a1b2c3d` });
      await fin(other, await take(other, "light"), "ok", { ok: true });
      const c = await take("Maya", "light");
      await fin("Maya", c, "It is done and on its branch.", { read: c.work_read });
    } else if (end === "stop") {
      await rpc(tokens.Maya, "stop_job", { job: w.job_id });
    }
    return w;
  };
  await work("Maya", "Add rate limiting to the API", "Add rate limiting", "done");
  await work("Dev", "Rewrite the importer", "Rewrite the importer", "stop");
  await work("Maya", "x", "https://example.com/a/really/long/path/with/no/spaces/at/all/that/goes/on/and/on/index.html?and=a&query=string", "done");
  const a = await work("Maya", "Move the booking flow to server actions", "Move booking to server actions", "run");
  const b = await work("Dev", "Add inspection photos to returns", "Inspection photos on returns", "run");
  sql(`update public.jobs set started_at = now() - interval '47 minutes' where id = '${a.job_id}'; update public.jobs set started_at = now() - interval '3 hours 12 minutes' where id = '${b.job_id}'`);
  await anon("runner_beat", { token: device.Maya, job: a.job_id, note: "editing booking-actions.ts" });
  await anon("runner_beat", { token: device.Dev, job: b.job_id, note: "reading a-very-long-file-name-for-the-inspection-photo-upload-component.tsx" });
  // A third thing for Maya's AI while it is busy: it waits its turn.
  await rpc(tokens.Maya, "ask_table", { c: chat, body: "Tidy the README" });
  await fin("Dev", await take("Dev", "light"), "view", {});
  await fin("Maya", await take("Maya", "light"), "plan", { mine: "x", handoffs: [] });

  const page = owner.page;
  const fits = async (label) => {
    const spill = await page.evaluate(() => {
      const panel = document.querySelector("[data-testid=work-panel]");
      if (!panel) return "no panel";
      const box = panel.getBoundingClientRect();
      const bad = [...panel.querySelectorAll("*")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1); });
      return bad.length ? bad.slice(0, 3).map((el) => el.className + ": " + (el.textContent || "").slice(0, 40)) : (document.documentElement.scrollWidth > window.innerWidth + 1 ? "the page scrolls sideways" : null);
    });
    check(`${label}: nothing spills out of the panel`, spill === null, spill);
  };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.waitForSelector("[data-testid=work-panel]");
  await sleep(800);
  check("three in progress first, then the finished ones", (await page.locator("[data-testid=work-task]").count()) === 6);
  await fits("wide, light");
  await page.screenshot({ path: `${out}/panel-light.png` });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await sleep(300);
  await page.screenshot({ path: `${out}/panel-dark.png` });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });

  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(500);
  const toggle = page.locator("button:has-text('Work')").first();
  check("on a phone there is a Work button to open the panel", await toggle.isVisible());
  await toggle.click();
  await sleep(500);
  await fits("phone");
  await page.screenshot({ path: `${out}/panel-phone.png` });

  // Clear: the finished ones go, the three in progress stay, and the panel stays for them.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await sleep(300);
  await page.click("[data-testid=work-clear]");
  await sleep(600);
  check("Clear leaves what is still in progress", (await page.locator("[data-testid=work-task]").count()) === 3 && (await page.locator("[data-testid=work-clear]").count()) === 0);
  await page.screenshot({ path: `${out}/panel-cleared.png` });

  // A chat with nothing going on: the panel is there all the same.
  const quiet = await startTable(browser, `quiet-${run}@example.test`, "Quiet", "Olga");
  await quiet.page.setViewportSize({ width: 390, height: 844 });
  await sleep(500);
  await quiet.page.goto(quiet.page.url().split("?")[0] + "?c=general");
  await quiet.page.click("button:has-text('Work')");
  await sleep(400);
  check("with no work the panel is still there, saying so", (await quiet.page.locator("[data-testid=work-quiet]").count()) === 1);
  await quiet.page.screenshot({ path: `${out}/panel-quiet-phone.png` });
  await quiet.page.setViewportSize({ width: 1440, height: 1000 });
  await sleep(300);
  await quiet.page.screenshot({ path: `${out}/panel-quiet.png` });
  clearInterval(pulse);
} catch (e) {
  check("the run did not crash", false, e.stack || String(e));
} finally {
  await browser.close();
}
const failed = Object.values(results).filter((v) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
