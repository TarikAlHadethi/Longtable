import { spawn, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// A terminal on the person's own computer, reached only from their own page through the bridge (local.mjs). Each line
// runs as its own command in the folder the terminal is in, as Claude Code's own shell tool does: a plain `cd` is kept
// between lines, a running command takes what is typed next as its input, and Stop ends it with everything it started.
// There is no pseudo-terminal (that needs a native package, and the self-updating connection carries only plain
// files), so a program that draws the whole screen does not draw here.

const KEEP = 200_000; // characters of output kept, for a page opened later
const LINE_MAX = 8000;

export function shellFor(line, platform = process.platform, env = process.env) {
  if (platform === "win32") {
    return { cmd: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${line}`] };
  }
  return { cmd: env.SHELL || "/bin/bash", args: ["-lc", line] };
}

// What the commands run with: the person's own environment, minus the connection's own settings, and asked for plain
// text (the page shows no colours).
export function termEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!/^(LONGTABLE_|LT_)/i.test(k)) out[k] = v;
  return { ...out, NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb" };
}

// Where a plain `cd` goes, or null when it is not a plain `cd` (a `cd` inside a longer line runs in the shell, and
// the folder after it is not kept).
export function cdTarget(line, cwd, home = homedir()) {
  const m = line.trim().match(/^(?:cd|chdir)(?:\s+(?:\/d\s+)?(.+))?$/i);
  if (!m || /[;&|<>]/.test(m[1] || "")) return null;
  let to = (m[1] || "").trim().replace(/^(["'])(.*)\1$/, "$2");
  if (!to) return { show: true };
  if (to === "~" || to.startsWith("~/") || to.startsWith("~\\")) to = home + to.slice(1);
  return { to: resolve(cwd, to) };
}

export class Terminal {
  constructor(cwd, emit) {
    this.cwd = cwd || homedir();
    this.text = "";
    this.child = null;
    this.emit = emit;
  }

  state() { return { cwd: this.cwd, running: !!this.child, text: this.text }; }

  out(text) {
    this.text = (this.text + text).slice(-KEEP);
    this.emit({ text });
  }

  // `fresh`: a command from the chat's "!", which never goes into a program already running.
  run(raw, { fresh = false } = {}) {
    const line = String(raw ?? "").replace(/\r/g, "").slice(0, LINE_MAX);
    if (this.child) {
      if (fresh) return { busy: true };
      this.out(`${line}\n`);
      this.child.stdin.write(`${line}\n`, () => {});
      return { ok: true };
    }
    this.out(`${this.cwd}> ${line}\n`);
    if (!line.trim()) return { ok: true };
    if (/^\s*(clear|cls)\s*$/i.test(line)) { this.text = ""; this.emit({ clear: true }); return { ok: true }; }
    const cd = cdTarget(line, this.cwd);
    if (cd) {
      if (cd.show) this.out(`${this.cwd}\n`);
      else {
        let dir = false;
        try { dir = statSync(cd.to).isDirectory(); } catch {}
        if (dir) { this.cwd = cd.to; this.emit({ cwd: this.cwd }); } else this.out(`No such folder: ${cd.to}\n`);
      }
      return { ok: true };
    }
    const { cmd, args } = shellFor(line);
    let child;
    try {
      child = spawn(cmd, args, { cwd: this.cwd, env: termEnv(), windowsHide: true, detached: process.platform !== "win32" });
    } catch (e) {
      this.out(`Could not start it: ${e.message}\n`);
      return { ok: false };
    }
    this.child = child;
    this.emit({ running: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => this.out(d));
    child.stderr.on("data", (d) => this.out(d));
    child.stdin.on("error", () => {});
    let done = false;
    const finish = (code, why) => {
      if (done) return;
      done = true;
      if (this.child === child) this.child = null;
      if (why) this.out(`${why}\n`);
      else if (code) this.out(`(exit ${code})\n`);
      this.emit({ running: false });
    };
    child.on("error", (e) => finish(1, `Could not start it: ${e.message}`));
    child.on("close", (code) => finish(code));
    return { ok: true };
  }

  // Stop, as Ctrl+C would: the command and everything it started.
  stop() {
    const child = this.child;
    if (!child?.pid) return;
    try {
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else process.kill(-child.pid, "SIGTERM");
    } catch { try { child.kill(); } catch {} }
    this.out("^C\n");
  }
}
