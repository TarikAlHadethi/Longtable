// A file an AI names in its answer (`src/booking/StaffPicker.tsx:42`) links to that file in the team's repository on
// GitHub: at the commit the answer read when it says one ("branch @ 1a2b3c4"), else at the repository's newest. Only a
// github.com repository, only something that is a path to a file (it has a folder in it, or the answer read that very
// file: `console.log` and `Next.js` are not files), never anything that climbs out of the project, and never work that
// stayed on one person's computer, which GitHub has never seen.

export function githubBase(repo) {
  const s = String(repo || "").trim();
  const m = s.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i)
    || s.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i)
    || s.match(/^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

// Work that stayed on one person's computer (no shared repository to push to), as the connection says it.
export const onlyLocal = (read) => /only on [^,]+ computer/.test(String(read || ""));

export function fileLink(repo, read, sources = []) {
  const base = githubBase(repo);
  if (!base || onlyLocal(read)) return () => null;
  const commit = String(read || "").match(/@ ([0-9a-f]{7,40})\b/)?.[1];
  const ref = commit || "HEAD";
  const readFiles = new Set((Array.isArray(sources) ? sources : []).map((x) => String(x).replace(/\\/g, "/").replace(/^\.\//, "")));
  return (code) => {
    const m = String(code || "").trim().match(/^(?:\.\/)?((?:[\w.-]+\/)*[\w-][\w.-]*\.[A-Za-z][A-Za-z0-9]{0,9})(?::(\d{1,6})(?:-(\d{1,6}))?)?$/);
    if (!m || m[1].split("/").some((part) => part === ".." || part === ".")) return null;
    if (!m[1].includes("/") && !readFiles.has(m[1])) return null;
    const path = m[1].split("/").map(encodeURIComponent).join("/");
    return `${base}/blob/${ref}/${path}${m[2] ? `#L${m[2]}${m[3] ? `-L${m[3]}` : ""}` : ""}`;
  };
}

// The branch a finished task's work is really on: a part that clashed lands beside the task's branch, and the task's
// result says which.
export function landedBranch(result, branch) {
  return String(result || "").match(/ on (longtable\/[\w.\/-]+) @ /)?.[1] || branch;
}
