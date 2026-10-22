// The type check on a client's copy, with no AI and no table: a scratch project shaped like a real one (code that
// imports a generated folder git ignores, installed packages, a .env), its person's folder, and a copy's working folder
// that holds only what git tracks. The check sees what their folder has, never a secret, and leaves nothing behind.
//
//   node tests/e2e/unit-typecheck.mjs

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canCheck, mirrorIgnored, newErrors, parseErrors, remember, remembered, typeCheck, unmirror } from "../../packages/connect/src/typecheck.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${typeof detail === "string" ? detail : JSON.stringify(detail ?? "")}`.slice(0, 500); };
const scratch = mkdtempSync(join(tmpdir(), "longtable-typecheck-"));
const win = process.platform === "win32";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

try {
  // Their folder: tracked code, a generated folder and installed packages that git ignores, and a .env.
  const theirs = join(scratch, "theirs");
  mkdirSync(join(theirs, "src", "generated"), { recursive: true });
  writeFileSync(join(theirs, ".gitignore"), "node_modules/\nsrc/generated/\n.env\n");
  writeFileSync(join(theirs, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "esnext", moduleResolution: "bundler", target: "es2022", skipLibCheck: true }, include: ["src/**/*.ts"] }));
  writeFileSync(join(theirs, "src", "generated", "client.ts"), "export type Booking = { id: string; days: number };\n");
  writeFileSync(join(theirs, "src", "page.ts"), 'import type { Booking } from "./generated/client";\nexport const first: Booking = { id: "b1", days: 3 };\nexport const label: string = "Home";\n');
  writeFileSync(join(theirs, ".env"), "DATABASE_URL=postgres://secret\n");
  symlinkSync(join(repoRoot, "node_modules"), join(theirs, "node_modules"), win ? "junction" : "dir");
  git(theirs, "init", "-q");
  git(theirs, "add", "-A");

  // A copy's working folder: only what git tracks.
  const work = join(scratch, "work");
  mkdirSync(join(work, "src"), { recursive: true });
  for (const f of ["tsconfig.json", ".gitignore", "src/page.ts"]) writeFileSync(join(work, f), readFileSync(join(theirs, f)));

  check("a project with a tsconfig and TypeScript in their folder can be checked", canCheck(work, theirs) && !canCheck(join(scratch), theirs) && !canCheck(work, scratch));
  const clean = await typeCheck(work, theirs);
  check("the copy as it is passes, seeing the generated code that git ignores", clean?.ok === true, clean);
  check("nothing is left in the copy's folder after the check", !existsSync(join(work, "node_modules")) && !existsSync(join(work, "src", "generated")) && readdirSync(work).every((f) => !f.endsWith(".tsbuildinfo")), readdirSync(work));
  check("their own folder is untouched: its packages and generated code are still there", existsSync(join(theirs, "node_modules", "typescript", "bin", "tsc")) && existsSync(join(theirs, "src", "generated", "client.ts")));

  const made = mirrorIgnored(work, theirs);
  check("a secret file is never brought in", !existsSync(join(work, ".env")) && made.every((m) => !/\.env/.test(m.at)), made.map((m) => m.at));
  unmirror(made);
  check("taking the links out again removes only the links", !existsSync(join(work, "node_modules")) && existsSync(join(theirs, "node_modules", "typescript")));

  // A change that breaks the types.
  writeFileSync(join(work, "src", "page.ts"), 'import type { Booking } from "./generated/client";\nexport const first: Booking = { id: "b1", days: "three" };\nexport const label: string = 42;\n');
  const broken = await typeCheck(work, theirs);
  check("a change that breaks the types is caught, with its errors", broken?.ok === false && broken.errors.length === 2 && broken.errors.every((e) => e.startsWith("src/page.ts: TS")), broken);
  check("only errors the change adds count against it", newErrors(broken.errors, [broken.errors[0]]).length === 1 && newErrors(broken.errors, broken.errors).length === 0);
  check("an error is the same however far its line moved", parseErrors("src/a.ts(3,5): error TS2322: Type 'x' is not assignable.")[0] === parseErrors("src/a.ts(9,1): error TS2322: Type 'x' is not assignable.")[0]);

  // What a version's check found is remembered on this computer.
  const home = join(scratch, "home");
  remember(home, "t1", "a".repeat(40), ["src/x.ts: TS1: y"]);
  check("a version's errors are remembered by its commit", JSON.stringify(remembered(home, "t1", "a".repeat(40))) === JSON.stringify(["src/x.ts: TS1: y"]) && remembered(home, "t1", "b".repeat(40)) === null);

  // A working folder holding a link is removed without touching what the link points at.
  const holder = join(scratch, "holder");
  mkdirSync(holder);
  const target = join(scratch, "target");
  mkdirSync(target);
  writeFileSync(join(target, "keep.txt"), "keep");
  symlinkSync(target, join(holder, "linked"), win ? "junction" : "dir");
  rmSync(holder, { recursive: true, force: true });
  check("removing a working folder never follows a link inside it", existsSync(join(target, "keep.txt")) && !existsSync(holder));
} catch (e) {
  check("the run did not crash", false, e.stack || String(e));
} finally {
  // The links in the scratch folder go first, as links, so the repository's own packages are never touched.
  try { const l = join(scratch, "theirs", "node_modules"); if (existsSync(l)) { if (win) execFileSync("cmd", ["/c", "rmdir", l]); else rmSync(l); } } catch {}
  try { rmSync(scratch, { recursive: true, force: true }); } catch {}
}
const failed = Object.values(results).filter((v) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
