// The connection as a program on someone's computer: only one runs at a time, it survives starting with no network,
// a table that took it off does not stop the others, and disconnecting ends the one that is running.
//
//   node --experimental-websocket tests/e2e/step15-connection.mjs

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accessToken, launch, rest, sleep, startTable } from "./lib.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const bin = join(repoRoot, "packages", "connect", "bin", "longtable.mjs");
const run = Date.now().toString(36);
const results = { checks: {} };
const check = (name, ok, detail) => { results.checks[name] = ok ? "pass" : `FAIL ${typeof detail === "string" ? detail : JSON.stringify(detail ?? "")}`.slice(0, 500); };
const savedSignIn = join(homedir(), ".longtable", "secrets", "claude-token.bin");
if (!existsSync(savedSignIn)) throw new Error("No saved Claude sign-in on this computer.");

const home = mkdtempSync(join(tmpdir(), "longtable-home-"));
mkdirSync(join(home, "secrets"), { recursive: true });
copyFileSync(savedSignIn, join(home, "secrets", "claude-token.bin"));
const env = { ...process.env, LONGTABLE_HOME: home, LONGTABLE_MODEL: "haiku" };
const alive = (child) => child.exitCode === null && child.signalCode === null;
const start = () => spawn(process.execPath, [bin, "run"], { env, stdio: "ignore", windowsHide: true });
const log = () => { try { return readFileSync(join(home, "runner.log"), "utf8"); } catch { return ""; } };

const browser = await launch();
const kids = [];
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Connection test", "Maya");
  await owner.page.click("[data-testid=me-menu]");
  await owner.page.click("button:has-text('Connect my AI')");
  await owner.page.click("[data-testid=pick-claude]");
  await owner.page.click("text=It is only on my computer");
  const message = await owner.page.locator("[data-testid=connect-message]").textContent();
  const [, code, app] = message.match(/connect ([0-9A-F]{20}) --app (\S+)/);
  const paired = spawnSync(process.execPath, [bin, "connect", code, "--app", app, "--repo", repoRoot, "--no-autostart", "--no-run"], { env, encoding: "utf8" });
  check("it pairs", paired.status === 0, paired.stderr || paired.stdout);
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  check("it remembers the folder it was connected from", config.connections[0].folder === repoRoot, config.connections[0]);

  // Only one at a time.
  const first = start();
  kids.push(first);
  await sleep(6000);
  const firstPid = Number(readFileSync(join(home, "runner.pid"), "utf8").split(" ")[0]);
  check("the running connection writes down which process it is", firstPid === first.pid && alive(first), { firstPid, pid: first.pid });
  const second = start();
  kids.push(second);
  await sleep(6000);
  check("starting a second one ends the first, and the second carries on", !alive(first) && alive(second) && Number(readFileSync(join(home, "runner.pid"), "utf8").split(" ")[0]) === second.pid, { first: alive(first), second: alive(second) });
  // The stand-in `connect` starts when the start-up task is slow never ends the real one (it would leave a
  // connection tied to the window that ran connect): it steps aside.
  const standIn = spawn(process.execPath, [bin, "run", "--backup"], { env, stdio: "ignore", windowsHide: true });
  kids.push(standIn);
  await sleep(6000);
  check("a stand-in started beside a running connection steps aside and leaves it running", alive(second) && !alive(standIn) && Number(readFileSync(join(home, "runner.pid"), "utf8").split(" ")[0]) === second.pid, { second: alive(second), standIn: alive(standIn) });
  // Full Claude Code on, and a quick job of its person's arrives: the connection takes it and keeps running (0.1.30
  // to 0.1.32 crashed here on a counter read before it was set).
  const dbq = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
  const T = owner.tableId;
  dbq(`update public.connections set full_claude = true where table_id = '${T}' and revoked_at is null`);
  const mayaId = dbq(`select id from public.members where table_id = '${T}' and display_name = 'Maya'`);
  const chatId = dbq(`select id from public.chats where table_id = '${T}' and is_general`);
  const q = dbq(`insert into public.messages (table_id, chat_id, member_id, body) values ('${T}', '${chatId}', '${mayaId}', 'what is in the readme?') returning id`);
  dbq(`insert into public.jobs (table_id, chat_id, member_id, question_id, kind) values ('${T}', '${chatId}', '${mayaId}', '${q}', 'listen')`);
  await sleep(10000);
  const took = dbq(`select count(*) from public.jobs where table_id = '${T}' and kind = 'listen' and status <> 'queued'`);
  check("with full Claude Code on, a quick job of its person's is taken and the connection keeps running", alive(second) && took !== "0", { alive: alive(second), took });
  const token = await accessToken(owner.context);
  const seen = async () => (await rest(token, `connections?select=last_seen&table_id=eq.${owner.tableId}`)).body[0]?.last_seen;
  const before = await seen();
  await sleep(5000);
  check("and the table still sees it as on", new Date(await seen()) > new Date(before));

  // A note left over from before the computer last started is not trusted: its number may be any program's by now.
  const note = readFileSync(join(home, "runner.pid"), "utf8");
  const { runningConnection } = await import("../../packages/connect/src/run.mjs");
  process.env.LONGTABLE_HOME = home;
  const stale = mkdtempSync(join(tmpdir(), "longtable-stale-"));
  writeFileSync(join(stale, "runner.pid"), `${process.pid} ${Date.now() - 400 * 24 * 3600 * 1000}`);
  const asked = spawnSync(process.execPath, ["-e", `import(${JSON.stringify("file:///" + join(repoRoot, "packages", "connect", "src", "run.mjs").split(String.fromCharCode(92)).join("/"))}).then(m=>console.log(String(m.runningConnection())))`], { env: { ...env, LONGTABLE_HOME: stale }, encoding: "utf8" });
  check("a note from before the last restart is ignored, so no other program is ever ended", asked.stdout.trim() === "null" && note.split(" ").length === 2, { out: asked.stdout, err: asked.stderr.slice(0, 200), note });
  rmSync(stale, { recursive: true, force: true });

  // Disconnecting on this computer ends the one that is running.
  const off = spawnSync(process.execPath, [bin, "disconnect"], { env, encoding: "utf8" });
  await sleep(3000);
  check("disconnect ends the running connection and forgets its keys", off.status === 0 && !alive(second) && !existsSync(join(home, "runner.pid"))
    && JSON.parse(readFileSync(join(home, "config.json"), "utf8")).connections.length === 0, { status: off.status, alive: alive(second) });

  // Starting with no network: it waits and keeps trying, it does not give up.
  writeFileSync(join(home, "config.json"), JSON.stringify({ ...config, supabaseUrl: "http://127.0.0.1:9" }));
  // Its device key was forgotten by disconnect; put a made-up one back so there is a seat to start with.
  const { saveSecret } = await import("../../packages/connect/src/store.mjs").catch(() => ({}));
  const keyEnv = spawnSync(process.execPath, ["-e", `process.env.LONGTABLE_HOME=${JSON.stringify(home)};import(${JSON.stringify("file:///" + join(repoRoot, "packages", "connect", "src", "store.mjs").replace(/\\/g, "/"))}).then(m=>m.saveSecret("device-${config.connections[0].table_id}-claude","${"a".repeat(64)}"))`], { env, encoding: "utf8" });
  const third = start();
  kids.push(third);
  await sleep(20000);
  check("with the table unreachable at start it keeps trying instead of exiting", keyEnv.status === 0 && alive(third) && /hello failed/.test(log()), { key: keyEnv.stderr, alive: alive(third), log: log().slice(-300) });
  third.kill();

  // A table that took this connection off: the program says so and stops asking, it does not spin.
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  const fourth = start();
  kids.push(fourth);
  await sleep(12000);
  check("a connection every table has taken off ends itself, with the reason in its log", !alive(fourth) && /removed|taken this connection off/i.test(log()), { alive: alive(fourth), log: log().slice(-300) });
} catch (e) {
  check("the run did not crash", false, e.stack || String(e));
} finally {
  for (const k of kids) { try { k.kill(); } catch {} }
  await browser.close();
  try { rmSync(home, { recursive: true, force: true }); } catch {}
}

const failed = Object.values(results.checks).filter((v) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
