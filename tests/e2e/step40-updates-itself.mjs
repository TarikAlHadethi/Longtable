// The connection updates itself (17 Oct 2026): a running connection hears from Longtable that a newer version is
// wanted, fetches exactly it from the registry (a stand-in on this computer), puts it in place, starts again on it,
// and reports the new version to the table. Nobody connects again. No AI is asked anything.
//
//   node --experimental-websocket tests/e2e/step40-updates-itself.mjs

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageOf } from "./lib-pack.mjs";
import { accessToken, API, KEY, launch, rpc, sleep, startTable } from "./lib.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const bin = join(repoRoot, "packages", "connect", "bin", "longtable.mjs");
const run = Date.now().toString(36);
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 500)}`; };
const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
const anon = async (fn, args) => (await fetch(`${API}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(args) })).json().catch(() => null);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const stop = (pid) => { if (!pid) return; if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); else try { process.kill(pid); } catch {} };

// A stand-in npm registry with one newer version of the connection on it.
const NEXT = "9.8.7";
const gz = packageOf(NEXT);
const server = createServer((req, res) => {
  if (req.url === `/longtable/${NEXT}`) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ name: "longtable", version: NEXT, dist: { tarball: `${base}/longtable/-/longtable-${NEXT}.tgz`, integrity: `sha512-${createHash("sha512").update(gz).digest("base64")}` } })); }
  if (req.url === `/longtable/-/longtable-${NEXT}.tgz`) { res.writeHead(200); return res.end(gz); }
  res.writeHead(404); res.end("{}");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const home = mkdtempSync(join(tmpdir(), "longtable-update-home-"));
// The saved Claude sign-in, as every suite that connects uses: without it, connect would start a new sign-in.
const savedSignIn = join(homedir(), ".longtable", "secrets", "claude-token.bin");
if (!existsSync(savedSignIn)) throw new Error("No saved Claude sign-in on this computer.");
mkdirSync(join(home, "secrets"), { recursive: true });
copyFileSync(savedSignIn, join(home, "secrets", "claude-token.bin"));
const was = sql("select version from public.connect_release");
const browser = await launch();
let first = null;
let second = null;
try {
  const owner = await startTable(browser, `owner-${run}@example.test`, "Updates", "Maya");
  const { tableId } = owner;
  const tok = await accessToken(owner.context);
  const code = (await rpc(tok, "start_pairing", { t: tableId, ai_kind: "claude" })).body;
  const env = { ...process.env, LONGTABLE_HOME: home, LONGTABLE_REGISTRY: base, LONGTABLE_UPDATE_AFTER_MS: "4000" };
  delete env.INVOCATION_ID;
  delete env.XPC_SERVICE_NAME;
  const app = (await (await fetch(`${process.env.APP_URL || "http://localhost:3000"}/api/connect/config`)).json()) ? (process.env.APP_URL || "http://localhost:3000") : null;
  const r = spawnSync(process.execPath, [bin, "connect", code, "--app", app, "--repo", repoRoot, "--no-autostart", "--no-run"], { env, encoding: "utf8" });
  check("it connects", r.status === 0, r.stderr || r.stdout);
  if (r.status !== 0) throw new Error("connect failed");
  sql(`update public.jobs set status = 'skipped' where table_id = '${tableId}' and kind = 'intro'`);
  const connId = sql(`select id from public.connections where table_id = '${tableId}' and revoked_at is null`);

  // Longtable says the newer version is wanted, then the connection runs as it would on any computer.
  sql(`update public.connect_release set version = '${NEXT}'`);
  first = spawn(process.execPath, [bin, "run"], { env, stdio: "ignore", windowsHide: true });
  const firstPid = first.pid;
  let reported = "";
  for (let i = 0; i < 60 && reported !== NEXT; i++) { await sleep(1000); reported = sql(`select coalesce(limits ->> 'version', '') from public.connections where id = '${connId}'`); }
  const log = readFileSync(join(home, "runner.log"), "utf8");
  check("it hears the newer version, fetches it and puts it in place", log.includes(`update: ${JSON.parse(readFileSync(join(repoRoot, "packages", "connect", "package.json"), "utf8")).version} -> ${NEXT}`)
    && JSON.parse(readFileSync(join(home, "app", "package.json"), "utf8")).version === NEXT, log.split("\n").slice(-8));
  check("the old one stops and the new one starts by itself", !alive(firstPid) && /started the new version/.test(log), { firstAlive: alive(firstPid) });
  const pid = Number(readFileSync(join(home, "runner.pid"), "utf8").split(" ")[0]);
  second = pid;
  check("the new one is running from the updated copy", pid && pid !== firstPid && alive(pid));
  check("the table sees the new version, with nobody connecting again", reported === NEXT, reported);
  check("still the same connection at the table", sql(`select count(*) from public.connections where table_id = '${tableId}' and revoked_at is null`) === "1"
    && sql(`select id from public.connections where table_id = '${tableId}' and revoked_at is null`) === connId);
  check("the new one does not update again", (await (async () => { await sleep(6000); return (readFileSync(join(home, "runner.log"), "utf8").match(/update: [0-9.]+ -> /g) || []).length; })()) === 1);
} catch (e) {
  results.error = String(e?.stack || e).slice(0, 900);
} finally {
  sql(`update public.connect_release set version = '${was}'`);
  stop(second);
  if (first) stop(first.pid);
  server.close();
  await browser.close();
  await sleep(500);
  try { rmSync(home, { recursive: true, force: true }); } catch {}
}
const failed = Object.entries(results).filter(([, v]) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
