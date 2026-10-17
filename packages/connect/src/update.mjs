// The connection keeps itself up to date, so nobody ever has to disconnect and connect again for a new version.
//
// Longtable says which version every connection should run (`runner_release`); the connection never takes whatever
// is newest on npm, so a version reaches people only when Longtable says so, and a version somebody else published
// is never installed. That exact version comes from the npm registry, checked against the registry's own sha512
// fingerprint, unpacked by this file (no tools needed), and put in place of ~/.longtable/app only between jobs. Then
// the connection starts again on it: under launchd or systemd by stopping with a failure code, so they start it
// again; anywhere else by starting the new copy itself and stopping.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { home, log } from "./store.mjs";

export const REGISTRY = (process.env.LONGTABLE_REGISTRY || "https://registry.npmjs.org").replace(/\/+$/, "");
const NAME = "longtable";
const MAX_TARBALL = 8 * 1024 * 1024;
const appDir = () => join(home, "app");

export function versionOf(dir) {
  try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version || null; } catch { return null; }
}
// The version this code itself is.
export const ownDir = () => dirname(dirname(fileURLToPath(import.meta.url)));
export const ownVersion = () => versionOf(ownDir());

// Whether version a is newer than b (plain numbers only: 0.1.20; anything else is never newer).
export function newer(a, b) {
  const p = (v) => (/^\d+\.\d+\.\d+$/.test(String(v || "")) ? String(v).split(".").map(Number) : null);
  const x = p(a);
  const y = p(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// The files in an npm tarball (a gzipped tar): regular files only, by name. Long names (pax and GNU) are read; links,
// devices and anything else are skipped.
export function untar(gz) {
  const buf = gunzipSync(gz);
  const files = [];
  let pos = 0;
  let longName = null;
  const str = (b) => b.toString("utf8").replace(/\0[\s\S]*$/, "");
  while (pos + 512 <= buf.length) {
    const head = buf.subarray(pos, pos + 512);
    if (head.every((b) => b === 0)) break;
    const size = parseInt(str(head.subarray(124, 136)).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new Error("a broken tar header");
    const type = String.fromCharCode(head[156] || 48);
    const prefix = str(head.subarray(345, 500));
    let name = longName ?? (prefix ? `${prefix}/${str(head.subarray(0, 100))}` : str(head.subarray(0, 100)));
    const body = buf.subarray(pos + 512, pos + 512 + size);
    if (body.length < size) throw new Error("a tar cut short");
    pos += 512 + Math.ceil(size / 512) * 512;
    longName = null;
    if (type === "x") { const m = body.toString("utf8").match(/(?:^|\n)\d+ path=([^\n]*)\n/); if (m) longName = m[1]; continue; }
    if (type === "L") { longName = str(body); continue; }
    if (type === "0" || type === "\0" || type === "7") files.push({ name, data: Buffer.from(body) });
  }
  return files;
}

// Only the connection's own parts, at plain paths inside the package: never anything outside it.
export function keepFile(name) {
  if (!name.startsWith("package/")) return null;
  const rel = name.slice("package/".length);
  if (!rel || rel.includes("\\") || rel.includes("\0") || rel.split("/").some((p) => p === ".." || p === "." || p === "")) return null;
  if (rel === "package.json" || rel === "README.md" || /^(bin|src)\/[A-Za-z0-9._/-]+$/.test(rel)) return rel;
  return null;
}

// Fetch that exact version from the registry, checked against the registry's fingerprint. Returns its files.
export async function fetchRelease(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a version: ${version}`);
  const metaRes = await fetch(`${REGISTRY}/${NAME}/${version}`, { headers: { accept: "application/json" } });
  if (!metaRes.ok) throw new Error(`the registry has no ${NAME} ${version} yet (${metaRes.status})`);
  const meta = await metaRes.json();
  const tarball = meta?.dist?.tarball;
  const integrity = String(meta?.dist?.integrity || "");
  if (meta?.name !== NAME || meta?.version !== version) throw new Error("the registry answered for something else");
  if (typeof tarball !== "string" || !tarball.startsWith(`${REGISTRY}/${NAME}/-/`)) throw new Error("the package is not where the registry keeps it");
  const want = integrity.match(/^sha512-([A-Za-z0-9+/=]+)$/)?.[1];
  if (!want) throw new Error("the registry gave no sha512 fingerprint");
  const res = await fetch(tarball);
  if (!res.ok) throw new Error(`could not download ${version} (${res.status})`);
  const gz = Buffer.from(await res.arrayBuffer());
  if (gz.length > MAX_TARBALL) throw new Error("the package is far bigger than it should be");
  if (createHash("sha512").update(gz).digest("base64") !== want) throw new Error("the download does not match the registry's fingerprint");
  const files = [];
  for (const f of untar(gz)) { const rel = keepFile(f.name); if (rel) files.push({ rel, data: f.data }); }
  const pkg = files.find((f) => f.rel === "package.json");
  if (!pkg || JSON.parse(pkg.data.toString("utf8")).version !== version) throw new Error("the package says it is another version");
  if (!files.some((f) => f.rel === "bin/longtable.mjs")) throw new Error("the package has no connection in it");
  return files;
}

// Put a version's files in place of ~/.longtable/app, all at once: written beside it first, then swapped.
export function installRelease(files) {
  const app = appDir();
  const next = join(home, "app-next");
  const old = join(home, `app-old-${Date.now()}`);
  rmSync(next, { recursive: true, force: true });
  for (const f of files) {
    const to = normalize(join(next, ...f.rel.split("/")));
    if (!to.startsWith(next + sep)) throw new Error("a file would land outside the connection's folder");
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, f.data);
  }
  if (existsSync(app)) renameSync(app, old);
  try {
    renameSync(next, app);
  } catch (e) {
    if (existsSync(old)) renameSync(old, app);
    throw e;
  }
  rmSync(old, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return join(app, "bin", "longtable.mjs");
}

// A connection started from somewhere else (an older copy, a cache) runs the newer copy in ~/.longtable/app instead.
export function handOffTo() {
  const target = join(appDir(), "bin", "longtable.mjs");
  if (normalize(ownDir()) === normalize(appDir()) || !existsSync(target)) return null;
  return newer(versionOf(appDir()), ownVersion()) ? target : null;
}

// Start again on the new copy. launchd and systemd start the connection again when it stops with a failure code;
// Windows' task, or a connection started by hand, has nobody to do that, so it starts the new copy itself.
export function restartOnNew(bin) {
  const supervised = (process.platform === "darwin" && process.env.XPC_SERVICE_NAME === "chat.longtable.connection")
    || (process.platform === "linux" && !!process.env.INVOCATION_ID);
  // The new one must not mistake this one for a rival and end it (and on Windows, every program it started).
  rmSync(join(home, "runner.pid"), { force: true });
  if (supervised) { log("update: starting again under the system's service on the new version"); process.exit(75); }
  const child = spawn(process.execPath, [bin, "run"], { detached: true, stdio: "ignore", windowsHide: true, env: process.env });
  child.unref();
  log(`update: started the new version (${child.pid}); this one stops`);
  process.exit(0);
}

// Whether there is a version to move to, and if so move to it: fetched, checked and put in place. The caller has
// stopped taking new jobs and waits for the ones running before it calls this.
export async function updateTo(want) {
  const have = ownVersion();
  if (!want || !newer(want, have)) return null;
  log(`update: ${have} -> ${want}`);
  const files = await fetchRelease(want);
  return installRelease(files);
}
