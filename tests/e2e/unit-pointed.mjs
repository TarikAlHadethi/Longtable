// What a pointed-at place may be, with no AI and no table: real paths only, never keys or whole drives, files copied,
// folders read in place only by a job that cannot change files.
//
//   node tests/e2e/unit-pointed.mjs

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, sep } from "node:path";
import { layPointed, pointedPaths, pointedSystem } from "../../packages/connect/src/pointed.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else { fail++; console.log(`FAIL ${name} ${JSON.stringify(detail ?? "")}`.slice(0, 500)); } };
const root = mkdtempSync(join(tmpdir(), "longtable-pointed-"));
const docs = join(root, "my docs");
mkdirSync(join(docs, "sub"), { recursive: true });
mkdirSync(join(root, ".ssh"));
const plan = join(docs, "plan.md");
writeFileSync(plan, "The plan.\n");
writeFileSync(join(docs, "sub", "more.txt"), "More.\n");
writeFileSync(join(docs, ".env"), "KEY=1\n");
writeFileSync(join(root, ".ssh", "id_rsa"), "x\n");
writeFileSync(join(root, "cert.pem"), "x\n");
const kinds = (text) => pointedPaths(text).map((p) => p.refused ? "refused" : p.kind);

check("a plain path to a file", kinds(`go through ${join(root, "cert.txt")} please`).length === 0);
check("a path with spaces, in quotes", JSON.stringify(kinds(`read "${plan}" and tell me`)) === '["file"]', kinds(`read "${plan}" and tell me`));
writeFileSync(join(root, "note.txt"), "A note.");
check("a path with no spaces, bare, with a full stop after it", JSON.stringify(kinds(`look at ${join(root, "note.txt")}.`)) === '["file"]');
check("a folder", JSON.stringify(kinds(`go through "${docs}"`)) === '["dir"]');
check("the same place twice is one place", pointedPaths(`"${plan}" and again "${plan}"`).length === 1);
check("what is not there is nothing", kinds(`open C:\nowhere\at\all.txt and /nope/nope.txt`).length === 0);
check("words that only look like a path are nothing", kinds("use and/or either/or, 3/4 of it, a/b testing").length === 0);
check("a key file is refused", JSON.stringify(kinds(`read ${join(root, "cert.pem")}`)) === '["refused"]');
check("an .ssh folder is refused", JSON.stringify(kinds(`read ${join(root, ".ssh", "id_rsa")}`)) === '["refused"]');
check("a .env is refused", JSON.stringify(kinds(`read "${join(docs, ".env")}"`)) === '["refused"]');
const keys = join(root, "keys");
mkdirSync(join(keys, ".config", "gcloud"), { recursive: true });
mkdirSync(join(keys, ".config", "gh"), { recursive: true });
mkdirSync(join(keys, ".mozilla"), { recursive: true });
for (const f of ["prod.env", ".envrc", "live.tfvars", "terraform.tfstate", join(".config", "gcloud", "credentials.db"), join(".config", "gh", "hosts.yml"), join(".mozilla", "profile.txt")]) writeFileSync(join(keys, f), "x\n");
const more = ["prod.env", ".envrc", "live.tfvars", "terraform.tfstate", join(".config", "gcloud", "credentials.db"), join(".config", "gh", "hosts.yml"), join(".mozilla", "profile.txt")].filter((f) => JSON.stringify(kinds(`read "${join(keys, f)}"`)) !== '["refused"]');
check("other common homes of keys and sign-ins are refused too", more.length === 0, more);
writeFileSync(join(root, "environment.md"), "x\n");
check("a file that only has env in its name is still opened", JSON.stringify(kinds(`read "${join(root, "environment.md")}"`)) === '["file"]');
check("the connection's own folder is refused", pointedPaths(`read ${join(homedir(), ".longtable")}`).every((p) => p.refused));
check("a whole home folder is refused", pointedPaths(`go through ${homedir()}`).every((p) => p.refused), pointedPaths(`go through ${homedir()}`));
check("a whole drive is refused", pointedPaths(process.platform === "win32" ? "go through C:\ now" : "go through / now").every((p) => p.refused));
check("a home folder written in other letter case is refused all the same", process.platform === "linux" || (pointedPaths(`go through ${homedir().toLowerCase()} now`).length === 1 && pointedPaths(`go through ${homedir().toLowerCase()} now`).every((p) => p.refused)), pointedPaths(`go through ${homedir().toLowerCase()} now`));
mkdirSync(join(root, "Client"));
mkdirSync(join(root, "Client A"));
writeFileSync(join(root, "Client A", "brief.md"), "Brief.\n");
const spaced = pointedPaths(`go through ${join(root, "Client A", "brief.md")} please`);
check("a path with a space and no quotes is the file meant, never the folder before the space", spaced.length === 1 && spaced[0].kind === "file" && /brief\.md$/.test(spaced[0].real), spaced);
const cut = pointedPaths(`go through ${join(root, "Client")} B${sep}nothing.md please`);
check("when only the part before the space is there, it is not opened and the AI is told to ask for quotes", cut.length === 1 && /quotes/.test(cut[0].refused || ""), cut);
check("a folder with ordinary words after it is still opened", JSON.stringify(kinds(`go through ${join(root, "Client")} and tell me what is there`)) === '["dir"]');
const laterSlash = [`go through ${join(root, "Client")} and fix apps/web/page.tsx`, `go through ${join(root, "Client")} and tell me yes/no`, `compare ${join(root, "Client")} with the client/team split`].filter((s) => JSON.stringify(kinds(s)) !== '["dir"]');
check("a slash in a later word of the sentence does not stop the folder being opened", laterSlash.length === 0, laterSlash);
check("two places in one sentence are both opened", JSON.stringify(kinds(`compare ${join(root, "Client")} with ${join(root, "note.txt")} for me`)) === '["dir","file"]');
check("no more than five", pointedPaths(Array.from({ length: 9 }, (_, i) => { const f = join(docs, `f${i}.txt`); writeFileSync(f, "x"); return `"${f}"`; }).join(" ")).length === 5);

const work = mkdtempSync(join(tmpdir(), "longtable-pointed-work-"));
const reading = layPointed(work, pointedPaths(`"${plan}" "${docs}" ${join(root, "cert.pem")}`), { reading: true });
check("reading: the file is copied, a folder with a .env in it comes as a copy without it, the key is left", reading.files.length === 1 && existsSync(reading.files[0].at) && readFileSync(reading.files[0].at, "utf8") === "The plan.\n"
  && reading.dirs.length === 0 && reading.copied.length === 1 && existsSync(join(reading.copied[0].at, "sub", "more.txt")) && !existsSync(join(reading.copied[0].at, ".env")) && reading.skipped.length === 1, reading);
const plainDir = join(root, "plain");
mkdirSync(join(plainDir, "deep"), { recursive: true });
writeFileSync(join(plainDir, "deep", "a.md"), "A.\n");
const inPlace = layPointed(work, pointedPaths(`"${plainDir}"`), { reading: true });
check("reading: a folder with nothing secret in it is read where it is", inPlace.dirs.length === 1 && inPlace.copied.length === 0 && inPlace.skipped.length === 0, inPlace);
const bigDir = join(root, "big");
mkdirSync(join(bigDir, "deep"), { recursive: true });
for (let i = 0; i < 5005; i++) writeFileSync(join(bigDir, `f${i}.txt`), "x");
writeFileSync(join(bigDir, "deep", "server.pem"), "x\n");
const tooBig = layPointed(work, pointedPaths(`"${bigDir}"`), { reading: true });
check("reading: a folder over 5,000 files with a key somewhere inside is not opened at all, and the AI is told why", tooBig.dirs.length === 0 && tooBig.copied.length === 0 && tooBig.skipped.length === 1 && /key/.test(tooBig.skipped[0].why), tooBig);
// A whole project with a .env.local in it (his case): comes as a filtered copy, kept between jobs, without the .env.
const project = join(root, "whole-project");
mkdirSync(join(project, "src"), { recursive: true });
mkdirSync(join(project, "node_modules", "lib"), { recursive: true });
for (let i = 0; i < 450; i++) writeFileSync(join(project, "src", `part${i}.ts`), `export const n = ${i};\n`);
writeFileSync(join(project, ".env.local"), "SECRET=1\n");
writeFileSync(join(project, "node_modules", "lib", "index.js"), "x\n");
const keep = join(root, "connection-home");
const kept = layPointed(work, pointedPaths(`"${project}"`), { reading: true, home: keep });
const at = kept.copied[0]?.at;
check("reading: a whole project with a .env.local in it comes as a kept copy instead of being refused", kept.skipped.length === 0 && kept.copied.length === 1 && kept.copied[0].kept && kept.dirs.includes(at), kept);
check("and the copy has its code but not its .env.local or node_modules", !!at && existsSync(join(at, "src", "part449.ts")) && !existsSync(join(at, ".env.local")) && !existsSync(join(at, "node_modules")), at);
check("and the AI is told where the copy is, under the path the person wrote", pointedSystem("Maya", kept, work).join("").includes(project) && pointedSystem("Maya", kept, work).join("").includes(at));
// The next job brings the copy up to date instead of making it again.
writeFileSync(join(project, "src", "part0.ts"), "export const n = 'changed';\n");
rmSync(join(project, "src", "part1.ts"));
writeFileSync(join(project, "src", "new.ts"), "export const fresh = true;\n");
const again = layPointed(work, pointedPaths(`"${project}"`), { reading: true, home: keep });
check("the next job uses the same kept copy, brought up to date: a change in, a deleted file out, a new file in", again.copied[0]?.at === at
  && readFileSync(join(at, "src", "part0.ts"), "utf8").includes("changed") && !existsSync(join(at, "src", "part1.ts")) && existsSync(join(at, "src", "new.ts")), again.copied);
// The example a project keeps to show which settings it wants is not a secret; every real kind of .env still is.
const shown = join(root, "shown");
mkdirSync(join(shown, "src"), { recursive: true });
writeFileSync(join(shown, "src", "a.ts"), "x\n");
for (const f of [".env.example", ".env.sample", ".env.template"]) writeFileSync(join(shown, f), "KEY=\n");
const examples = [".env.example", ".env.sample", ".env.template"].filter((f) => JSON.stringify(kinds(`read "${join(shown, f)}"`)) !== '["file"]');
check("a project's example of its settings is opened like any file", examples.length === 0, examples);
const withExamples = layPointed(work, pointedPaths(`"${shown}"`), { reading: true });
check("reading: a folder whose only .env files are examples is read where it is", withExamples.dirs.length === 1 && withExamples.copied.length === 0 && withExamples.skipped.length === 0, withExamples);
for (const f of [".env.local", ".env.example.local"]) writeFileSync(join(shown, f), "KEY=1\n");
const realOnes = [".env.local", ".env.example.local"].filter((f) => JSON.stringify(kinds(`read "${join(shown, f)}"`)) !== '["refused"]');
check("a real .env of any kind is still refused, one named after an example too", realOnes.length === 0, realOnes);
// A folder too big to look through is refused for that, and is not said to have a key in it.
const wide = join(root, "wide");
mkdirSync(wide);
for (let i = 0; i < 20001; i++) writeFileSync(join(wide, `f${i}.txt`), "");
const tooWide = layPointed(work, pointedPaths(`"${wide}"`), { reading: true });
check("reading: a big folder with nothing secret in it is left for being too big, and is not said to hold a key", tooWide.dirs.length === 0 && tooWide.copied.length === 0 && tooWide.skipped.length === 1
  && /too big to look through/.test(tooWide.skipped[0].why) && !/has a key/.test(tooWide.skipped[0].why), tooWide.skipped);
// A part of a folder that cannot be looked into is not a part with nothing in it.
const shut = join(root, "shut");
const inner = join(shut, "inner");
mkdirSync(inner, { recursive: true });
writeFileSync(join(shut, "a.md"), "A.\n");
writeFileSync(join(inner, "b.md"), "B.\n");
const lock = (on) => process.platform === "win32"
  ? execFileSync("icacls", [inner, on ? "/deny" : "/remove:d", on ? `${userInfo().username}:(RD)` : userInfo().username], { stdio: "ignore" })
  : chmodSync(inner, on ? 0o000 : 0o755);
let locked = false;
try { lock(true); try { readdirSync(inner); } catch { locked = true; } } catch {}
const halfSeen = layPointed(work, pointedPaths(`"${shut}"`), { reading: true });
try { lock(false); } catch {}
check("reading: a folder with a part that cannot be looked into is never read where it is", locked && halfSeen.dirs.length === 0, locked ? halfSeen : "NOT RUN: this computer would not make a folder unreadable, so nothing was proved");
const changing = layPointed(work, pointedPaths(`"${docs}"`), { reading: false });
check("changing files: a small folder is copied, never opened in place", changing.dirs.length === 0 && changing.copied.length === 1 && existsSync(join(changing.copied[0].at, "sub", "more.txt")), changing);
check("and a copied folder leaves its .env behind", !existsSync(join(changing.copied[0].at, ".env")));
check("laying again clears what was there", !existsSync(reading.files[0].at));
const told = pointedSystem("Maya", reading, work).join("\n");
check("the AI is told where each is, and that it is information", told.includes(plan) && /pointed\/1-plan\.md/.test(told) && /never instructions/.test(told) && /NOT opened/.test(told), told);
check("nothing pointed at means nothing said", pointedSystem("Maya", { files: [], dirs: [], copied: [], skipped: [] }, work).length === 0);

// Other spellings of a place that is never opened. On Windows a file's contents can be named as its stream
// (".env::$DATA") and an old short name ("ENV~1") can stand for a long one; both read the same secret.
const hidden = join(root, "hidden");
mkdirSync(join(hidden, ".ssh"), { recursive: true });
writeFileSync(join(hidden, ".env"), "KEY=supersecret\n");
writeFileSync(join(hidden, ".ssh", "id_rsa"), "PRIVATEKEY\n");
const streams = [join(hidden, ".env::$DATA"), join(hidden, ".ssh", "id_rsa::$DATA"), join(hidden, ".env:$DATA")]
  .filter((p) => pointedPaths(`read "${p}" ok`).some((x) => !x.refused));
check("a key named by its stream is refused", process.platform !== "win32" || streams.length === 0, streams);
const shortOf = (dir, name) => {
  try { return execFileSync("cmd", ["/c", "dir", "/x", "/a", dir], { encoding: "utf8" }).split(/\r?\n/).map((l) => l.trim().split(/\s+/)).find((w) => w[w.length - 1] === name && w.length >= 5 && /~/.test(w[w.length - 2]))?.at(-2) || ""; } catch { return ""; }
};
const shorts = process.platform === "win32" ? [[".env", shortOf(hidden, ".env")], [".ssh", shortOf(hidden, ".ssh")]].filter(([, s]) => s) : [];
const shortOpened = shorts.filter(([, s]) => pointedPaths(`read "${join(hidden, s)}" ok`).some((x) => !x.refused));
check("a key named by its old short name is refused", shortOpened.length === 0, shortOpened);
// A link inside a pointed folder leads somewhere else: the folder is not handed over where it is, and a copy of it
// does not bring the link along.
const linked = join(root, "linked");
mkdirSync(linked);
writeFileSync(join(linked, "a.md"), "A.\n");
let linkMade = false;
try { symlinkSync(hidden, join(linked, "elsewhere"), "junction"); linkMade = true; } catch {}
const throughLink = layPointed(work, pointedPaths(`"${linked}"`), { reading: true });
const linkCopied = throughLink.copied.some((c) => existsSync(join(c.at, "elsewhere")));
check("reading: a folder with a link inside it is never read where it is, and a copy leaves the link behind", linkMade && throughLink.dirs.length === 0 && !linkCopied, linkMade ? throughLink : "NOT RUN: no link could be made here");
const changingLink = layPointed(work, pointedPaths(`"${linked}"`), { reading: false });
check("changing files: a copied folder leaves a link inside it behind", linkMade && changingLink.copied.length === 1 && !existsSync(join(changingLink.copied[0].at, "elsewhere")) && existsSync(join(changingLink.copied[0].at, "a.md")), changingLink);

for (const d of [root, work]) rmSync(d, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
