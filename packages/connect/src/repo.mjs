// The connection's own clean copy of the team's code: the latest main, never the person's work folder.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { home } from "./store.mjs";

const git = (args, cwd) => execFileSync("git", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

// Given a folder or a git address, find where to copy from: the folder's origin if it has one, else the folder itself.
export function resolveSource(repo) {
  if (!repo) return null;
  if (/^(https?:|git@|ssh:)/.test(repo)) return repo;
  const folder = resolve(repo);
  if (!existsSync(join(folder, ".git"))) throw new Error(`${folder} is not a git repository`);
  try {
    const origin = git(["-C", folder, "remote", "get-url", "origin"]);
    if (origin) return origin;
  } catch {
    // No origin: copy from the folder's own history, which is still only committed work.
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
