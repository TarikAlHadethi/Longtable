import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { release } from "node:os";
import { Terminal } from "./terminal.mjs";

// The bridge: a small server on this computer only (127.0.0.1), which the person's own Longtable page reaches
// directly, for their terminal. Nothing sent through it passes through Longtable, so a password typed into the terminal
// stays on this computer.
// Who may use it: a page on Longtable's own address (the browser says which site a request comes from, and no site can
// pretend), sent to this computer by name (so a web address made to point here cannot reach it), carrying the key of a
// table whose Longtable says this connection may serve it (runner_local: only their own full Claude Code, which can
// already run commands here with their approval). Each table has its own key, handed only to its own person.

// Which system the shell runs on, so the page's terminal draws as that system's terminal does (ConPTY on Windows).
const SYSTEM = { platform: process.platform, build: Number(release().split(".")[2]) || 0 };

export function bridgeKey() { return randomBytes(24).toString("base64url"); }

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// A request from Longtable's own page, sent to this computer by name.
export function fromPage({ host, origin }, { port, app }) {
  return (host === `127.0.0.1:${port}` || host === `localhost:${port}`) && !!origin && origin === app;
}
// And carrying the table's key.
export const keyOk = (auth, key) => !!key && same(String(auth || "").replace(/^Bearer /, ""), key);

export function startBridge({ app, seats, home, log }) {
  const origin = new URL(app).origin;
  // Each table's terminals, as many as the person opens (tabs on their page), by a name the page gives each.
  const terms = new Map(); // "<table>:<terminal>" -> { term, listeners, id }
  const termId = (url) => { const id = url.searchParams.get("id") || "1"; if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new Error("not a terminal"); return id; };
  const termFor = (seat, id) => {
    const key = `${seat.table_id}:${id}`;
    let t = terms.get(key);
    if (!t) {
      if ([...terms.keys()].filter((k) => k.startsWith(`${seat.table_id}:`)).length >= 30) throw new Error("thirty terminals are open already");
      const listeners = new Set();
      t = { id, listeners, term: new Terminal(seat.terminalFolder || home, (e) => { for (const l of listeners) l(e); }) };
      terms.set(key, t);
    }
    return t;
  };
  const cors = { "Access-Control-Allow-Origin": origin, Vary: "Origin", "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Private-Network": "true", "Access-Control-Max-Age": "600" };
  const send = (res, status, body) => { res.writeHead(status, { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
  const body = (req) => new Promise((ok, fail) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (d) => { s += d; if (s.length > 64 * 1024) { fail(new Error("too much")); req.destroy(); } });
    req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch { fail(new Error("not JSON")); } });
    req.on("error", fail);
  });
  // A stream of lines of JSON, kept open with a blank line now and then.
  const stream = (req, res, first, add, remove) => {
    res.writeHead(200, { ...cors, "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
    const write = (e) => { res.write(`${JSON.stringify(e)}\n`); };
    const beat = setInterval(() => res.write("\n"), 15000);
    if (first) write(first);
    const done = () => { clearInterval(beat); remove(write); };
    req.on("close", done);
    return Promise.resolve(add(write)).catch((e) => { write({ error: e.message }); res.end(); });
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const port = server.address().port;
      const seat = seats.find((s) => s.table_id === url.searchParams.get("t") && !s.gone && s.local?.allowed);
      if (!fromPage(req.headers, { port, app: origin })) { res.writeHead(403); return res.end(); }
      if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
      if (!seat || !keyOk(req.headers.authorization, seat.local.key)) {
        return send(res, 401, { error: "not yours" });
      }
      const path = url.pathname;
      // The terminal: what it printed so far, then everything it prints. Opening it starts the shell at the page's size.
      // Which terminals this table has running, so a page opened later shows them all as tabs.
      if (req.method === "GET" && path === "/terms") {
        return send(res, 200, [...terms.entries()].filter(([k, t]) => k.startsWith(`${seat.table_id}:`) && t.term.proc).map(([, t]) => ({ id: t.id })));
      }
      if (req.method === "GET" && path === "/term") {
        const t = termFor(seat, termId(url));
        return stream(req, res, { data: t.term.text, all: true, os: SYSTEM }, async (w) => { t.listeners.add(w); await t.term.open(url.searchParams.get("cols"), url.searchParams.get("rows")); },
          (w) => t.listeners.delete(w));
      }
      if (req.method !== "POST") return send(res, 404, { error: "nothing here" });
      const b = await body(req);
      // Keys as typed, or a whole command from the chat's "!".
      if (path === "/term") { const t = termFor(seat, termId(url)).term; await (typeof b.line === "string" ? t.run(b.line) : t.write(b.data)); return send(res, 200, { ok: true }); }
      if (path === "/term/size") { termFor(seat, termId(url)).term.resize(b.cols, b.rows); return send(res, 200, { ok: true }); }
      // A terminal's tab closed: that shell ends, as closing a tab in a terminal app does.
      if (path === "/term/close") { const key = `${seat.table_id}:${termId(url)}`; terms.get(key)?.term.stop(); terms.delete(key); return send(res, 200, { ok: true }); }
      return send(res, 404, { error: "nothing here" });
    } catch (e) {
      log(`bridge: ${e.message}`);
      if (!res.headersSent) send(res, 500, { error: e.message });
      else res.end();
    }
  });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => ok({ port: server.address().port, close: () => { for (const t of terms.values()) t.term.stop(); server.close(); } }));
  });
}
