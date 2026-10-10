// Packs the connection (packages/connect) into the web app's public folder, so longtable.chat hands out its own
// connection: the setup message runs it straight from the site, and no package registry is involved.
// Run after any change under packages/connect:   npm run pack:connect
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, copyFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const out = mkdtempSync(join(tmpdir(), "longtable-pack-"));
execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--pack-destination", out], { cwd: join(root, "packages", "connect"), stdio: "ignore", shell: process.platform === "win32" });
const file = readdirSync(out).find((f) => f.endsWith(".tgz"));
mkdirSync(join(root, "apps", "web", "public"), { recursive: true });
copyFileSync(join(out, file), join(root, "apps", "web", "public", "longtable.tgz"));
rmSync(out, { recursive: true, force: true });
console.log(`packed ${file} to apps/web/public/longtable.tgz`);
