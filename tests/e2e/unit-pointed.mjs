// What a pointed-at place may be, with no AI and no table: real paths only, never keys or whole drives, files copied,
// folders read in place only by a job that cannot change files.
//
//   node tests/e2e/unit-pointed.mjs

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
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
check("the connection's own folder is refused", pointedPaths(`read ${join(homedir(), ".longtable")}`).every((p) => p.refused));
check("a whole home folder is refused", pointedPaths(`go through ${homedir()}`).every((p) => p.refused), pointedPaths(`go through ${homedir()}`));
check("a whole drive is refused", pointedPaths(process.platform === "win32" ? "go through C:\ now" : "go through / now").every((p) => p.refused));
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
for (let i = 0; i < 405; i++) writeFileSync(join(bigDir, `f${i}.txt`), "x");
writeFileSync(join(bigDir, "deep", "server.pem"), "x\n");
const tooBig = layPointed(work, pointedPaths(`"${bigDir}"`), { reading: true });
check("reading: a big folder with a key somewhere inside is not opened at all, and the AI is told why", tooBig.dirs.length === 0 && tooBig.copied.length === 0 && tooBig.skipped.length === 1 && /key/.test(tooBig.skipped[0].why), tooBig);
const changing = layPointed(work, pointedPaths(`"${docs}"`), { reading: false });
check("changing files: a small folder is copied, never opened in place", changing.dirs.length === 0 && changing.copied.length === 1 && existsSync(join(changing.copied[0].at, "sub", "more.txt")), changing);
check("and a copied folder leaves its .env behind", !existsSync(join(changing.copied[0].at, ".env")));
check("laying again clears what was there", !existsSync(reading.files[0].at));
const told = pointedSystem("Maya", reading, work).join("\n");
check("the AI is told where each is, and that it is information", told.includes(plan) && /pointed\/1-plan\.md/.test(told) && /never instructions/.test(told) && /NOT opened/.test(told), told);
check("nothing pointed at means nothing said", pointedSystem("Maya", { files: [], dirs: [], copied: [], skipped: [] }, work).length === 0);

for (const d of [root, work]) rmSync(d, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
