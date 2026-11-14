import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// The person's browser at the table, like the one in Claude's own app: one Chrome (or Edge, Brave, Chromium) the
// connection runs with no window, its profile kept in ~/.longtable/browser so sign-ins stay. Their own page watches it
// live and passes their clicks and keys in (local.mjs); their AI drives the same one when "Let it open pages" is on, so
// they can watch it and take over. Frames go only to their own page on this computer, never to Longtable.
// It is spoken to through Chrome's DevTools pipe (no WebSocket needed on Node 20), and also listens on a DevTools port
// on 127.0.0.1 only, which is how their AI's browser tools attach to it.

export function findBrowser(platform = process.platform, env = process.env, exists = existsSync) {
  const win = (base, ...rest) => (base ? join(base, ...rest) : null);
  const list = platform === "win32" ? [
    win(env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    win(env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
    win(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    win(env.PROGRAMFILES, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    win(env.LOCALAPPDATA, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    win(env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    win(env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
  ] : platform === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ] : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser", "microsoft-edge"].map((n) => {
    const r = spawnSync("sh", ["-c", `command -v ${n}`], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  });
  return list.find((p) => p && exists(p)) || null;
}

// Only addresses a browser should be sent to from a typed bar: the web, and pages on this computer.
export function addressFor(typed) {
  const t = String(typed ?? "").trim();
  if (!t) return null;
  if (/^about:blank$/i.test(t)) return "about:blank";
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(t);
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `${local ? "http" : "https"}://${t}`); } catch { return null; }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
}

// Keys that are not text: their DevTools name, key code and the text they make.
const KEYS = { Enter: [13, "\r"], Backspace: [8], Tab: [9], Escape: [27], Delete: [46], ArrowLeft: [37], ArrowUp: [38], ArrowRight: [39], ArrowDown: [40], Home: [36], End: [35], PageUp: [33], PageDown: [34] };
const EDITS = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo", y: "redo" };
const IDLE_MS = 30 * 60 * 1000;

export class Browser {
  constructor(home, log) {
    this.profile = join(home, "browser");
    this.log = log;
    this.viewers = new Set();
    this.users = 0;
    this.page = null;      // { targetId, sessionId, url, title }
    this.size = { w: 1280, h: 800 };
    this.fit = null;       // the size of the picture on their screen, while someone watches
    this.starting = null;
    this.proc = null;
  }

  // Started on first use; a browser nobody watched or used for half an hour is closed.
  start() {
    if (this.ready) return Promise.resolve(this.port);
    this.starting ??= this.launch().finally(() => { this.starting = null; });
    return this.starting;
  }

  async launch() {
    const exe = findBrowser();
    if (!exe) throw new Error("No Chrome, Edge or Brave was found on this computer");
    mkdirSync(this.profile, { recursive: true });
    const portFile = join(this.profile, "DevToolsActivePort");
    rmSync(portFile, { force: true });
    const proc = spawn(exe, ["--headless=new", "--remote-debugging-pipe", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${this.profile}`, "--no-first-run", "--no-default-browser-check", `--window-size=${this.size.w},${this.size.h}`, "about:blank"],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true });
    this.proc = proc;
    this.calls = new Map();
    this.next = 1;
    let buf = "";
    proc.stdio[4].setEncoding("utf8");
    proc.stdio[4].on("data", (d) => {
      buf += d;
      let at;
      while ((at = buf.indexOf("\0")) >= 0) {
        const msg = buf.slice(0, at);
        buf = buf.slice(at + 1);
        try { this.got(JSON.parse(msg)); } catch (e) { this.log(`browser: a message could not be read: ${e.message}`); }
      }
    });
    proc.stdio[3].on("error", () => {});
    proc.on("exit", () => {
      if (this.proc !== proc) return;
      clearInterval(this.idle);
      this.proc = null;
      this.ready = false;
      this.port = 0;
      this.page = null;
      for (const { fail } of this.calls.values()) fail(new Error("the browser closed"));
      this.calls.clear();
      this.tell({ closed: true });
    });
    try {
      // Chrome writes the port it took once it listens.
      for (let i = 0; i < 150 && !this.port; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (!this.proc) throw new Error("the browser did not start (is its profile open in another window?)");
        try { this.port = Number(readFileSync(portFile, "utf8").split("\n")[0]) || 0; } catch {}
      }
      if (!this.port) throw new Error("the browser did not say where it listens");
      await this.call("Target.setDiscoverTargets", { discover: true });
      const { targetInfos } = await this.call("Target.getTargets");
      const page = targetInfos.find((t) => t.type === "page");
      await this.show(page ? page.targetId : (await this.call("Target.createTarget", { url: "about:blank" })).targetId);
    } catch (e) {
      this.close();
      throw e;
    }
    this.ready = true;
    this.idle = setInterval(() => {
      if (!this.viewers.size && !this.users && Date.now() - this.used > IDLE_MS) this.close();
    }, 60 * 1000);
    this.idle.unref?.();
    this.used = Date.now();
    this.log("browser: started");
    return this.port;
  }

  close() {
    clearInterval(this.idle);
    this.ready = false;
    const p = this.proc;
    this.proc = null;
    this.port = 0;
    this.page = null;
    if (p) { try { p.kill(); } catch {} }
  }

  call(method, params = {}, sessionId) {
    if (!this.proc) return Promise.reject(new Error("the browser is not running"));
    const id = this.next++;
    return new Promise((ok, fail) => {
      this.calls.set(id, { ok, fail });
      this.proc.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  got(msg) {
    if (msg.id) {
      const c = this.calls.get(msg.id);
      if (!c) return;
      this.calls.delete(msg.id);
      return msg.error ? c.fail(new Error(msg.error.message)) : c.ok(msg.result || {});
    }
    const p = msg.params || {};
    if (msg.method === "Page.screencastFrame") {
      this.call("Page.screencastFrameAck", { sessionId: p.sessionId }, msg.sessionId).catch(() => {});
      if (msg.sessionId !== this.page?.sessionId) return;
      this.size = { w: p.metadata.deviceWidth, h: p.metadata.deviceHeight };
      return this.tell({ frame: p.data });
    }
    // A tab their AI opened is the one shown, as it would be in front of them.
    if (msg.method === "Target.targetCreated" && this.ready && p.targetInfo?.type === "page" && p.targetInfo.targetId !== this.page?.targetId) {
      return this.show(p.targetInfo.targetId).catch((e) => this.log(`browser: could not show a new tab: ${e.message}`));
    }
    if (msg.method === "Target.targetInfoChanged" && p.targetInfo?.targetId === this.page?.targetId) {
      this.page.url = p.targetInfo.url;
      this.page.title = p.targetInfo.title;
      return this.tell({ url: this.page.url, title: this.page.title });
    }
    if (msg.method === "Target.targetDestroyed" && p.targetId === this.page?.targetId) {
      this.page = null;
      return this.call("Target.getTargets").then(({ targetInfos }) => {
        const other = targetInfos.find((t) => t.type === "page");
        return other ? this.show(other.targetId) : this.call("Target.createTarget", { url: "about:blank" });
      }).catch((e) => this.log(`browser: no tab left to show: ${e.message}`));
    }
  }

  async show(targetId) {
    const { sessionId } = await this.call("Target.attachToTarget", { targetId, flatten: true });
    const { targetInfo } = await this.call("Target.getTargetInfo", { targetId });
    this.page = { targetId, sessionId, url: targetInfo?.url || "", title: targetInfo?.title || "" };
    await this.call("Page.enable", {}, sessionId);
    this.tell({ url: this.page.url, title: this.page.title });
    if (this.viewers.size) { await this.fitTo(); await this.cast(); }
  }

  // The page laid out at the size it is shown at, sharp on their screen, as in Claude's own browser. With nobody
  // watching it goes back to the browser's own window size, which is what their AI then sees.
  async fitTo() {
    const s = this.page?.sessionId;
    if (!s) return;
    if (this.fit && this.viewers.size) await this.call("Emulation.setDeviceMetricsOverride", { width: this.fit.w, height: this.fit.h, deviceScaleFactor: this.fit.dpr, mobile: false }, s);
    else await this.call("Emulation.clearDeviceMetricsOverride", {}, s);
  }

  // Frames from the tab shown, once (a second start is refused by the browser).
  async cast() {
    const s = this.page?.sessionId;
    if (!s || this.casting === s) return;
    this.casting = s;
    try { await this.call("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 4000, maxHeight: 4000 }, s); }
    catch (e) { this.casting = null; throw e; }
  }

  tell(event) { for (const v of this.viewers) v(event); }

  // Someone's page watching. It hears where the browser is at once, then every frame.
  async watch(viewer) {
    this.viewers.add(viewer);
    this.used = Date.now();
    await this.start();
    viewer({ url: this.page?.url || "", title: this.page?.title || "" });
    await this.fitTo();
    await this.cast();
    // A still page sends no new frame, so the one on screen is asked for.
    const { data } = await this.call("Page.captureScreenshot", { format: "jpeg", quality: 70 }, this.page.sessionId);
    viewer({ frame: data });
  }

  unwatch(viewer) {
    this.viewers.delete(viewer);
    this.used = Date.now();
    if (!this.viewers.size && this.page) {
      this.casting = null;
      this.fit = null;
      this.call("Page.stopScreencast", {}, this.page.sessionId).catch(() => {});
      this.fitTo().catch(() => {});
    }
  }

  // Their AI's run uses it: it is started for that, and kept open until the run is done.
  async hold() { this.users++; this.used = Date.now(); try { return await this.start(); } catch (e) { this.users--; throw e; } }
  release() { this.users = Math.max(0, this.users - 1); this.used = Date.now(); }

  // What their page asks of it. Points are given as fractions of the picture, so any size of screen lands right.
  async act(a) {
    this.used = Date.now();
    // The size it is shown at, which may come before the browser has finished starting: kept, and used when it has.
    if (a.do === "size") {
      const n = (v) => Math.round(Math.max(200, Math.min(3000, Number(v) || 200)));
      this.fit = { w: n(a.w), h: n(a.h), dpr: Math.max(1, Math.min(3, Number(a.dpr) || 1)) };
      if (!this.page || !this.viewers.size) return null;
      // Frames at the new size: the old ones are stopped and started again.
      this.casting = null;
      await this.call("Page.stopScreencast", {}, this.page.sessionId).catch(() => {});
      await this.fitTo();
      return this.cast();
    }
    if (!this.page) throw new Error("the browser is not open");
    const s = this.page.sessionId;
    const at = (n, size) => Math.max(0, Math.min(size, Number(n) * size));
    switch (a.do) {
      case "go": {
        const url = addressFor(a.url);
        if (!url) throw new Error("that is not a web address");
        return this.call("Page.navigate", { url }, s);
      }
      case "back": case "forward": {
        const { currentIndex, entries } = await this.call("Page.getNavigationHistory", {}, s);
        const e = entries[currentIndex + (a.do === "back" ? -1 : 1)];
        return e ? this.call("Page.navigateToHistoryEntry", { entryId: e.id }, s) : null;
      }
      case "reload": return this.call("Page.reload", {}, s);
      case "click": {
        const x = at(a.x, this.size.w), y = at(a.y, this.size.h);
        await this.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, s);
        await this.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, s);
        return this.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, s);
      }
      case "scroll":
        return this.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: at(a.x, this.size.w), y: at(a.y, this.size.h), deltaX: 0, deltaY: Math.max(-2000, Math.min(2000, Number(a.dy) || 0)) }, s);
      case "type": return this.call("Input.insertText", { text: String(a.text ?? "").slice(0, 8000) }, s);
      case "key": {
        const mods = (a.ctrl ? 2 : 0) | (a.meta ? 4 : 0) | (a.shift ? 8 : 0) | (a.alt ? 1 : 0);
        const k = String(a.key ?? "");
        const edit = (a.ctrl || a.meta) && EDITS[k.toLowerCase()];
        const named = KEYS[k];
        if (!named && !edit) return null;
        const base = { key: k, code: named ? k : `Key${k.toUpperCase()}`, windowsVirtualKeyCode: named ? named[0] : k.toUpperCase().charCodeAt(0), modifiers: mods };
        await this.call("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(named?.[1] && !mods ? { text: named[1] } : {}), ...(edit ? { commands: [edit] } : {}) }, s);
        return this.call("Input.dispatchKeyEvent", { type: "keyUp", ...base }, s);
      }
      default: throw new Error("unknown browser step");
    }
  }
}
