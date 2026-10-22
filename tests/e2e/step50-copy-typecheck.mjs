// A client's copy runs the project's own type check before a change is pushed, on the real model: a small TypeScript
// project (installed packages and generated code git ignores, as a real one has), a team member's connection, and a
// test client asking for two things. A plain change lands, checked; one whose only clean fix is in a file a copy may
// never change is not pushed, and goes to the team. The copy's branch never carries the check's leftovers.
//
//   node --experimental-websocket tests/e2e/step50-copy-typecheck.mjs

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accessToken, launch, rpc, startTable, tableRepo, sleep } from "./lib.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const bin = join(repoRoot, "packages", "connect", "bin", "longtable.mjs");
const sql = (q) => execFileSync("docker", ["exec", "-i", process.env.DB_CONTAINER || "supabase_db_longtable", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const win = process.platform === "win32";
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 400)}`; };
const savedSignIn = join(homedir(), ".longtable", "secrets", "claude-token.bin");
if (!existsSync(savedSignIn)) throw new Error("No saved Claude sign-in on this computer.");

// The project, shaped like a real one: typed tabs the page uses, a server file that owns the booking rules, generated
// types the code imports but git ignores, and installed packages.
const scratch = mkdtempSync(join(tmpdir(), "longtable-copycheck-"));
const remote = join(scratch, "remote.git");
const project = join(scratch, "project");
git(scratch, "init", "-q", "--bare", "-b", "main", remote);
git(scratch, "clone", "-q", remote, project);
mkdirSync(join(project, "src", "server"), { recursive: true });
mkdirSync(join(project, "src", "generated"), { recursive: true });
writeFileSync(join(project, ".gitignore"), "node_modules/\nsrc/generated/\n*.tsbuildinfo\n");
writeFileSync(join(project, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, incremental: true, module: "esnext", moduleResolution: "bundler", target: "es2022", skipLibCheck: true }, include: ["src/**/*.ts"] }, null, 2));
writeFileSync(join(project, "src", "generated", "db.ts"), "export type Row = { id: string };\n");
writeFileSync(join(project, "src", "server", "rules.ts"), 'import type { Row } from "../generated/db";\n// How long a booking may last, in days. Server rules: the team owns these.\nexport type LoanDays = 1 | 3 | 7;\nexport const longestLoan: LoanDays = 7;\nexport const sample: Row = { id: "r1" };\n');
writeFileSync(join(project, "src", "page.ts"), 'import { longestLoan, type LoanDays } from "./server/rules";\n// The words on the bookings page.\nexport const heading = "Bookings";\nexport const loanNote = (days: LoanDays = longestLoan) => `Borrow for up to ${days} days.`;\n');
// A banner the client may change, and a check elsewhere that holds its exact words: changing one breaks the other.
mkdirSync(join(project, "src", "ui"), { recursive: true });
mkdirSync(join(project, "src", "checks"), { recursive: true });
writeFileSync(join(project, "src", "ui", "banner.ts"), '// The banner across the top of every page.\nexport const banner = "Welcome";\n');
writeFileSync(join(project, "src", "checks", "banner-check.ts"), 'import { banner } from "../ui/banner";\n// The release checklist holds the banner to its approved words.\nexport const approved: "Welcome" = banner;\n');
symlinkSync(join(repoRoot, "node_modules"), join(project, "node_modules"), win ? "junction" : "dir");
git(project, "add", "-A");
git(project, "-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-q", "-m", "start");
git(project, "push", "-q", "origin", "HEAD:main");

const home = mkdtempSync(join(tmpdir(), "longtable-copycheck-home-"));
mkdirSync(join(home, "secrets"), { recursive: true });
copyFileSync(savedSignIn, join(home, "secrets", "claude-token.bin"));
const browser = await launch();
let runner = null;
try {
  const o = await startTable(browser, `copycheck-${Date.now().toString(36)}@example.test`, "Greeter", "Maya");
  const t = o.tableId;
  const tok = await accessToken(o.context);
  const code = (await rpc(tok, "start_pairing", { t, ai_kind: "claude" })).body;
  const env = { ...process.env, LONGTABLE_HOME: home, LONGTABLE_MODEL: "haiku", LONGTABLE_NO_UPDATE: "1" };
  const r = spawnSync(process.execPath, [bin, "connect", code, "--app", process.env.APP_URL || "http://localhost:3000", "--repo", project, "--no-autostart", "--no-run"], { env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  await tableRepo(t, remote);
  sql(`update public.jobs set status = 'skipped' where table_id = '${t}' and kind = 'intro'`);
  runner = spawn(process.execPath, [bin, "run"], { env, stdio: "ignore", windowsHide: true });
  await rpc(tok, "add_test_client", { t });
  const client = sql(`select id from public.members where table_id = '${t}' and test`);
  const branch = `longtable/sandbox-test-${client.slice(0, 8)}`;
  sql(`insert into public.table_sandbox (table_id) values ('${t}') on conflict do nothing`);
  sql(`insert into public.sandboxes (member_id, table_id, mode, branch, url) values ('${client}', '${t}', 'sandbox', '${branch}', 'https://copy.example.test')`);
  for (let i = 0; i < 30 && sql(`select count(*) from public.connections where table_id = '${t}' and last_seen > now() - interval '20 seconds'`) !== "1"; i++) await sleep(1000);
  const say = async (words) => {
    await rpc(tok, "client_say", { t, body: words });
    for (let i = 0; i < 240; i++) {
      await sleep(2000);
      const s = sql(`select status from public.sandbox_changes where member_id = '${client}' and words = '${words.replace(/'/g, "''")}'`);
      if (s && s !== "working") return s;
    }
    return "timed out";
  };
  const show = (f) => { try { return git(scratch, "--git-dir", remote, "show", `${branch}:${f}`); } catch { return null; } };

  const first = await say("Change the page heading from Bookings to Equipment bookings.");
  const log1 = readFileSync(join(home, "runner.log"), "utf8");
  check("a plain change lands in the copy", first === "ready" && /Equipment bookings/.test(show("src/page.ts") || ""), { first, page: show("src/page.ts") });
  check("it was type-checked first, seeing the generated code git ignores, and added no errors", /type check: 0 errors, 0 new/.test(log1), log1.split("\n").filter((l) => /type check/.test(l)));
  const tree = git(scratch, "--git-dir", remote, "ls-tree", "-r", "--name-only", branch);
  check("the copy never carries the check's leftovers", !/node_modules|generated|tsbuildinfo/.test(tree), tree);

  const second = await say("Let people borrow things for 14 days. On the page, make the longest loan 14 days.");
  const log2 = readFileSync(join(home, "runner.log"), "utf8");
  check("a change that would break the types, with its only fix in a server file, is not pushed", second === "passed" && !/14/.test(show("src/page.ts") || "") && !/14/.test(show("src/server/rules.ts") || ""),
    { second, page: show("src/page.ts"), rules: show("src/server/rules.ts"), log: log2.split("\n").filter((l) => /type check|passed|refused/.test(l)) });
  results.typeChecks = log2.split("\n").filter((l) => /type check|sandbox job/.test(l)).map((l) => l.slice(25));
  // Only the page's own folder is the client's to change: a banner change that breaks the checklist elsewhere is
  // caught by the type check, and cannot be fixed where the copy may write, so it is not pushed.
  sql(`update public.table_sandbox set paths = 'src/ui' where table_id = '${t}'`);
  const third = await say("Change the banner text from Welcome to Hello there.");
  const log3 = readFileSync(join(home, "runner.log"), "utf8");
  results.typeChecks = log3.split(String.fromCharCode(10)).filter((l) => /type check|sandbox job/.test(l)).map((l) => l.slice(25));
  check("the type check catches a change that breaks the types elsewhere", /type check: [1-9][0-9]* errors, [1-9][0-9]* new/.test(log3), results.typeChecks);
  check("and that change is never pushed to the copy", third !== "ready" && /Welcome/.test(show("src/ui/banner.ts") || ""), { third, banner: show("src/ui/banner.ts") });
  check("the client hears it went to the team", Number(sql(`select count(*) from public.sandbox_changes where member_id = '${client}' and status = 'passed' and summary <> ''`)) >= 1);
  check("their own folder is untouched by the check", existsSync(join(project, "src", "generated", "db.ts")) && existsSync(join(project, "node_modules", "typescript", "bin", "tsc")) && git(project, "status", "--porcelain") === "");
} catch (e) {
  check("the run did not crash", false, String(e?.stack || e).slice(0, 600));
} finally {
  if (runner) { if (win) spawnSync("taskkill", ["/PID", String(runner.pid), "/T", "/F"], { stdio: "ignore" }); else runner.kill(); }
  await browser.close();
  await sleep(800);
  try { const l = join(project, "node_modules"); if (existsSync(l)) { if (win) execFileSync("cmd", ["/c", "rmdir", l]); else rmSync(l); } } catch {}
  try { rmSync(home, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }); } catch {}
}
const failed = Object.entries(results).filter(([k, v]) => k !== "typeChecks" && v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
console.log(`${Object.keys(results).length - 1 - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
