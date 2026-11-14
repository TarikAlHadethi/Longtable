import { homedir } from "node:os";
import { loadPty } from "./pty.mjs";

// A terminal on the person's own computer, reached only from their own page through the bridge (local.mjs): their
// own shell in a real pseudo-terminal (pty.mjs), as in any terminal app. Colours, prompts, arrow keys, Tab completion,
// Ctrl+C and full-screen programs all work, because the page runs a real terminal (xterm.js) and every key goes
// straight to the shell. It starts in the folder they connected from and lives until it exits or they close it; what it
// printed is kept, so a page opened later sees the screen as it was.

const KEEP = 400_000; // characters of output kept for a page that opens later

export function shellFor(platform = process.platform, env = process.env) {
  if (platform === "win32") return { cmd: "powershell.exe", args: ["-NoLogo"] };
  return { cmd: env.SHELL || "/bin/bash", args: ["-l"] };
}

// What the shell runs with: the person's own environment, minus the connection's own settings, as a colour terminal.
export function termEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!/^(LONGTABLE_|LT_)/i.test(k) && k !== "NO_COLOR" && k !== "FORCE_COLOR") out[k] = v;
  return { ...out, TERM: "xterm-256color", COLORTERM: "truecolor" };
}

const size = (n, lo, hi, d) => Math.max(lo, Math.min(hi, Math.round(Number(n)) || d));

export class Terminal {
  constructor(cwd, emit, load = loadPty) {
    this.cwd = cwd || homedir();
    this.emit = emit;
    this.load = load;
    this.text = "";
    this.proc = null;
    this.starting = null;
    this.cols = 100;
    this.rows = 30;
  }

  // The shell, started when first needed (and again after it exited).
  open(cols, rows) {
    if (cols) this.resize(cols, rows);
    if (this.proc) return Promise.resolve();
    this.starting ??= (async () => {
      const pty = await this.load();
      const { cmd, args } = shellFor();
      const proc = pty.spawn(cmd, args, { name: "xterm-256color", cols: this.cols, rows: this.rows, cwd: this.cwd, env: termEnv() });
      this.proc = proc;
      proc.onData((d) => {
        this.text = (this.text + d).slice(-KEEP);
        this.emit({ data: d });
      });
      proc.onExit(({ exitCode }) => {
        if (this.proc !== proc) return;
        this.proc = null;
        const line = `\r\n[the shell ended${exitCode ? ` with ${exitCode}` : ""}; press a key to start a new one]\r\n`;
        this.text = (this.text + line).slice(-KEEP);
        this.emit({ data: line, exited: true });
      });
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  // Keys, exactly as typed (a shell that ended starts again on the next key).
  async write(data) {
    const s = String(data ?? "");
    if (!s) return;
    if (!this.proc) await this.open();
    this.proc.write(s.slice(0, 64 * 1024));
  }

  // A command from the chat's "!": typed in and run, as if it were typed here.
  run(line) { return this.write(`${String(line ?? "").replace(/[\r\n]+/g, " ").slice(0, 8000)}\r`); }

  resize(cols, rows) {
    this.cols = size(cols, 20, 500, this.cols);
    this.rows = size(rows, 5, 200, this.rows);
    try { this.proc?.resize(this.cols, this.rows); } catch {}
  }

  // Closed for good from the page, or when the connection stops: the shell and everything it started.
  stop() {
    const p = this.proc;
    this.proc = null;
    try { p?.kill(); } catch {}
  }
}
