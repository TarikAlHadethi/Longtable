// The git side of work, with no AI and no table: the connection's own functions against scratch repositories.
// What happens when two parts land on one branch, when they touch the same lines, when the branch was built on
// something else, when the table names a branch it should not, and when the repository cannot be reached.
//
//   node tests/e2e/unit-land.mjs

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "longtable-land-"));
process.env.LONGTABLE_HOME = join(scratch, "home");
mkdirSync(process.env.LONGTABLE_HOME, { recursive: true });
const { changedSoFar, freshCopy, neverCommit, openWork, landWork, safeBranch, workBranch } = await import("../../packages/connect/src/repo.mjs");

const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${typeof detail === "string" ? detail : JSON.stringify(detail ?? "")}`.slice(0, 500); };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const NL = String.fromCharCode(10);

function repo(name, files) {
  const remote = join(scratch, `${name}.git`);
  const seed = join(scratch, `${name}-seed`);
  git(scratch, "init", "-q", "--bare", "-b", "main", remote);
  git(scratch, "clone", "-q", remote, seed);
  for (const [f, text] of Object.entries(files)) { mkdirSync(join(seed, f, ".."), { recursive: true }); writeFileSync(join(seed, f), text); }
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-q", "-m", "start");
  git(seed, "push", "-q", "origin", "HEAD:main");
  return { remote, seed, url: "file:///" + remote.replace(/\\/g, "/") };
}
const show = (r, ref) => { try { return git(scratch, "--git-dir", r.remote, "show", ref); } catch { return null; } };
const branches = (r) => git(scratch, "--git-dir", r.remote, "branch", "--list").split(/\r?\n/).map((b) => b.replace(/^[* ]+/, "")).filter(Boolean);
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join(NL) + NL;

try {
  // ---- branch names the connection will and will not write to
  const bad = ["main", "master", "HEAD", "refs/heads/main", "longtable/", "longtable/../main", "longtable/a b", "longtable/A", "longtable/-x", "--upload-pack=x", "+longtable/x", "longtable/x:main", "longtable/x/y", "longtable/x.lock", "", null, undefined, 7, "longtable/" + "a".repeat(90)];
  const refused = bad.filter((b) => { try { safeBranch(b); return false; } catch { return true; } });
  check("a branch that is not a plain name under longtable/ is refused", refused.length === bad.length, bad.filter((b) => !refused.includes(b)));
  check("a branch the table makes is accepted", safeBranch("longtable/fix-the-login-redirect-1a2b3c4d") && safeBranch(workBranch("General")) === "longtable/general");

  // ---- one part, then a second on top
  const a = repo("a", { "one.txt": lines(20), "two.txt": lines(20), "README.md": "# A" + NL });
  freshCopy("t1", a.url);
  const B = "longtable/task-aaaa1111";
  let w = openWork("t1", B);
  check("a new task starts from the default branch, in a folder with no .git", !w.continued && !existsSync(join(w.dir, ".git")) && existsSync(join(w.dir, "one.txt")));
  check("nothing changed lands nothing", landWork("t1", w, B, "nothing", "Maya") === null && !branches(a).includes(B));
  writeFileSync(join(w.dir, "one.txt"), lines(20).replace("line 3", "line three"));
  writeFileSync(join(w.dir, "new.txt"), "new" + NL);
  let l = landWork("t1", w, B, "First part", "Maya");
  check("a change lands as one commit on the task's branch", l?.pushed && l.branch === B && l.files.sort().join() === "new.txt,one.txt" && show(a, `${B}:new.txt`) === "new", l);
  check("the default branch is untouched", show(a, "main:new.txt") === null && !show(a, "main:one.txt").includes("three"));
  check("the commit carries the request as its message, and no trailer", git(scratch, "--git-dir", a.remote, "log", "-1", "--format=%B", B) === "First part");

  w = openWork("t1", B);
  check("a follow-up starts from the task's branch", w.continued && readFileSync(join(w.dir, "one.txt"), "utf8").includes("line three"));
  writeFileSync(join(w.dir, "two.txt"), lines(20).replace("line 9", "line nine"));
  l = landWork("t1", w, B, "Second part", "Maya");
  check("and lands on top of it", l?.pushed && show(a, `${B}:two.txt`).includes("nine") && show(a, `${B}:one.txt`).includes("three"), l);

  // ---- two AIs on two computers, the same task, at the same time
  freshCopy("p1", a.url);
  freshCopy("p2", a.url);
  const C = "longtable/both-bbbb2222";
  const w1 = openWork("p1", C);
  const w2 = openWork("p2", C);
  writeFileSync(join(w1.dir, "one.txt"), lines(20).replace("line 2", "line TWO"));
  writeFileSync(join(w2.dir, "two.txt"), lines(20).replace("line 15", "line FIFTEEN"));
  const l1 = landWork("p1", w1, C, "Part one", "Maya");
  const l2 = landWork("p2", w2, C, "Part two", "Sam");
  check("two parts that touch different files end up on the one branch", l1.pushed && l2.pushed && !l2.apart && l2.branch === C && show(a, `${C}:one.txt`).includes("TWO") && show(a, `${C}:two.txt`).includes("FIFTEEN"), { l1, l2 });
  check("with no side branch", branches(a).filter((b) => b.startsWith(C)).length === 1, branches(a));

  // ---- the same file, different lines: still together
  const D = "longtable/same-file-cccc3333";
  const d1 = openWork("p1", D);
  const d2 = openWork("p2", D);
  writeFileSync(join(d1.dir, "one.txt"), lines(20).replace("line 2", "line TWO"));
  writeFileSync(join(d2.dir, "one.txt"), lines(20).replace("line 18", "line EIGHTEEN"));
  landWork("p1", d1, D, "Top", "Maya");
  const dl = landWork("p2", d2, D, "Bottom", "Sam");
  const merged = show(a, `${D}:one.txt`);
  check("two parts in the same file on different lines are put together", dl.pushed && !dl.apart && merged.includes("TWO") && merged.includes("EIGHTEEN"), dl);

  // ---- the same lines: the second part goes beside, and nothing is overwritten
  const E = "longtable/clash-dddd4444";
  const e1 = openWork("p1", E);
  const e2 = openWork("p2", E);
  writeFileSync(join(e1.dir, "one.txt"), lines(20).replace("line 5", "Maya's five"));
  writeFileSync(join(e2.dir, "one.txt"), lines(20).replace("line 5", "Sam's five"));
  landWork("p1", e1, E, "Maya's", "Maya");
  const el = landWork("p2", e2, E, "Sam's", "Sam");
  check("two parts on the same lines: the second goes to a branch beside it", el.pushed && el.apart && el.branch === `${E}-sam` && show(a, `${E}:one.txt`).includes("Maya's five") && show(a, `${E}-sam:one.txt`).includes("Sam's five"), el);
  // A name with no Latin letters in it still gives a plain branch name of its own.
  const e3 = openWork("p2", E);
  writeFileSync(join(e3.dir, "one.txt"), lines(20).replace("line 5", "Third five"));
  const el3 = landWork("p2", { ...e3, base: e2.base }, E, "A third", "Ελένη");
  let plainName = false;
  try { plainName = safeBranch(el3.branch) === el3.branch; } catch {}
  check("a part set beside the branch for someone whose name has no Latin letters still gets a plain branch name", el3.pushed && el3.apart && plainName && !el3.branch.endsWith("-"), el3);
  // A side branch from a branch name at its longest comes out longer than the connection's own rule: the tripwire
  // says so in the log, and the part still lands where it did before.
  const L = "longtable/" + "l".repeat(80);
  const l1w = openWork("p1", L);
  const l2w = openWork("p2", L);
  writeFileSync(join(l1w.dir, "one.txt"), lines(20).replace("line 5", "Long one"));
  writeFileSync(join(l2w.dir, "one.txt"), lines(20).replace("line 5", "Long two"));
  landWork("p1", l1w, L, "First", "Maya");
  const runnerLog = join(process.env.LONGTABLE_HOME, "runner.log");
  const tripsBefore = existsSync(runnerLog) ? readFileSync(runnerLog, "utf8").split("tripwire:").length : 1;
  const ll = landWork("p2", l2w, L, "Second", "Sam");
  const tripsAfter = existsSync(runnerLog) ? readFileSync(runnerLog, "utf8").split("tripwire:").length : 1;
  check("a side branch longer than the connection's rule trips the wire and the part still lands", ll.pushed && ll.apart && tripsAfter === tripsBefore + 1, { ll, tripsBefore, tripsAfter });

  // ---- the default branch moved between the two starts: never a quiet undo
  const b = repo("b", { "app.txt": lines(20), "hot.txt": "old" + NL });
  freshCopy("q1", b.url);
  const F = "longtable/moved-eeee5555";
  const f1 = openWork("q1", F);
  // Someone fixes something on main in between.
  writeFileSync(join(b.seed, "hot.txt"), "HOTFIX" + NL);
  writeFileSync(join(b.seed, "added.txt"), "added on main" + NL);
  git(b.seed, "add", "-A");
  git(b.seed, "-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-q", "-m", "hotfix");
  git(b.seed, "push", "-q", "origin", "HEAD:main");
  freshCopy("q2", b.url);
  const f2 = openWork("q2", F);
  writeFileSync(join(f1.dir, "app.txt"), lines(20).replace("line 1" + NL, "first" + NL));
  writeFileSync(join(f2.dir, "app.txt"), lines(20).replace("line 20", "last"));
  landWork("q2", f2, F, "Built on the new main", "Sam");
  const fl = landWork("q1", f1, F, "Built on the old main", "Maya");
  const app = show(b, `${F}:app.txt`);
  check("a part built on an older main joins one built on a newer main without undoing the newer main", fl.pushed && !fl.apart && show(b, `${F}:hot.txt`) === "HOTFIX"
    && show(b, `${F}:added.txt`) === "added on main" && app.startsWith("first") && app.includes("last"), { fl, hot: show(b, `${F}:hot.txt`) });

  // The other order: the older one lands first, then the one built on the newer main. That one's starting point is
  // not in the branch's past, so putting them together would undo things: it goes beside instead.
  const J = "longtable/moved-back-eeee7777";
  const j2 = openWork("q2", J);
  writeFileSync(join(j2.dir, "app.txt"), lines(20).replace("line 20", "last"));
  // q1's copy is still on the old main: that is the whole point.
  const j1 = { ...openWork("q1", J), base: f1.base };
  git(scratch, "--git-dir", join(process.env.LONGTABLE_HOME, "copies", "q1", ".git"), "--work-tree", j1.dir, "read-tree", f1.base);
  execFileSync("git", ["--git-dir", join(process.env.LONGTABLE_HOME, "copies", "q1", ".git"), "--work-tree", j1.dir, "checkout-index", "-a", "-f", "-u"],
    { cwd: j1.dir, env: { ...process.env, GIT_INDEX_FILE: join(process.env.LONGTABLE_HOME, "work", "q1.index") } });
  rmSync(join(j1.dir, "added.txt"), { force: true });
  writeFileSync(join(j1.dir, "hot.txt"), "old" + NL);
  writeFileSync(join(j1.dir, "app.txt"), lines(20).replace("line 1" + NL, "first" + NL));
  const jl1 = landWork("q1", j1, J, "Built on the old main", "Maya");
  const jl2 = landWork("q2", j2, J, "Built on the new main", "Sam");
  check("a part whose starting point is not in the branch's past goes beside it, never into a quiet undo", jl1.pushed && jl2.pushed && jl2.apart
    && show(b, `${jl2.branch}:hot.txt`) === "HOTFIX" && show(b, `${jl2.branch}:added.txt`) === "added on main", { jl1, jl2 });

  // ---- what the AI might leave in the folder
  const G = "longtable/odd-ffff6666";
  const g = openWork("t1", G);
  mkdirSync(join(g.dir, ".git", "hooks"), { recursive: true });
  writeFileSync(join(g.dir, ".git", "hooks", "pre-push"), "#!/bin/sh" + NL + "touch " + join(scratch, "HOOK_RAN").replace(/\\/g, "/") + NL);
  writeFileSync(join(g.dir, ".git", "config"), "[core]" + NL + "\tsshCommand = touch HOOK_RAN" + NL);
  writeFileSync(join(g.dir, ".gitattributes"), "*.txt filter=evil" + NL);
  writeFileSync(join(g.dir, "ok.txt"), "fine" + NL);
  const gl = landWork("t1", g, G, "With a planted .git", "Maya");
  const tree = git(scratch, "--git-dir", a.remote, "ls-tree", "-r", "--name-only", G).split(/\r?\n/);
  check("a .git the AI wrote is never run and never committed", gl.pushed && !existsSync(join(scratch, "HOOK_RAN")) && !tree.some((f) => f.startsWith(".git/")) && tree.includes("ok.txt"), tree);

  const H = "longtable/empty-99990000";
  const h = openWork("t1", H);
  for (const f of ["one.txt", "two.txt", "README.md"]) rmSync(join(h.dir, f), { force: true });
  const hl = landWork("t1", h, H, "Deleted everything", "Maya");
  check("an AI that deletes everything only empties its own branch", hl.pushed && show(a, "main:README.md") === "# A" && git(scratch, "--git-dir", a.remote, "ls-tree", "-r", "--name-only", H) === "", hl);

  // ---- a hostile branch name from the table never reaches git
  let threw = 0;
  for (const name of ["main", "refs/heads/main", "--force", "longtable/x:refs/heads/main"]) {
    try { openWork("t1", name); } catch { threw++; }
    try { landWork("t1", g, name, "x", "Maya"); } catch { threw++; }
  }
  check("opening or landing on a branch outside longtable/ throws before any git runs", threw === 8 && show(a, "main:new.txt") === null, threw);

  // ---- the repository goes away
  const c = repo("c", { "f.txt": "x" + NL });
  freshCopy("r1", c.url);
  const I = "longtable/gone-12345678";
  const i1 = openWork("r1", I);
  writeFileSync(join(i1.dir, "f.txt"), "changed" + NL);
  rmSync(c.remote, { recursive: true, force: true });
  const il = landWork("r1", i1, I, "Nowhere to push", "Maya");
  const kept = (() => { try { return git(scratch, "--git-dir", join(process.env.LONGTABLE_HOME, "copies", "r1", ".git"), "rev-parse", "--short", `refs/longtable/${I.slice(10)}`); } catch { return null; } })();
  check("a push that cannot happen is said plainly, and the commit is kept on this computer", il.pushed === false && kept === il.commit, { il, kept });
  let stopped = false;
  try { openWork("r1", I); } catch (e) { stopped = /could not reach/.test(e.message); }
  check("a repository that cannot be reached stops the job instead of starting from the wrong code", stopped);

  // ---- what one job was given to read is still there when the copy is refreshed for another
  const d = repo("d", { "f.txt": "x" + NL });
  const copy = freshCopy("y1", d.url).dir;
  mkdirSync(join(copy, ".longtable-yours"), { recursive: true });
  writeFileSync(join(copy, ".longtable-yours", "memory.md"), "mine" + NL);
  writeFileSync(join(copy, "stray.txt"), "stray" + NL);
  freshCopy("y1", d.url);
  check("refreshing the copy clears strays but leaves what a job that is reading was given", existsSync(join(copy, ".longtable-yours", "memory.md")) && !existsSync(join(copy, "stray.txt")));
  const { packCode } = await import("../../packages/connect/src/pack.mjs");
  const packed = packCode(copy, "memory mine");
  check("and what was left there is never in the pack a ChatGPT seat is handed", packed.files.includes("f.txt") && !packed.text.includes("longtable-yours") && !packed.text.includes("mine"), packed);

  // ---- the repository's address changed after the copy was made
  const far = repo("far", { "f.txt": "moved" + NL });
  const moved = freshCopy("y1", far.url);
  check("when the project's address changes, the copy follows it", git(moved.dir, "remote", "get-url", "origin") === far.url && readFileSync(join(moved.dir, "f.txt"), "utf8").startsWith("moved"), git(moved.dir, "remote", "get-url", "origin"));

  // ---- what is the person's alone is never committed, even when git made the copy without its usual folders
  const own = repo("own", { "f.txt": "x" + NL });
  freshCopy("n1", own.url);
  rmSync(join(process.env.LONGTABLE_HOME, "copies", "n1", ".git", "info"), { recursive: true, force: true });
  neverCommit("n1", ".longtable-yours");
  const N = "longtable/task-eeee5555";
  const nw = openWork("n1", N);
  mkdirSync(join(nw.dir, ".longtable-yours"), { recursive: true });
  writeFileSync(join(nw.dir, ".longtable-yours", "memory.md"), "mine alone" + NL);
  writeFileSync(join(nw.dir, "f.txt"), "changed" + NL);
  const nl = landWork("n1", nw, N, "A change", "Maya");
  check("the folder that is the person's alone is left out of the commit whatever git's own set-up", nl?.pushed && nl.files.join() === "f.txt" && show(own, `${N}:.longtable-yours/memory.md`) === null, nl);
  // When the list cannot be written at all, the table hears one plain sentence and the cause stays in the log here.
  freshCopy("n2", own.url);
  const info = join(process.env.LONGTABLE_HOME, "copies", "n2", ".git", "info");
  rmSync(info, { recursive: true, force: true });
  writeFileSync(info, "in the way" + NL);
  let said = "";
  try { neverCommit("n2", ".longtable-yours"); } catch (e) { said = e.message; }
  const logFile = join(process.env.LONGTABLE_HOME, "runner.log");
  const logged = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  check("when the list cannot be written the job stops with one plain sentence that names no folder, and the cause is in the log on that computer",
    /alone/.test(said) && !/[\\/:]|EEXIST|ENOTDIR|ENOENT/.test(said) && !said.includes(NL) && /never committed for n2/.test(logged), { said, logged: logged.slice(-300) });

  // ---- file names with letters outside plain English are read as they are, not as git writes them when it quotes
  const acc = repo("acc", { "café/next.config.js": "module.exports = {};" + NL, "café/page.tsx": "old" + NL });
  freshCopy("q1", acc.url);
  const Q = "longtable/task-ffff6666";
  const qw = openWork("q1", Q);
  rmSync(join(qw.dir, "café", "next.config.js"));
  writeFileSync(join(qw.dir, "café", "page.tsx"), "new" + NL);
  const seen = changedSoFar("q1", qw);
  check("a changed file with an accented name is read, and a deleted one is named as it is", !seen.unread && seen.text.includes("new") && seen.files.includes("café/page.tsx") && seen.gone.includes("café/next.config.js"), seen);
} catch (e) {
  check("the run did not crash", false, e.stack || String(e));
} finally {
  try { rmSync(scratch, { recursive: true, force: true }); } catch {}
}

const failed = Object.values(results).filter((v) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
