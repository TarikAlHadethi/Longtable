// The connection's life on a person's computer, with no AI and no table: the faults of group 2 (16 Oct 2026).
//   A late reply from Codex's limits server no longer takes the connection down.
//   Ending a connection ends every program it started, its Claude included.
//   The start-up script reads right with letters outside English in the profile folder, and "started" is only said
//   when the connection really started.
//   The log keeps to a size.
//
//   node tests/e2e/unit-connection.mjs

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "longtable-conn-"));
process.env.LONGTABLE_HOME = join(scratch, "home");
mkdirSync(process.env.LONGTABLE_HOME, { recursive: true });
const { log } = await import("../../packages/connect/src/store.mjs");
const { keepTrack, stopAll } = await import("../../packages/connect/src/claude.mjs");
const { codexLimits } = await import("../../packages/connect/src/codex.mjs");
const { endConnection } = await import("../../packages/connect/src/run.mjs");
const { writeStarter, wroteNoteSince } = await import("../../packages/connect/src/autostart.mjs");

const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${typeof detail === "string" ? detail : JSON.stringify(detail ?? "")}`.slice(0, 500); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let crashed = null;
process.on("uncaughtException", (e) => { crashed = e; });

try {
  // ---- Codex's limits server answers once and then is gone: the replies to it go nowhere, and nothing crashes.
  const fake = join(scratch, "fake-codex.mjs");
  writeFileSync(fake, `process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\\n"); process.exit(0);`);
  const started = Date.now();
  const limits = await codexLimits({ cmd: process.execPath, pre: [fake] });
  await sleep(500);
  check("a Codex limits server that goes away mid-answer leaves the connection running (defensive: the crash was not reproduced on Windows)", crashed === null && limits === null, { crashed: crashed?.message, limits });
  check("and the connection does not wait past its ten seconds for it", Date.now() - started < 12000, Date.now() - started);

  // ---- A Claude the connection started ends with it.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  keepTrack(child);
  await sleep(300);
  stopAll();
  await sleep(800);
  check("a Claude the connection started ends when the connection ends", !alive(child.pid), child.pid);

  // ---- Ending another connection ends what it started too.
  const parent = spawn(process.execPath, ["-e", "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000);"], { stdio: ["ignore", "pipe", "ignore"] });
  const grandchild = await new Promise((resolve) => parent.stdout.once("data", (d) => resolve(Number(String(d).trim()))));
  check("the stand-in connection and its Claude are both running", alive(parent.pid) && alive(grandchild), [parent.pid, grandchild]);
  endConnection(parent.pid);
  await sleep(1500);
  if (process.platform === "win32") check("ending another connection ends its Claude too, not only the connection", !alive(parent.pid) && !alive(grandchild), [alive(parent.pid), alive(grandchild)]);
  else { try { process.kill(grandchild); } catch {} check("ending another connection ends it", !alive(parent.pid), parent.pid); }

  // ---- The start-up script, with a profile folder that is not in English.
  const profile = join(scratch, "Users", "طارق", "AppData");
  const file = writeStarter(join(profile, "node.exe"), join(profile, "longtable.mjs"));
  const raw = readFileSync(file);
  check("the start-up script is written as Unicode with its mark, so Windows reads the folder name right", raw[0] === 0xff && raw[1] === 0xfe && raw.toString("utf16le").includes("طارق"), raw.slice(0, 4));
  check("and still starts Node on the connection with no window", /\.Run """.*node\.exe"" "".*longtable\.mjs"" run", 0, False/.test(raw.toString("utf16le").replace(/^﻿/, "")), raw.toString("utf16le"));

  // ---- "Started" only when the connection really wrote its note.
  const now = Date.now();
  check("with no connection running, start-up is not said to have started", wroteNoteSince(now, 1200) === false);
  // The note is written by another program, as the started connection would: this check waits without yielding.
  const note = join(process.env.LONGTABLE_HOME, "runner.pid");
  const asked = Date.now();
  spawn(process.execPath, ["-e", `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(note)}, "1 " + Date.now()), 600)`], { stdio: "ignore" });
  check("when the connection writes its note, start-up is said to have started", wroteNoteSince(asked, 5000) === true);

  // ---- The log keeps to a size.
  const logFile = join(process.env.LONGTABLE_HOME, "runner.log");
  writeFileSync(logFile, "x".repeat(5 * 1024 * 1024 + 10));
  for (let i = 0; i < 401; i++) log(`claim failed: offline ${i}`);
  const kept = statSync(logFile).size;
  const old = statSync(`${logFile}.1`).size;
  check("past 5 MB the log starts again and keeps the one before", kept < 100000 && old > 5 * 1024 * 1024, { kept, old });
} catch (e) {
  check("the run did not crash", false, e.stack || String(e));
} finally {
  try { rmSync(scratch, { recursive: true, force: true }); } catch {}
}

const failed = Object.values(results).filter((v) => v !== "pass").length;
console.log(JSON.stringify(results, null, 2));
console.log(`${Object.keys(results).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
