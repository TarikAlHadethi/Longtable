import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, normalize, sep } from "node:path";
import { home, log } from "./store.mjs";
import { fetchChecked, ownDir } from "./update.mjs";

// A real terminal needs a pseudo-terminal, which only a small native library can give (ConPTY on Windows, forkpty on
// Mac and Linux). The connection keeps itself up to date with plain files only, so the library is not inside it: it
// is loaded from the package's own install when there is one (connecting through npm, or this repository), else
// fetched once from the npm registry for this computer, at the exact version the connection names, checked against
// the registry's fingerprint, and kept in ~/.longtable/pty/<version>. Only the one package for this system and
// processor is fetched: the prebuilt library itself, no install scripts.

const NAME = "@lydell/node-pty";
export const ptyVersion = () => JSON.parse(readFileSync(join(ownDir(), "package.json"), "utf8")).dependencies?.[NAME] || null;
export const platformPackage = (platform = process.platform, arch = process.arch) => `${NAME}-${platform}-${arch}`;

// Only plain paths inside the package.
function rel(name) {
  if (!name.startsWith("package/")) return null;
  const r = name.slice("package/".length);
  if (!r || r.includes("\\") || r.includes("\0") || r.split("/").some((p) => p === ".." || p === "." || p === "")) return null;
  return r;
}

export async function installPty(version, dir) {
  const files = await fetchChecked(platformPackage(), version, 40 * 1024 * 1024);
  const next = `${dir}-next`;
  rmSync(next, { recursive: true, force: true });
  for (const f of files) {
    const r = rel(f.name);
    if (!r) continue;
    const to = normalize(join(next, ...r.split("/")));
    if (!to.startsWith(next + sep)) throw new Error("a file would land outside its folder");
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, f.data);
    // The helper programs it starts must stay runnable on Mac and Linux.
    if (f.exec && process.platform !== "win32") chmodSync(to, 0o755);
  }
  if (!existsSync(join(next, "package.json"))) throw new Error("the terminal library came without its package");
  rmSync(dir, { recursive: true, force: true });
  renameSync(next, dir);
}

let loading = null;
// The library, once: from the package's own install, else from the copy kept for this computer, fetched if missing.
export function loadPty() {
  loading ??= (async () => {
    try { return createRequire(import.meta.url)(NAME); } catch {}
    const version = ptyVersion();
    if (!/^[0-9A-Za-z.-]+$/.test(version || "")) throw new Error("the connection names no terminal library");
    const dir = join(home, "pty", version, platformPackage().split("/")[1]);
    if (!existsSync(join(dir, "package.json"))) {
      log(`terminal: fetching ${platformPackage()} ${version} for this computer`);
      await installPty(version, dir);
    }
    return createRequire(join(dir, "package.json"))(join(dir, "lib", "index.js"));
  })().catch((e) => { loading = null; throw e; });
  return loading;
}
