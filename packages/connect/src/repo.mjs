// The connection's own clean copy of the team's code: the latest main, never the person's work folder.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { home } from "./store.mjs";

// Git never stops to ask for a name or password here: if this computer's saved sign-in cannot reach a repository,
// the command fails and the connection says so.
const quiet = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
const git = (args, cwd) => execFileSync("git", args, { cwd, env: quiet, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 120000 }).toString().trim();

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
    git(["-C", dir, "fetch", "--quiet", "--depth", "1", "--no-tags", "origin", "HEAD"]);
    git(["-C", dir, "reset", "--quiet", "--hard", "FETCH_HEAD"]);
    git(["-C", dir, "clean", "-qfdx"]);
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

export const workBranch = (chatName) => "longtable/" + (String(chatName || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "work");

// Lay out the files to work on: the chat's own branch when it already exists, so one request builds on the last,
// else the latest default branch.
export function openWork(tableId, branch, name = "work") {
  const p = places(tableId, name);
  rmSync(p.W, { recursive: true, force: true });
  rmSync(p.I, { force: true });
  mkdirSync(p.W, { recursive: true });
  let base = git(["--git-dir", p.G, "rev-parse", "HEAD"]);
  let continued = false;
  try {
    git(["--git-dir", p.G, "fetch", "--quiet", "--depth", "1", "--no-tags", "origin", `refs/heads/${branch}`]);
    base = git(["--git-dir", p.G, "rev-parse", "FETCH_HEAD"]);
    continued = true;
  } catch {
    // No such branch yet: start from the default one.
  }
  wgit(p, ["read-tree", base]);
  wgit(p, ["checkout-index", "-a", "-f"]);
  return { dir: p.W, base, continued };
}

// Whatever changed becomes one commit on the chat's branch, pushed for the team to look at. Never the default branch.
export function landWork(tableId, work, branch, message, who) {
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
  let pushed = true;
  try { git(["--git-dir", p.G, "push", "--quiet", "origin", `${commit}:refs/heads/${branch}`]); } catch { pushed = false; }
  return { files, commit: commit.slice(0, 7), pushed };
}
