// The connection's own clean copy of the team's code: the latest main, never the person's work folder.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { home } from "./store.mjs";

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

// Given a folder or a git address, find where to copy from. For a folder: its origin when this computer can reach
// it, else the folder's own history, which is still only committed work. An address that cannot be reached is an
// error, said before anything else happens.
export function resolveSource(repo) {
  if (!repo) return null;
  if (/^(https?:|git@|ssh:)/.test(repo)) {
    if (!canReach(repo)) throw new Error(`This computer's git cannot open ${repo}. Sign in to git for it, or open your AI in the project's own folder and connect from there.`);
    return repo;
  }
  const folder = resolve(repo);
  if (!existsSync(join(folder, ".git"))) throw new Error(`${folder} is not a git repository`);
  try {
    const origin = git(["-C", folder, "remote", "get-url", "origin"]);
    if (origin && canReach(origin)) return origin;
  } catch {
    // No origin: fall through to the folder itself.
  }
  return "file:///" + folder.replace(/\\/g, "/");
}

// Bring the copy up to the latest default branch. Symlinks are checked out as plain files, so a link in the
// repository can never point the AI at a file outside the copy.
export function freshCopy(tableId, source) {
  const dir = join(home, "copies", tableId);
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

export function copyIsClean(tableId) {
  const dir = join(home, "copies", tableId);
  if (!existsSync(join(dir, ".git"))) return true;
  return git(["-C", dir, "status", "--porcelain"]) === "";
}

// Work the team asked for happens in a second folder that holds the files and nothing else: no .git inside it, so
// nothing the AI writes there can change what git itself runs. Git reaches it from outside, with its own index.
const places = (tableId, name = "work") => ({ G: join(home, "copies", tableId, ".git"), W: join(home, name, tableId), I: join(home, name, `${tableId}.index`) });
const wgit = (p, args, env = {}) => execFileSync("git", ["--git-dir", p.G, "--work-tree", p.W, ...args],
  { cwd: p.W, env: { ...quiet, GIT_INDEX_FILE: p.I, ...env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 120000 }).toString().trim();

// Whatever the table names, the connection only ever writes to a plain branch under longtable/. Never the default
// branch, never anything that is not a simple name: this holds even if the server it talks to is not the real one.
export function safeBranch(b) {
  if (typeof b !== "string" || !/^longtable\/[a-z0-9][a-z0-9-]{0,79}$/.test(b)) throw new Error("the table named a branch this connection will not write to");
  return b;
}

export const workBranch = (chatName) => "longtable/" + (String(chatName || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "work");

// A folder laid beside the code for the AI to read, and never to be committed: the repository's own exclude list says so.
export function neverCommit(tableId, name) {
  const file = join(home, "copies", tableId, ".git", "info", "exclude");
  try {
    const now = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (!now.split(/\r?\n/).includes(`${name}/`)) writeFileSync(file, `${now}${now.endsWith(String.fromCharCode(10)) || !now ? "" : String.fromCharCode(10)}${name}/${String.fromCharCode(10)}`);
  } catch {}
}

// Lay out the files to work on: the chat's own branch when it already exists, so one request builds on the last,
// else the latest default branch.
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
  const G = join(home, "copies", tableId, ".git");
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

// One commit of a sandbox, as a patch the team's AI can read to see what the client ended up with.
export function patchOf(tableId, branch, commit) {
  safeBranch(branch);
  if (!/^[0-9a-f]{7,40}$/.test(String(commit || ""))) return "";
  const G = join(home, "copies", tableId, ".git");
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
  const side = `${branch}-${String(who || "part").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 20)}`;
  if (push(commit, side)) return { files, commit: commit.slice(0, 7), sha: commit, pushed: true, branch: side, apart: true };
  // Nothing could be pushed. Keep the commit findable on this computer, so the work is not lost with the folder.
  try { git(["--git-dir", p.G, "update-ref", `refs/longtable/${branch.slice(10)}`, commit]); } catch {}
  return { files, commit: commit.slice(0, 7), pushed: false, branch };
}
