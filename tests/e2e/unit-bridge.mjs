// A person's own computer from their own page: the bridge serves only Longtable's own site, sent to this computer by
// name, with that table's key and only for a table Longtable allowed; the terminal is their real shell in a real
// terminal (keys as typed, a colour terminal, its size, Ctrl+C, a "!" line, the screen kept for a page opened later,
// the shell living on); the browser (when this computer has Chrome, Edge or Brave) shows a page, takes a click and typing,
// goes where it is told only for web addresses, and keeps as many tabs as are opened. No database, no AI.
//
//   node tests/e2e/unit-bridge.mjs

import { request } from "node:http";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge, fromPage, keyOk, bridgeKey } from "../../packages/connect/src/local.mjs";
import { shellFor, termEnv } from "../../packages/connect/src/terminal.mjs";
import { Browser, addressFor, findBrowser } from "../../packages/connect/src/browser.mjs";

const results = {};
const check = (name, ok, detail) => { results[name] = ok ? "pass" : `FAIL ${JSON.stringify(detail ?? "").slice(0, 400)}`; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(100); } return v; };
const win = process.platform === "win32";

// The rules on their own.
check("only Longtable's own site, sent here by name", fromPage({ host: "127.0.0.1:5000", origin: "https://longtable.chat" }, { port: 5000, app: "https://longtable.chat" })
  && fromPage({ host: "localhost:5000", origin: "https://longtable.chat" }, { port: 5000, app: "https://longtable.chat" })
  && !fromPage({ host: "evil.example:5000", origin: "https://longtable.chat" }, { port: 5000, app: "https://longtable.chat" })
  && !fromPage({ host: "127.0.0.1:5000", origin: "https://evil.example" }, { port: 5000, app: "https://longtable.chat" })
  && !fromPage({ host: "127.0.0.1:5000", origin: undefined }, { port: 5000, app: "https://longtable.chat" }));
const k = bridgeKey();
check("a key of the shape Longtable keeps", /^[A-Za-z0-9_-]{32,64}$/.test(k));
check("the key must match exactly", keyOk(`Bearer ${k}`, k) && !keyOk(`Bearer ${k.slice(1)}x`, k) && !keyOk("", k) && !keyOk(`Bearer ${k}`, null));
check("PowerShell 7 on Windows when it is there, else Windows PowerShell", shellFor("win32", { PATH: "C:\\tools" }, (p) => p.endsWith("pwsh.exe") && p.includes("PowerShell")).cmd.endsWith("pwsh.exe")
  && shellFor("win32", { PATH: "C:\\tools" }, () => false).cmd === "powershell.exe");
check("their own login shell elsewhere", true && shellFor("linux", { SHELL: "/bin/zsh" }).cmd === "/bin/zsh" && shellFor("linux", { SHELL: "/bin/zsh" }).args[0] === "-l");
check("the connection's own settings stay out of the terminal, and it is a colour terminal", !("LONGTABLE_HOME" in termEnv({ LONGTABLE_HOME: "x", PATH: "p" })) && !("LT_JOB_KEY" in termEnv({ LT_JOB_KEY: "y" }))
  && termEnv({ PATH: "p" }).PATH === "p" && termEnv({ NO_COLOR: "1" }).NO_COLOR === undefined && termEnv({}).TERM === "xterm-256color");
check("the browser goes only to web addresses", addressFor("example.com") === "https://example.com/" && addressFor("localhost:3000") === "http://localhost:3000/"
  && addressFor("http://127.0.0.1:8080/x") === "http://127.0.0.1:8080/x" && addressFor("file:///etc/passwd") === null && addressFor("javascript:alert(1)") === null
  && addressFor("chrome://settings") === null && addressFor("") === null);

// The bridge itself.
const APP = "https://longtable.chat";
const scratch = mkdtempSync(join(tmpdir(), "longtable-bridge-"));
const folder = join(scratch, "project");
mkdirSync(join(folder, "src"), { recursive: true });
const browser = new Browser(join(scratch, "home"), () => {});
const seats = [
  { table_id: "11111111-1111-1111-1111-111111111111", local: { key: bridgeKey(), allowed: true }, terminalFolder: folder },
  { table_id: "22222222-2222-2222-2222-222222222222", local: { key: bridgeKey(), allowed: false }, terminalFolder: folder },
];
const [mine, notAllowed] = seats;
const bridge = await startBridge({ app: APP, seats, home: scratch, browser, log: () => {} });
const raw = (path, { method = "GET", host = `127.0.0.1:${bridge.port}`, origin = APP, key, body } = {}) => new Promise((done) => {
  const req = request({ host: "127.0.0.1", port: bridge.port, path, method, headers: { Host: host, ...(origin ? { Origin: origin } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json" } }, (res) => {
    let s = "";
    res.setEncoding("utf8");
    res.on("data", (d) => { s += d; });
    res.on("end", () => done({ status: res.statusCode, body: s, headers: res.headers }));
  });
  req.on("error", (e) => done({ status: 0, body: e.message }));
  if (body) req.write(JSON.stringify(body));
  req.end();
});
const t = (seat) => `?t=${seat.table_id}`;
const post = (path, seat, body) => raw(`${path}${t(seat)}`, { method: "POST", key: seat.local.key, body }).then((r) => JSON.parse(r.body || "{}"));

check("another site is turned away", (await raw(`/term${t(mine)}`, { origin: "https://evil.example", key: mine.local.key })).status === 403);
check("a name made to point here is turned away", (await raw(`/term${t(mine)}`, { host: "evil.example", key: mine.local.key })).status === 403);
check("no key, no terminal", (await raw(`/term${t(mine)}`, { method: "POST", body: { line: "echo no" } })).status === 401);
check("another table's key does not open this one", (await raw(`/term${t(mine)}`, { method: "POST", key: notAllowed.local.key, body: { line: "echo no" } })).status === 401);
check("a table Longtable did not allow is closed, even with its key", (await raw(`/term${t(notAllowed)}`, { method: "POST", key: notAllowed.local.key, body: { line: "echo no" } })).status === 401);
const pre = await raw(`/term${t(mine)}`, { method: "OPTIONS" });
check("the page's preflight is answered for Longtable only", pre.status === 204 && pre.headers["access-control-allow-origin"] === APP && pre.headers["access-control-allow-private-network"] === "true");

// Listen to the terminal the way the page does: what it printed so far, then everything it prints.
const listen = (cols = 100, rows = 30, id = "1") => {
  const got = { text: "", events: [] };
  const req = request({ host: "127.0.0.1", port: bridge.port, path: `/term${t(mine)}&id=${id}&cols=${cols}&rows=${rows}`, headers: { Host: `127.0.0.1:${bridge.port}`, Origin: APP, Authorization: `Bearer ${mine.local.key}` } }, (res) => {
    let buf = "";
    res.setEncoding("utf8");
    res.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { const e = JSON.parse(l); got.events.push(e); if (e.data) got.text += e.data; } }
    });
  });
  req.end();
  got.close = () => req.destroy();
  return got;
};
// What a command printed, told apart from the command as typed: its words are joined only when it runs.
const plain = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
const shows = (got, word) => until(() => plain(got.text).split(/\r?\n/).some((l) => l.trim().endsWith(word) && !l.includes("+") && !l.includes("'")), 15000);
const typeIn = (data) => post("/term", mine, { data });
const term = listen();
check("opening the terminal starts with the screen as it was (empty at first)", await until(() => term.events[0]?.all === true && term.events[0].data === ""));
await sleep(1500);
await typeIn(win ? `echo ('hello'+'-pty')\r` : `echo 'hello''-pty'\r`);
check("keys go to their real shell, and what it prints comes back", await shows(term, "hello-pty"), term.text.slice(-300));
await typeIn(win ? `echo ('term-'+$env:TERM)\r` : `echo 'term-'"$TERM"\r`);
check("it is a colour terminal", await shows(term, "term-xterm-256color"), term.text.slice(-300));
await post("/term/size", mine, { cols: 120, rows: 40 });
await sleep(500);
await typeIn(win ? `echo ('cols-'+$Host.UI.RawUI.WindowSize.Width)\r` : `echo 'cols-'"$(tput cols)"\r`);
check("it takes the size of the page's terminal", await shows(term, "cols-120"), term.text.slice(-300));
await typeIn(win ? "Start-Sleep -Seconds 60\r" : "sleep 60\r");
await sleep(1500);
await typeIn("\x03");
await sleep(800);
await typeIn(win ? `echo ('after'+'-stop')\r` : `echo 'after''-stop'\r`);
check("Ctrl+C stops what runs, and the shell carries on", await shows(term, "after-stop"), term.text.slice(-300));
await post("/term", mine, { line: win ? "echo ('from'+'-the-chat')" : "echo 'from''-the-chat'" });
check("a \"!\" line from the chat runs in it", await shows(term, "from-the-chat"), term.text.slice(-300));
const later = listen();
check("a page opened later sees the screen as it was", await until(() => later.events[0]?.all === true && later.events[0].data.includes("from-the-chat")));
later.close();
term.close();

// Several terminals, each its own shell, listed for a page that opens later; closing one ends only that one.
const second = listen(100, 30, "two");
await sleep(1500);
await raw(`/term${t(mine)}&id=two`, { method: "POST", key: mine.local.key, body: { data: win ? "echo ('second'+'-shell')\r" : "echo 'second''-shell'\r" } });
check("a second terminal is a shell of its own", await shows(second, "second-shell") && !plain(second.text).includes("hello-pty"), plain(second.text).slice(-200));
const listed = JSON.parse((await raw(`/terms${t(mine)}`, { key: mine.local.key })).body);
check("the terminals running are listed for a page opened later", listed.map((x) => x.id).sort().join(",") === "1,two", listed);
await raw(`/term/close${t(mine)}&id=two`, { method: "POST", key: mine.local.key, body: {} });
second.close();
await sleep(500);
const after = JSON.parse((await raw(`/terms${t(mine)}`, { key: mine.local.key })).body);
check("closing a terminal's tab ends that shell only", after.map((x) => x.id).join(",") === "1", after);
check("a terminal name that is not one is refused", (await raw(`/term${t(mine)}&id=..%2Fx`, { method: "POST", key: mine.local.key, body: { data: "x" } })).status === 500);

// The browser, where this computer has one.
const exe = findBrowser();
if (!exe) {
  console.log("(no Chrome, Edge or Brave here: the browser checks are left out)");
} else {
  const site = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<title>start</title><body style="margin:0"><button style="position:fixed;left:0;top:0;width:100%;height:50%" onclick="document.title='clicked'">x</button>
      <input id="i" style="position:fixed;left:0;top:50%;width:100%;height:50%" oninput="document.title='typed '+this.value"></body>`);
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const page = `http://127.0.0.1:${site.address().port}/`;
  let events = [];
  const viewer = (e) => events.push(e);
  const title = async () => (await browser.call("Runtime.evaluate", { expression: "document.title" }, browser.page.sessionId)).result?.value;
  try {
    await browser.watch(viewer);
    check("watching shows a picture at once", events.some((e) => typeof e.frame === "string" && e.frame.length > 100));
    await post("/browser", mine, { do: "go", url: page });
    check("it goes where it is told", await until(() => events.some((e) => e.url === page)));
    check("frames come while it changes", await until(() => events.filter((e) => e.frame).length > 1));
    await sleep(500);
    await post("/browser", mine, { do: "click", x: 0.5, y: 0.25 });
    check("a click lands where it was pressed", await until(async () => (await title()) === "clicked"));
    await post("/browser", mine, { do: "click", x: 0.5, y: 0.75 });
    await post("/browser", mine, { do: "type", text: "hi" });
    check("typing reaches the page", await until(async () => (await title()) === "typed hi"));
    const width = async () => (await browser.call("Runtime.evaluate", { expression: "innerWidth" }, browser.page.sessionId)).result?.value;
    await post("/browser", mine, { do: "size", w: 600, h: 400, dpr: 2 });
    check("the page is laid out at the size it is shown at", await until(async () => (await width()) === 600 && browser.size.w === 600));
    await post("/browser", mine, { do: "click", x: 0.5, y: 0.25 });
    await browser.call("Runtime.evaluate", { expression: "document.title='x'" }, browser.page.sessionId);
    await post("/browser", mine, { do: "click", x: 0.5, y: 0.25 });
    check("and a click still lands where it was pressed at that size", await until(async () => (await title()) === "clicked"));
    // Tabs: as many as are opened, each one shown when picked, gone when closed.
    const tabs = () => [...events].reverse().find((e) => e.tabs)?.tabs ?? [];
    await post("/browser", mine, { do: "newtab", url: page });
    check("every picture says which tab it is of", events.filter((e) => e.frame).every((e) => typeof e.tab === "string"));
    check("a new tab opens and is the one shown", await until(() => tabs().length === 2 && [...events].reverse().find((e) => e.tabs)?.active === browser.page?.targetId && browser.page.url === page));
    for (let i = 0; i < 11; i++) await post("/browser", mine, { do: "newtab" });
    check("there is no limit on tabs", await until(() => tabs().length === 13 && browser.tabs.size === 13), tabs().length);
    const first = tabs()[0].id;
    await post("/browser", mine, { do: "tab", id: first });
    check("picking a tab shows it", await until(() => browser.page?.targetId === first));
    for (const tb of tabs().slice(1)) await post("/browser", mine, { do: "closetab", id: tb.id });
    check("closing tabs takes them away", await until(() => tabs().length === 1 && browser.tabs.size === 1), tabs().length);
    const refused = await raw(`/browser${t(mine)}`, { method: "POST", key: mine.local.key, body: { do: "go", url: "file:///etc/passwd" } });
    check("it refuses to open a file of this computer", refused.status === 500 && /not a web address/.test(refused.body));
    const port = await browser.hold();
    check("their AI can attach to the same browser", port > 0 && (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok).catch(() => false)));
    browser.release();
    browser.unwatch(viewer);
    check("with nobody watching, it goes back to its own size for their AI", await until(async () => (await width()) > 600));
  } catch (e) {
    check("the browser ran", false, e.message);
  } finally {
    browser.unwatch(viewer);
    browser.close();
    site.close();
  }
}

bridge.close();
await sleep(500);
try { rmSync(scratch, { recursive: true, force: true }); } catch {}

const failed = Object.entries(results).filter(([, v]) => v !== "pass");
for (const [name, v] of Object.entries(results)) console.log(`${v === "pass" ? "pass" : "FAIL"}  ${name}${v === "pass" ? "" : "  " + v.slice(5)}`);
console.log(`\n${Object.keys(results).length - failed.length} of ${Object.keys(results).length} passed`);
process.exit(failed.length ? 1 : 0);
