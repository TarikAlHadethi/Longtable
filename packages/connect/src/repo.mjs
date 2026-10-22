// The connection's own clean copy of the team's code: the latest main, never the person's work folder.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { home, log } from "./store.mjs";

// Git never stops to ask for a name or password here: if this computer's saved sign-in cannot reach a repository,
// the command fails and the connection says so.
const quiet = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
const git = (args, cwdOrEnv) => execFileSync("git", args, { cwd: typeof cwdOrEnv === "string" ? cwdOrEnv : undefined, env: typeof cwdOrEnv === "object" && cwdOrEnv ? cwdOrEnv : quiet, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 120000 }).toString().trim();

export function canReach(source) {
  try {
    git(["ls-remote", "--exit-code", source, "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

// Given a folder or a git address, find where to copy from. For a folder: the folder's own history, which is still
// only committed work. Never whatever the folder happens to call origin: that can be somebody else's repository (a
// client's), and the team's work must never land there. Where the team shares its code is the table's repository,
// set once in Longtable. An address that cannot be reached is an error, said before anything else happens.
export function resolveSource(repo) {
  if (!repo) return null;
  if (isAddress(repo)) {
    if (!canReach(repo)) throw new Error(`This computer's git cannot open ${repo}. Sign in to git for it, or open your AI in the project's own folder and connect from there.`);
    return repo;
  }
  const folder = resolve(repo);
  if (!existsSync(join(folder, ".git"))) throw new Error(`${folder} is not a git repository`);
  return fileAddress(folder);
}

// A folder on this computer as a file:// address (file:///C:/x on Windows, file:///home/x elsewhere, where a path
// already starts with "/"), and back. Written plainly, as git takes it: spaces are not encoded.
export const fileAddress = (folder) => { const p = String(folder).replace(/\\/g, "/"); return "file://" + (p.startsWith("/") ? "" : "/") + p; };
export const fileFolder = (address) => {
  const s = String(address || "");
  if (!/^file:\/\//i.test(s)) return null;
  const p = s.replace(/^file:\/\//i, "");
  return /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p;
};

export const isAddress = (s) => /^(https?:|git@|ssh:|file:)/i.test(String(s || ""));

// One repository written two ways is still one: https and ssh, with or without .git, any case in the host.
export function addressKey(a) {
  let s = String(a || "").trim();
  // A repository on this computer, as a file:// address or a plain path (what git writes for a clone of one).
  if (/^file:/i.test(s) || /^([A-Za-z]:[\\/]|\/)/.test(s)) {
    let p = s;
    if (/^file:/i.test(p)) { try { p = fileURLToPath(p); } catch { return null; } }
    // Windows paths are the same in any case; elsewhere a path's case is part of it.
    const key = resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").replace(/\.git$/i, "");
    return "file:" + (process.platform === "win32" ? key.toLowerCase() : key);
  }
  if (!isAddress(s)) return null;
  s = s.replace(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\//i, "$1/").replace(/^git@([^:]+):/i, "$1/").replace(/^https?:\/\/(?:[^@/]+@)?/i, "");
  s = s.replace(/\/+$/, "").replace(/\.git$/i, "");
  const [host, ...rest] = s.split("/");
  return rest.length ? `${host.toLowerCase()}/${rest.join("/").toLowerCase()}` : null;
}
export const sameAddress = (a, b) => { const x = addressKey(a); return !!x && x === addressKey(b); };

// The remotes a folder's git knows: name, address, and whether it has a push address of its own.
// Addresses as git itself resolves them, the person's own url.*.insteadOf shortcuts applied (gh:team/app).
// Read again only when the folder's git config has changed since: every job asks, some twice.
const remotesSeen = new Map();
export function remotesOf(folder) {
  let stamp = null;
  try { const st = statSync(join(folder, ".git", "config")); stamp = `${st.mtimeMs}:${st.size}`; } catch {}
  const seen = remotesSeen.get(folder);
  if (stamp && seen?.stamp === stamp) return seen.list;
  const list = readRemotes(folder);
  if (stamp) remotesSeen.set(folder, { stamp, list });
  return list;
}
function readRemotes(folder) {
  let names = [];
  try { names = git(["-C", folder, "remote"]).split(/\r?\n/).filter(Boolean); } catch { return []; }
  return names.map((name) => {
    const list = (args) => { try { return git(["-C", folder, "remote", "get-url", ...args, name]).split(/\r?\n/).filter(Boolean); } catch { return []; } };
    let pushurl = false;
    try { pushurl = git(["-C", folder, "config", "--get-all", `remote.${name}.pushurl`]) !== ""; } catch {}
    return { name, urls: [...new Set([...list(["--all"]), ...list(["--push", "--all"])])], pushurl };
  });
}

// Where a run in the person's own folder may push: only to the table's repository (any of the folder's remotes that is
// it), unless they let it push anywhere. With no table repository, nowhere. A remote with a push address of its own is
// outside git's rewrite, so when one points anywhere else, pushing is refused outright (noPush).
export function pushPlan(folder, repo, anywhere) {
  if (anywhere) return { pushTo: null, noPush: false };
  const remotes = remotesOf(folder);
  const ok = (u) => !!repo && sameAddress(u, repo);
  // Each address with and without its .git, since git is given exact addresses and refuses anything longer.
  const twins = (u) => { const bare = u.replace(/\/+$/, "").replace(/\.git$/i, ""); return [bare, `${bare}.git`]; };
  const pushTo = repo ? [...new Set([repo, ...remotes.flatMap((r) => r.urls.filter(ok))].flatMap(twins))] : [];
  return { pushTo, noPush: remotes.some((r) => r.pushurl && !r.urls.every(ok)) };
}

// The folder a connection keeps as its person's own: the one it was connected from. Connected with an address, the
// folder it ran in is kept only when it is that same project (one of its remotes is the address): an AI opened
// anywhere else has no folder of its person's to work in.
export function folderFor(repo, cwd) {
  if (!isAddress(repo)) return resolve(repo || cwd);
  try {
    if (!existsSync(join(cwd, ".git"))) return null;
    return remotesOf(cwd).some((r) => r.urls.some((u) => sameAddress(u, repo))) ? resolve(cwd) : null;
  } catch { return null; }
}

// The table's repository, when this person's connection may use it: they connected with that address, or they said
// yes to exactly that address in their AI's window (`agreed`) and their own folder's git knows it. Never on the
// table's word alone: anyone who may change settings could otherwise send this person's AI's work to any repository
// their folder can reach (a client's, named as origin). A changed address needs their yes again.
export function trustedRepo(seat, repo, agreed) {
  if (!repo || !isAddress(repo) || !addressKey(repo) || /^(https|ssh):\/\/[^/]*@/i.test(repo)) return null;
  if (sameAddress(seat.source, repo)) return repo;
  if (agreed === repo && seat.folder && remotesOf(seat.folder).some((r) => r.urls.some((u) => sameAddress(u, repo)))) return repo;
  return null;
}

// Where this job reads the team's code from and lands its branches: the trusted table repository, else what this
// connection was connected with. Changing the table's repository takes effect without connecting again.
export function sourceFor(seat, repo, agreed) {
  const t = trustedRepo(seat, repo, agreed);
  return t && !sameAddress(seat.source, t) ? t : seat.source;
}

// Bring the copy up to the latest default branch. Symlinks are checked out as plain files, so a link in the
// repository can never point the AI at a file outside the copy.
export function freshCopy(tableId, source) {
  const dir = join(home, "copies", safeTable(tableId));
  if (!source) {
    mkdirSync(dir, { recursive: true });
    return { dir, read: "no code connected" };
  }
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(join(home, "copies"), { recursive: true });
    git(["clone", "--quiet", "--depth", "1", "--no-tags", "-c", "core.symlinks=false", source, dir]);
  } else {
    // The address may have changed since the copy was made (connected again after fixing git's sign-in, or the
    // repository moved): fetch from, and later push to, where the project is now.
    git(["-C", dir, "remote", "set-url", "origin", source]);
    git(["-C", dir, "fetch", "--quiet", "--depth", "1", "--no-tags", "origin", "HEAD"]);
    git(["-C", dir, "reset", "--quiet", "--hard", "FETCH_HEAD"]);
    // The folder laid beside the code for an AI to read stays: a job that only reads may be in the middle of it
    // while the copy is refreshed for long work in the other lane. Each job clears and lays it for itself.
    git(["-C", dir, "clean", "-qfdx", "-e", ".longtable-yours"]);
  }
  const branch = git(["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
  const head = git(["-C", dir, "rev-parse", "--short", "HEAD"]);
  return { dir, read: `${branch === "HEAD" ? "main" : branch} @ ${head}` };
}

// Work the team asked for happens in a second folder that holds the files and nothing else: no .git inside it, so
// nothing the AI writes there can change what git itself runs. Git reaches it from outside, with its own index.
const places = (tableId, name = "work") => ({ G: join(home, "copies", safeTable(tableId), ".git"), W: join(home, name, safeTable(tableId)), I: join(home, name, `${safeTable(tableId)}.index`) });
// File names come back as they are. Left to itself git writes a name with letters outside plain English in quotes
// with numbers for the letters, and then the name is neither a file that can be read nor one a rule can match.
const wgit = (p, args, env = {}) => execFileSync("git", ["-c", "core.quotePath=false", "--git-dir", p.G, "--work-tree", p.W, ...args],
  { cwd: p.W, env: { ...quiet, GIT_INDEX_FILE: p.I, ...env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 120000 }).toString().trim();

// Whatever the table names, the connection only ever writes to a plain branch under longtable/. Never the default
// branch, never anything that is not a simple name: this holds even if the server it talks to is not the real one.
export function safeBranch(b) {
  if (typeof b !== "string" || !/^longtable\/[a-z0-9][a-z0-9-]{0,79}$/.test(b)) throw new Error("the table named a branch this connection will not write to");
  return b;
}

// A table's id becomes a folder name on this computer, so it must be one: a server that is not the real one could
// otherwise name "../../somewhere" and have that folder written to or wiped.
export function safeTable(t) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(t))) throw new Error("the table named itself in a way this connection will not use as a folder");
  return t;
}

export const workBranch = (chatName) => "longtable/" + (String(chatName || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "work");

// A folder laid beside the code for the AI to read, and never to be committed: the repository's own exclude list says so.
export function neverCommit(tableId, name) {
  const file = join(home, "copies", safeTable(tableId), ".git", "info", "exclude");
  // Git does not always make the info folder (a person's own template may leave it out). If the list cannot be
  // written this throws and the job stops: better no answer than their own notes pushed to the team's branch.
  try {
    mkdirSync(join(home, "copies", safeTable(tableId), ".git", "info"), { recursive: true });
    const now = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (!now.split(/\r?\n/).includes(`${name}/`)) writeFileSync(file, `${now}${now.endsWith(String.fromCharCode(10)) || !now ? "" : String.fromCharCode(10)}${name}/${String.fromCharCode(10)}`);
  } catch (e) {
    // The table is sent one plain sentence. What the system said names folders on this person's computer, so that
    // stays in the log here, where they can read it.
    log(`could not write the list of what is never committed for ${tableId}: ${e.message}`);
    throw new Error("could not set aside what is this person's alone on their computer, so nothing was done; the connection's log there says why");
  }
}

// Lay out the files to work on: the chat's own branch when it already exists, so one request builds on the last,
// else the latest default branch.
// Whether this computer's git can put two parts of work together on one branch (merge-tree --write-tree, git 2.38
// and later). An older git still works: a part goes on its own branch beside the other, as when two parts touch the
// same lines. "version" is what git says of itself, for the person to be told.
export function gitCanJoin(said) {
  let version = said;
  try { version ??= execFileSync("git", ["--version"], { encoding: "utf8", windowsHide: true }).trim(); } catch { return { ok: false, version: "no git found" }; }
  const m = String(version).match(/(\d+)\.(\d+)/);
  const ok = !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 38));
  return { ok, version };
}

// Everything the connection keeps of these tables' code on this computer: the clean copies, the work and reading
// folders, and the kept copies of folders a person pointed at. Done after the connection has stopped; a file still
// held for a moment is tried again.
export function forgetCopies(tableIds, folders = []) {
  const gone = (p) => { try { rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (e) { log(`could not remove ${p}: ${e.message}`); } };
  for (const t of tableIds) {
    let safe;
    try { safe = safeTable(t); } catch { continue; }
    for (const place of ["copies", "work", "look", "trees"]) gone(join(home, place, safe));
  }
  gone(join(home, "pointed"));
  // The person's own repositories forget the worktrees full Claude Code made in them, now their folders are gone.
  for (const f of folders) { try { if (existsSync(join(f, ".git"))) execFileSync("git", ["-C", f, "worktree", "prune"], { windowsHide: true, stdio: "ignore" }); } catch {} }
}

export function openWork(tableId, branch, name = "work", { refresh = false } = {}) {
  safeBranch(branch);
  const p = places(tableId, name);
  rmSync(p.W, { recursive: true, force: true });
  rmSync(p.I, { force: true });
  mkdirSync(p.W, { recursive: true });
  let base = git(["--git-dir", p.G, "rev-parse", "HEAD"]);
  let continued = false;
  // "There is no such branch yet" and "the repository could not be reached" are different things. Only the first
  // means start from the default branch; the second stops the job, or a follow-up would be built on the wrong code.
  let exists = false;
  try {
    git(["--git-dir", p.G, "ls-remote", "--exit-code", "origin", `refs/heads/${branch}`]);
    exists = true;
  } catch (e) {
    if (e.status !== 2) throw new Error("this computer could not reach the project's repository");
  }
  if (exists) {
    git(["--git-dir", p.G, "fetch", "--quiet", "--depth", "1", "--no-tags", "origin", `refs/heads/${branch}`]);
    base = git(["--git-dir", p.G, "rev-parse", "FETCH_HEAD"]);
    continued = true;
  }
  // A client's sandbox lives a long time, so each time it is opened it takes in what the team has shipped since.
  // If the two no longer fit together it stays as it is and says so: the team's work is never bent to fit it.
  let stale = false;
  if (refresh && continued) {
    const main = git(["--git-dir", p.G, "rev-parse", "HEAD"]);
    try {
      git(["--git-dir", p.G, "fetch", "--quiet", "--no-tags", "--depth", "400", "origin", "HEAD", `refs/heads/${branch}`]);
      const common = git(["--git-dir", p.G, "merge-base", main, base]);
      if (common !== main) {
        const both = git(["--git-dir", p.G, "merge-tree", "--write-tree", `--merge-base=${common}`, base, main]).split(/\r?\n/)[0];
        base = git(["--git-dir", p.G, "commit-tree", both, "-p", base, "-p", main, "-m", "Take in the team's latest"],
          { ...quiet, GIT_AUTHOR_NAME: "Longtable", GIT_AUTHOR_EMAIL: "longtable@users.noreply.github.com", GIT_COMMITTER_NAME: "Longtable", GIT_COMMITTER_EMAIL: "longtable@users.noreply.github.com" });
      }
    } catch {
      stale = true;
    }
  }
  wgit(p, ["read-tree", base]);
  // -u records each file's size and time in the index, so finding what changed later does not reread every file.
  wgit(p, ["checkout-index", "-a", "-f", "-u"]);
  return { dir: p.W, base, continued, stale };
}

// What was changed in the work folder, before anything is committed: every file touched (a rename counts as both
// names), and the whole of each one as it now stands. If any of it cannot be read, that is said, and the caller
// treats it as a refusal: this check fails closed.
export function changedSoFar(tableId, work) {
  const p = places(tableId);
  wgit(p, ["add", "-A"]);
  const files = wgit(p, ["diff", "--cached", "--no-renames", "--name-only", work.base]).split(/\r?\n/).filter(Boolean);
  const gone = wgit(p, ["diff", "--cached", "--no-renames", "--name-only", "--diff-filter=D", work.base]).split(/\r?\n/).filter(Boolean);
  let text = "";
  let unread = false;
  for (const f of files) {
    if (gone.includes(f)) continue;
    try {
      const body = readFileSync(join(p.W, f));
      if (body.length > 2 * 1024 * 1024 || body.includes(0)) { unread = true; continue; }
      text += String.fromCharCode(10) + body.toString("utf8");
    } catch { unread = true; }
  }
  return { files, gone, text, unread };
}

// Make the place for a copy: its branch, pushed with one empty commit of its own on top of the latest default branch,
// so the hosting sees something new and puts it up. If the branch is already there, it is left as it is.
// With fresh, a copy that already exists is put back to the product as it stands: one more commit on top, holding the
// default branch's files, so whatever was tried in it before is gone from what the hosting puts up.
export function openBranch(tableId, branch, fresh = false) {
  safeBranch(branch);
  const G = join(home, "copies", safeTable(tableId), ".git");
  try {
    git(["--git-dir", G, "ls-remote", "--exit-code", "origin", `refs/heads/${branch}`]);
    git(["--git-dir", G, "fetch", "--quiet", "--depth", "1", "--no-tags", "origin", `refs/heads/${branch}`]);
    const tip = git(["--git-dir", G, "rev-parse", "FETCH_HEAD"]);
    if (!fresh) return tip;
    const clean = git(["--git-dir", G, "rev-parse", "HEAD^{tree}"]);
    if (git(["--git-dir", G, "rev-parse", `${tip}^{tree}`]) === clean) return tip;
    const as = { ...quiet, GIT_AUTHOR_NAME: "Longtable", GIT_AUTHOR_EMAIL: "longtable@users.noreply.github.com", GIT_COMMITTER_NAME: "Longtable", GIT_COMMITTER_EMAIL: "longtable@users.noreply.github.com" };
    const again = git(["--git-dir", G, "commit-tree", clean, "-p", tip, "-m", "A clean copy"], as);
    git(["--git-dir", G, "push", "--quiet", "origin", `${again}:refs/heads/${branch}`]);
    return again;
  } catch (e) {
    if (e.status !== 2) throw new Error("this computer could not reach the project's repository");
  }
  const head = git(["--git-dir", G, "rev-parse", "HEAD"]);
  const tree = git(["--git-dir", G, "rev-parse", `${head}^{tree}`]);
  const who = { ...quiet, GIT_AUTHOR_NAME: "Longtable", GIT_AUTHOR_EMAIL: "longtable@users.noreply.github.com", GIT_COMMITTER_NAME: "Longtable", GIT_COMMITTER_EMAIL: "longtable@users.noreply.github.com" };
  const commit = git(["--git-dir", G, "commit-tree", tree, "-p", head, "-m", "A copy of its own"], who);
  git(["--git-dir", G, "push", "--quiet", "origin", `${commit}:refs/heads/${branch}`]);
  return commit;
}

const LONGTABLE = { ...quiet, GIT_AUTHOR_NAME: "Longtable", GIT_AUTHOR_EMAIL: "longtable@users.noreply.github.com", GIT_COMMITTER_NAME: "Longtable", GIT_COMMITTER_EMAIL: "longtable@users.noreply.github.com" };

// A client's copy brought up to what the team has shipped, their own changes kept on top, and pushed. Nothing moves
// when it is already current; when the two no longer fit together it stays as it is and says so (stale).
export function refreshBranch(tableId, branch) {
  safeBranch(branch);
  const G = join(home, "copies", safeTable(tableId), ".git");
  try { git(["--git-dir", G, "ls-remote", "--exit-code", "origin", `refs/heads/${branch}`]); }
  catch (e) { if (e.status === 2) return null; throw new Error("this computer could not reach the project's repository"); }
  const main = git(["--git-dir", G, "rev-parse", "HEAD"]);
  git(["--git-dir", G, "fetch", "--quiet", "--no-tags", "--depth", "400", "origin", "HEAD"]);
  git(["--git-dir", G, "fetch", "--quiet", "--no-tags", "--depth", "400", "origin", `refs/heads/${branch}`]);
  const tip = git(["--git-dir", G, "rev-parse", "FETCH_HEAD"]);
  let common;
  try { common = git(["--git-dir", G, "merge-base", main, tip]); } catch { return { commit: tip, moved: false, stale: true }; }
  if (common === main) return { commit: tip, moved: false, stale: false };
  let tree;
  try { tree = git(["--git-dir", G, "merge-tree", "--write-tree", `--merge-base=${common}`, tip, main]).split(/\r?\n/)[0]; }
  catch { return { commit: tip, moved: false, stale: true }; }
  const commit = git(["--git-dir", G, "commit-tree", tree, "-p", tip, "-p", main, "-m", "Take in the team's latest"], LONGTABLE);
  git(["--git-dir", G, "push", "--quiet", "origin", `${commit}:refs/heads/${branch}`]);
  return { commit, moved: true, stale: false };
}

// One change taken back out of a client's copy: what that commit did is undone on top of everything since, and pushed.
// A change that later ones have built on so that it cannot come out cleanly is left, and that is said (null).
export function undoCommit(tableId, branch, sha, words = "") {
  safeBranch(branch);
  if (!/^[0-9a-f]{7,40}$/.test(String(sha || ""))) return null;
  const G = join(home, "copies", safeTable(tableId), ".git");
  try { git(["--git-dir", G, "fetch", "--quiet", "--no-tags", "--depth", "400", "origin", `refs/heads/${branch}`]); }
  catch { throw new Error("this computer could not reach the project's repository"); }
  const tip = git(["--git-dir", G, "rev-parse", "FETCH_HEAD"]);
  let full;
  try { full = git(["--git-dir", G, "rev-parse", "--verify", `${sha}^{commit}`]); } catch { return null; }
  // Only a change that is really on the copy's branch.
  try { git(["--git-dir", G, "merge-base", "--is-ancestor", full, tip]); } catch { return null; }
  let tree;
  try { tree = git(["--git-dir", G, "merge-tree", "--write-tree", `--merge-base=${full}`, tip, `${full}^`]).split(/\r?\n/)[0]; }
  catch { return null; }
  if (tree === git(["--git-dir", G, "rev-parse", `${tip}^{tree}`])) return tip;
  const said = String(words || "").split(/\r?\n/)[0].slice(0, 60);
  const commit = git(["--git-dir", G, "commit-tree", tree, "-p", tip, "-m", `Take back: ${said || "a change"}`], LONGTABLE);
  git(["--git-dir", G, "push", "--quiet", "origin", `${commit}:refs/heads/${branch}`]);
  return commit;
}

// One commit of a sandbox, as a patch the team's AI can read to see what the client ended up with.
export function patchOf(tableId, branch, commit) {
  safeBranch(branch);
  if (!/^[0-9a-f]{7,40}$/.test(String(commit || ""))) return "";
  const G = join(home, "copies", safeTable(tableId), ".git");
  try {
    // The commit itself, by its full name; a host that will not serve one commit gets the branch asked for instead.
    try { git(["--git-dir", G, "fetch", "--quiet", "--no-tags", "--depth", "2", "origin", commit]); }
    catch { git(["--git-dir", G, "fetch", "--quiet", "--no-tags", "--depth", "400", "origin", `refs/heads/${branch}`]); }
    return execFileSync("git", ["--git-dir", G, "show", "--format=", "--stat", "--patch", commit],
      { env: quiet, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 120000, maxBuffer: 64 * 1024 * 1024 }).toString().slice(0, 80000);
  } catch {
    return "";
  }
}

// Whatever changed becomes one commit on the chat's branch, pushed for the team to look at. Never the default branch.
export function landWork(tableId, work, branch, message, who) {
  safeBranch(branch);
  const p = places(tableId);
  wgit(p, ["add", "-A"]);
  const files = wgit(p, ["diff", "--cached", "--name-only", work.base]).split(/\r?\n/).filter(Boolean);
  if (!files.length) return null;
  const tree = wgit(p, ["write-tree"]);
  let name = "";
  let email = "";
  try { name = git(["--git-dir", p.G, "config", "user.name"]); email = git(["--git-dir", p.G, "config", "user.email"]); } catch {}
  const id = { GIT_AUTHOR_NAME: name || who, GIT_AUTHOR_EMAIL: email || "longtable@users.noreply.github.com" };
  const commit = wgit(p, ["commit-tree", tree, "-p", work.base, "-m", message],
    { ...id, GIT_COMMITTER_NAME: id.GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL: id.GIT_AUTHOR_EMAIL });
  const env = { ...id, GIT_COMMITTER_NAME: id.GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL: id.GIT_AUTHOR_EMAIL };
  const push = (sha, to) => { try { git(["--git-dir", p.G, "push", "--quiet", "origin", `${sha}:refs/heads/${to}`]); return true; } catch { return false; } };
  if (push(commit, branch)) return { files, commit: commit.slice(0, 7), sha: commit, pushed: true, branch };
  // Refused: another AI landed its part of the same task first. Put the two together when they do not touch the
  // same lines; when they do, this part goes to a branch of its own beside it and says so.
  for (let i = 0; i < 3; i++) {
    let theirs;
    try {
      git(["--git-dir", p.G, "fetch", "--quiet", "--no-tags", "origin", `refs/heads/${branch}`]);
      theirs = git(["--git-dir", p.G, "rev-parse", "FETCH_HEAD"]);
    } catch { break; }
    let merged;
    try {
      // Putting two parts together is only right when the other part was built on the same starting point. If it
      // was not, a merge would quietly undo what is on the branch, so this part goes beside it instead.
      git(["--git-dir", p.G, "merge-base", "--is-ancestor", work.base, theirs]);
      const both = git(["--git-dir", p.G, "merge-tree", "--write-tree", `--merge-base=${work.base}`, theirs, commit]).split(/\r?\n/)[0];
      merged = wgit(p, ["commit-tree", both, "-p", theirs, "-p", commit, "-m", `Put together: ${message}`], env);
    } catch { break; }
    if (push(merged, branch)) return { files, commit: merged.slice(0, 7), sha: merged, pushed: true, branch };
  }
  // A name with no Latin letters in it leaves nothing to name the branch by, so it is just "part".
  const side = `${branch}-${String(who || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 20).replace(/^-+|-+$/g, "") || "part"}`;
  // A tripwire, written to this computer's log and nothing more: a side branch from a long branch name can be longer
  // than the connection's own rule for branches, and a later job handed it could not write to it.
  try { safeBranch(side); } catch { try { log("tripwire: a side branch came out longer than the connection's own branch rule"); } catch {} }
  if (push(commit, side)) return { files, commit: commit.slice(0, 7), sha: commit, pushed: true, branch: side, apart: true };
  // Nothing could be pushed. Keep the commit findable on this computer, so the work is not lost with the folder.
  try { git(["--git-dir", p.G, "update-ref", `refs/longtable/${branch.slice(10)}`, commit]); } catch {}
  return { files, commit: commit.slice(0, 7), pushed: false, branch };
}

// ---- Full Claude Code: a git worktree of the person's own repository ----
//
// When a person runs their AI at the table as their full Claude Code, it works the way Claude Code's own --worktree
// does: a second checkout of their repository, on the task's branch, in a folder of the connection's. Their own
// working folder is never touched. When the folder they connected from is not a git repository, the connection's
// clean copy is the repository instead. Files their repository lists in .worktreeinclude (Claude Code's own list of
// untracked files a worktree needs) are copied in, as Claude Code does.

const tgit = (cwd, args) => execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd, env: quiet, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 120000 }).toString().trim();

// The person's own repository, when the folder they connected from is one.
export function realRepo(seat) {
  const folder = seat?.folder;
  if (!folder) return null;
  try { return existsSync(join(folder, ".git")) ? resolve(folder) : null; } catch { return null; }
}

// The folder they connected from, as their own Claude Code at home would open it: their own requests work there by
// default ("Work in my folder"), git repository or not.
export function ownFolder(seat) {
  const folder = seat?.folder;
  if (!folder) return null;
  try { return statSync(folder).isDirectory() ? resolve(folder) : null; } catch { return null; }
}

// What git sees as changed in their folder right now, each path with its status and the file's size and time, so a
// job can say which files it changed even in a folder that already had work in progress.
export function folderState(folder) {
  const out = new Map();
  let raw = "";
  try { raw = execFileSync("git", ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: folder, env: quiet, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 60000, maxBuffer: 64 * 1024 * 1024 }).toString(); }
  catch { return null; }
  const parts = raw.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const code = p.slice(0, 2);
    const path = p.slice(3);
    // A rename carries the old name next; it is not a file of its own.
    if (code[0] === "R" || code[0] === "C") i++;
    let seen = "gone";
    try { const s = statSync(join(folder, path)); seen = `${s.size}:${s.mtimeMs}`; } catch {}
    out.set(path, `${code}|${seen}`);
  }
  return out;
}
export function folderChanges(before, after) {
  if (!before || !after) return [];
  const all = new Set([...before.keys(), ...after.keys()]);
  return [...all].filter((p) => before.get(p) !== after.get(p)).sort();
}

// Where the team's code lives is the table's source (what the locked mode reads too), never whatever the person's own
// repository happens to call origin: that can be somebody else's repository (a client's), which work must never reach.
// When the source is this very repository, work stays in it as a local branch and nothing is pushed anywhere.
function sameRepo(source, repo) {
  if (!source) return true;
  let p = String(source);
  if (/^file:/i.test(p)) { try { p = fileURLToPath(p); } catch { return false; } }
  else if (!/^([A-Za-z]:[\\/]|[\\/])/.test(p)) return false;
  const norm = (x) => resolve(x).replace(/[\\/]+$/, "").toLowerCase();
  return norm(p) === norm(repo) || norm(p) === norm(join(repo, ".git"));
}

// The tip of a branch (or of the source's default branch) at the source, fetched under a private name of the
// connection's and read back as a commit: nothing of the person's own refs or remotes changes.
function sourceTip(repo, url, ref) {
  const tmp = `refs/longtable-src/tip-${process.pid}-${Date.now()}`;
  try {
    tgit(repo, ["fetch", "--quiet", "--no-tags", url, `+${ref}:${tmp}`]);
    return tgit(repo, ["rev-parse", tmp]);
  } catch { return null; }
  finally { try { tgit(repo, ["update-ref", "-d", tmp]); } catch {} }
}

// Only files git ignores are copied, as Claude Code does: something tracked is already in the worktree, and something
// untracked but not ignored would otherwise be committed with the work.
function copyIncluded(repo, dir) {
  let list;
  try { list = readFileSync(join(repo, ".worktreeinclude"), "utf8"); } catch { return 0; }
  let n = 0;
  for (const raw of list.split(/\r?\n/)) {
    const p = raw.trim();
    if (!p || p.startsWith("#") || p.includes("..") || /^([A-Za-z]:|[\\/])/.test(p)) continue;
    try { tgit(repo, ["check-ignore", "--quiet", p]); } catch { continue; }
    const from = join(repo, p);
    const to = join(dir, p);
    try { if (existsSync(from) && !existsSync(to)) { cpSync(from, to, { recursive: true }); n++; } } catch {}
  }
  return n;
}

// Opens (or reopens) the worktree for a job. `branch` is the task's branch for work, or the branch to read for a
// review; with no branch it reads the default one. Work on a branch that already exists picks up where it left off.
// A job that only reads gets a worktree of its own (`job`), removed when it ends, so two jobs never share one.
export function openTree(seat, branch, { doing = false, job = "read" } = {}) {
  const table = safeTable(seat.table_id);
  if (branch) safeBranch(branch);
  if (doing && !branch) throw new Error("work needs a branch of its own");
  const repo = realRepo(seat) || join(home, "copies", table);
  const dir = doing ? join(home, "trees", table, `work-${branch.slice("longtable/".length)}`)
    : join(home, "trees", table, `read-${String(job).replace(/[^A-Za-z0-9-]/g, "").slice(0, 36) || "job"}`);
  // The table's code: this repository itself, or the address the table reads from (never "origin" by name).
  const local = sameRepo(seat.source, repo);
  const url = local ? null : seat.source;
  let onRemote = false;
  let base = null;
  if (local) {
    if (branch) { try { base = tgit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]); onRemote = true; } catch {} }
    base ??= tgit(repo, ["rev-parse", "HEAD"]);
  } else {
    if (branch) { base = sourceTip(repo, url, `refs/heads/${branch}`); onRemote = !!base; }
    base ??= sourceTip(repo, url, "HEAD");
    if (!base) throw new Error("the project's code could not be fetched from where the table reads it");
  }
  const fresh = !existsSync(join(dir, ".git"));
  if (fresh) {
    mkdirSync(join(home, "trees", table), { recursive: true });
    // A worktree of ours whose folder is gone is let go by name; the person's own worktrees are never touched.
    try { tgit(repo, ["worktree", "remove", "--force", dir]); } catch {}
    if (doing && !local) {
      // Their own local branch of the same name is never reset over work that is not on the server.
      let mine = null;
      try { mine = tgit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]); } catch {}
      if (mine) {
        try { tgit(repo, ["merge-base", "--is-ancestor", mine, base]); }
        catch { throw new Error(`a branch named ${branch} on this computer has work that is not on the server, so it was left as it is`); }
      }
    }
    tgit(repo, ["worktree", "add", "--quiet", ...(doing ? ["-B", branch, dir, base] : ["--detach", dir, base])]);
  } else if (doing && onRemote && !local) {
    // Work picked up again starts from what is on the server (another AI's part may have landed there since), unless
    // this computer holds commits the server does not have yet.
    try { tgit(dir, ["merge-base", "--is-ancestor", "HEAD", base]); tgit(dir, ["reset", "--quiet", "--hard", base]); } catch {}
    tgit(dir, ["clean", "-qfd", "-e", ".longtable-yours"]);
  }
  // What is laid beside the code for the AI is never committed, in every worktree of this repository.
  const common = resolve(dir, tgit(dir, ["rev-parse", "--git-common-dir"]));
  mkdirSync(join(common, "info"), { recursive: true });
  const exclude = join(common, "info", "exclude");
  const now = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const NL = String.fromCharCode(10);
  if (!now.split(/\r?\n/).includes(".longtable-yours/")) writeFileSync(exclude, `${now}${now && !now.endsWith(NL) ? NL : ""}.longtable-yours/${NL}`);
  if (fresh && realRepo(seat)) copyIncluded(repo, dir);
  return { dir, repo, url, base: tgit(dir, ["rev-parse", "HEAD"]), continued: onRemote, tree: true };
}

// What changed in the worktree since it was opened, committed or not.
export function treeChanges(tree) {
  try {
    const committed = tgit(tree.dir, ["diff", "--name-only", tree.base, "HEAD"]).split(/\r?\n/).filter(Boolean);
    const open = tgit(tree.dir, ["status", "--porcelain"]).split(/\r?\n/).filter(Boolean).map((l) => l.slice(3));
    return [...new Set([...committed, ...open])].filter((f) => !f.startsWith(".longtable-yours"));
  } catch { return []; }
}

// Lands a worktree's work: whatever is left uncommitted becomes one commit (Claude may have made its own along the
// way, which stay as they are), and the branch is pushed with the person's own git sign-in. Only ever to the task's
// longtable/ branch, and never with force.
export function landTree(tree, branch, message, who) {
  safeBranch(branch);
  // The connection's own commit and push run no hooks: a hook on the branch is code other people's AIs can write.
  const noHooks = join(home, "no-hooks");
  mkdirSync(noHooks, { recursive: true });
  const land = (args) => tgit(tree.dir, ["-c", `core.hooksPath=${noHooks}`, ...args]);
  if (land(["status", "--porcelain"])) {
    land(["add", "-A"]);
    land(["commit", "--quiet", "--no-verify", "-m", `${message}${String.fromCharCode(10, 10)}Asked at the table by ${who}.`]);
  }
  const files = land(["diff", "--name-only", tree.base, "HEAD"]).split(/\r?\n/).filter(Boolean);
  if (!files.length) return null;
  const commit = land(["rev-parse", "--short", "HEAD"]);
  let pushed = false;
  let landed = branch;
  // Work on the table's own repository is already on its branch there: nothing is pushed anywhere.
  // Kept as a branch in their own repository, pushed nowhere: it is there, on their computer only.
  if (!tree.url) return { files, commit, branch, pushed: true, apart: false, local: true };
  const push = (to) => land(["push", "--quiet", "--no-verify", tree.url, `HEAD:refs/heads/${to}`]);
  try { push(branch); pushed = true; } catch (e) {
    log(`push of ${branch} failed: ${String(e.message).split(/\r?\n/)[0]}`);
    // Another part landed on the branch first (two people's work on one task): put the two together and try again;
    // when they touch the same lines, this part goes on a branch of its own beside it, as the other work does.
    try {
      land(["fetch", "--quiet", "--no-tags", tree.url, `refs/heads/${branch}`]);
      land(["merge", "--quiet", "--no-edit", "--no-verify", "FETCH_HEAD"]);
      push(branch);
      pushed = true;
    } catch {
      try { land(["merge", "--abort"]); } catch {}
      const side = `${branch}-${String(who || "part").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`.slice(0, 100);
      try { safeBranch(side); push(side); pushed = true; landed = side; } catch (e2) { log(`push of ${side} failed: ${String(e2.message).split(/\r?\n/)[0]}`); }
    }
  }
  return { files, commit: pushed ? land(["rev-parse", "--short", "HEAD"]) : commit, branch: landed, pushed, apart: landed !== branch };
}

// A job's reading worktree goes when the job ends.
export function closeTree(tree) {
  if (!tree?.tree || !/[\\/]read-[^\\/]+$/.test(tree.dir)) return;
  try { tgit(tree.repo, ["worktree", "remove", "--force", tree.dir]); } catch (e) { log(`could not remove a reading worktree: ${String(e.message).split(/\r?\n/)[0]}`); }
}
