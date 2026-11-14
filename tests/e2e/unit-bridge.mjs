// A person's own computer from their own page: the bridge serves only Longtable's own site, sent to this computer by
// name, with that table's key and only for a table Longtable allowed; the terminal runs a line, keeps a plain `cd`,
// passes input to what is running, refuses a "!" while something runs, and Stop ends it with what it started; the
// browser (when this computer has Chrome, Edge or Brave) shows a page, takes a click and typing, and goes where it is
// told only for web addresses. No database, no AI.
//
//   node tests/e2e/unit-bridge.mjs

import { request } from "node:http";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge, fromPage, keyOk, bridgeKey } from "../../packages/connect/src/local.mjs";
import { cdTarget, shellFor, termEnv } from "../../packages/connect/src/terminal.mjs";
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
check("a plain cd is kept, anything longer runs in the shell", cdTarget("cd src", "/a")?.to?.replace(/\\/g, "/").endsWith("/a/src")
  && cdTarget("cd", "/a")?.show === true && cdTarget('cd "my folder"', "/a")?.to?.replace(/\\/g, "/").endsWith("/a/my folder")
  && cdTarget("cd ~/x", "/a", "/home/me")?.to?.replace(/\\/g, "/").endsWith("/home/me/x") && cdTarget("cd src && ls", "/a") === null
  && cdTarget("npm test", "/a") === null);
check("PowerShell on Windows, their own shell elsewhere", shellFor("ls", "win32").cmd === "powershell.exe" && shellFor("ls", "linux", { SHELL: "/bin/zsh" }).cmd === "/bin/zsh");
check("the connection's own settings stay out of the terminal", !("LONGTABLE_HOME" in termEnv({ LONGTABLE_HOME: "x", LT_JOB_KEY: "y", PATH: "p" })) && !("LT_JOB_KEY" in termEnv({ LT_JOB_KEY: "y" })) && termEnv({ PATH: "p" }).PATH === "p");
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

// Listen to the terminal the way the page does.
let heard = "";
const listening = new Promise((ready) => {
  const req = request({ host: "127.0.0.1", port: bridge.port, path: `/term${t(mine)}`, headers: { Host: `127.0.0.1:${bridge.port}`, Origin: APP, Authorization: `Bearer ${mine.local.key}` } }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (d) => { heard += d; });
    ready(req);
  });
  req.end();
});
const stream = await listening;
const said = () => heard.split("\n").filter(Boolean).map((l) => JSON.parse(l));
await until(() => said().some((e) => e.state));
check("opening the terminal hears where it is", said().find((e) => e.state)?.state.cwd === folder);

await post("/term", mine, { line: "echo hello-from-the-table" });
check("a line runs and its output comes back", await until(() => said().some((e) => e.text?.includes("hello-from-the-table") && !e.text.includes("echo"))));
await until(() => said().some((e) => e.running === false));

await post("/term", mine, { line: "cd src" });
check("a plain cd is kept for the next line", await until(() => said().some((e) => e.cwd?.endsWith("src"))));
heard = "";
await post("/term", mine, { line: win ? "(Get-Location).Path" : "pwd" });
check("the next line runs there", await until(() => said().some((e) => e.text?.replace(/\\/g, "/").includes("project/src") && !e.text.includes(">"))));
await until(() => said().some((e) => e.running === false));
await post("/term", mine, { line: "cd nowhere-at-all" });
check("a cd to nowhere says so and stays", await until(() => said().some((e) => e.text?.includes("No such folder"))));

// Something that waits for input takes the next line as its input; a "!" meanwhile is refused.
heard = "";
await post("/term", mine, { line: win ? "$n = [Console]::In.ReadLine(); \"got $n\"" : "read n; echo \"got $n\"" });
await until(() => said().some((e) => e.running === true));
check("a \"!\" from the chat waits while something runs", (await post("/term", mine, { line: "echo second", fresh: true })).busy === true);
await post("/term", mine, { line: "banana" });
check("what is typed next is its input", await until(() => said().some((e) => e.text?.includes("got banana"))));
await until(() => said().some((e) => e.running === false));

// Stop ends a long command.
heard = "";
await post("/term", mine, { line: win ? "Start-Sleep -Seconds 60" : "sleep 60" });
await until(() => said().some((e) => e.running === true));
const stoppedAt = Date.now();
await post("/term/stop", mine, {});
check("Stop ends what is running", await until(() => said().some((e) => e.running === false), 8000) && Date.now() - stoppedAt < 8000);
stream.destroy();

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
