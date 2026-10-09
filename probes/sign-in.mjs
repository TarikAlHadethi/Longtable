// Probe (b2): give the background connection its own Claude sign-in, with no terminal on screen.
//
// Claude Desktop keeps its sign-in to itself, so a background Claude needs one of its own.
// `claude setup-token` is Anthropic's documented way for scripts. It expects a terminal, so this
// runs it in a hidden one and shows the person a small page in their browser instead. On Windows,
// approving in Claude's tab is enough; if Claude ever shows a code instead, the page has a box for it.
// The token is read off a proper screen copy (a terminal emulator, so spacing survives), checked with
// a one-word request before it is kept, saved encrypted on this computer, and never printed or sent.
//
//   node probes/sign-in.mjs

import http from "node:http";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import pty from "@lydell/node-pty";
import headless from "@xterm/headless";
import { findClaude, saveToken, childEnv } from "./lib.mjs";

const { Terminal } = headless;
const claude = findClaude();
if (!claude) {
  console.error("Claude Code was not found on this computer.");
  process.exit(2);
}

const logDir = join(process.env.LOCALAPPDATA || process.env.HOME || ".", "Longtable");
mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, "sign-in.log");
const hideSecrets = (s) => s.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[token]").replace(/\b[A-Za-z0-9_#-]{24,}\b/g, "[hidden]");
const log = (s) => appendFileSync(logFile, `${new Date().toISOString()} ${hideSecrets(s)}\n`);

let state = { state: "starting", message: "Starting Claude's sign-in…" };
const setState = (next) => {
  if (state.state !== next.state) log(`state ${next.state}`);
  state = next;
};

function openInBrowser(url) {
  spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Start-Process $env:LT_URL"], {
    env: { ...process.env, LT_URL: url },
    windowsHide: true,
    stdio: "ignore",
  });
}

// A token only counts once a one-word request goes through with it.
function works(token) {
  const r = spawnSync(claude, ["-p", "Reply with the word OK", "--output-format", "json", "--model", "haiku",
    "--max-turns", "1", "--restricted", "--permission-mode", "dontAsk", "--tools", ""], {
    env: childEnv(token), windowsHide: true, timeout: 120000,
  });
  try {
    return JSON.parse(r.stdout.toString()).is_error === false;
  } catch {
    return false;
  }
}

// If the screen still glued text onto the token, the real one ends at an "AA" boundary.
function pickWorkingToken(raw) {
  const candidates = [raw];
  const lastDash = raw.lastIndexOf("-");
  for (let i = raw.length - 2; i > lastDash; i--) if (raw[i] === "A" && raw[i + 1] === "A") candidates.push(raw.slice(0, i + 2));
  return candidates.find(works) || null;
}

// 1. Claude's sign-in in a hidden terminal, mirrored onto an invisible screen we can read properly.
const COLS = 400;
const screen = new Terminal({ cols: COLS, rows: 200, allowProposedApi: true, scrollback: 2000 });
const screenText = () => {
  const b = screen.buffer.active;
  const lines = [];
  for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? "");
  return lines.join("\n");
};

const term = pty.spawn(claude, ["setup-token"], {
  name: "xterm-256color",
  cols: COLS,
  rows: 200,
  cwd: process.env.USERPROFILE || process.cwd(),
  env: childEnv(null),
});

let finished = false;
let pressedEnter = false;
function look() {
  if (finished) return;
  const text = screenText();
  const token = text.match(/sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}/);
  if (token) {
    finished = true;
    setState({ state: "working", url: state.url, message: "Approved. Checking the sign-in works…" });
    try { term.kill(); } catch {}
    const good = pickWorkingToken(token[0]);
    if (good) {
      saveToken(good);
      log(`saved a working token of ${good.length} characters`);
      setState({ state: "connected", message: "Connected. Your Claude can now answer at the table in the background." });
    } else {
      log("no working token found");
      setState({ state: "failed", message: "Claude approved, but the sign-in didn't work. Close this page and try again." });
    }
    setTimeout(() => process.exit(good ? 0 : 1), 4000);
    return;
  }
  const url = text.match(/https:\/\/\S*oauth\S*/i);
  if (url && state.state === "starting") {
    setState({ state: "approve", url: url[0], message: "Approve in Claude's tab. If it didn't open, use the button." });
  }
  if (!pressedEnter && /press enter/i.test(text)) {
    pressedEnter = true;
    term.write("\r");
  }
  if (/paste code here|enter (the )?code|authori[sz]ation code/i.test(text) && state.state === "approve") {
    setState({ state: "code", url: state.url, message: "1. Open Claude's sign-in and approve. 2. If Claude shows a code, copy it. 3. Paste it below and press Connect." });
  }
}

term.onData((data) => {
  screen.write(data, look);
});
term.onExit(({ exitCode }) => {
  log(`claude exited ${exitCode}`);
  setTimeout(() => {
    if (!finished) {
      finished = true;
      setState({ state: "failed", message: "Claude's sign-in closed without connecting. Close this page and try again." });
      setTimeout(() => process.exit(1), 4000);
    }
  }, 1500);
});

// 2. A small page on this computer only, behind a random address, so no other site can post to it.
const secret = randomBytes(16).toString("hex");
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect your Claude</title><style>
:root{color-scheme:light dark;--bg:#f7f6f3;--fg:#1d1c1a;--muted:#6b6862;--card:#fff;--line:#e4e1db;--accent:#2f5d50}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe8;--muted:#9b978f;--card:#1f1e1c;--line:#2e2c29;--accent:#7fb8a4}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:480px;margin:0 auto;padding:56px 16px}h1{font-size:22px;margin:0 0 8px}p{color:var(--muted);margin:0 0 20px}
input{width:100%;box-sizing:border-box;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--fg);font:inherit}
button,a.btn{display:inline-block;margin-top:12px;padding:12px 18px;border:0;border-radius:10px;background:var(--accent);color:#fff;font:inherit;text-decoration:none;cursor:pointer}
.hide{display:none}.ok{color:var(--accent);font-weight:600}
</style></head><body><main>
<h1>Connect your Claude</h1><p id="msg">Starting Claude's sign-in…</p>
<a class="btn hide" id="open" target="_blank" rel="noopener">Open Claude's sign-in</a>
<form id="form" class="hide"><input id="code" autocomplete="off" placeholder="Paste the code here"><button>Connect</button></form>
</main><script>
const base=location.pathname.replace(/\\/$/,"");
async function tick(){
  try{const s=await (await fetch(base+"/status")).json();
    document.getElementById("msg").textContent=s.message;
    document.getElementById("msg").className=s.state==="connected"?"ok":"";
    const open=document.getElementById("open");
    if(s.url&&(s.state==="approve"||s.state==="code")){open.href=s.url;open.classList.remove("hide")}else open.classList.add("hide");
    document.getElementById("form").classList.toggle("hide",s.state!=="code");
    if(s.state==="connected"||s.state==="failed")return;
  }catch(e){document.getElementById("msg").textContent="This page lost its connection. You can close it.";return}
  setTimeout(tick,1000);
}
document.getElementById("form").addEventListener("submit",async(e)=>{e.preventDefault();
  const code=document.getElementById("code").value.trim(); if(!code)return;
  document.getElementById("code").value="";
  await fetch(base+"/code",{method:"POST",headers:{"content-type":"text/plain"},body:code});
});
tick();
</script></body></html>`;

const server = http.createServer((req, res) => {
  const base = `/${secret}`;
  if (req.url === base || req.url === base + "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(page);
  }
  if (req.url === base + "/status") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(state));
  }
  if (req.url === base + "/code" && req.method === "POST") {
    let body = "";
    req.on("data", (d) => (body += d).length > 4096 && req.destroy());
    req.on("end", () => {
      const code = body.trim();
      if (code && state.state === "code") {
        setState({ state: "working", url: state.url, message: "Checking the code with Claude…" });
        term.write(code + "\r");
      }
      res.writeHead(204);
      res.end();
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(0, "127.0.0.1", () => {
  const address = `http://127.0.0.1:${server.address().port}/${secret}`;
  console.log("A 'Connect your Claude' page is opening in your browser.");
  log("page ready");
  openInBrowser(address);
});

setTimeout(() => {
  if (!finished) {
    finished = true;
    setState({ state: "failed", message: "This took too long, so it stopped. Close this page and try again." });
    try { term.kill(); } catch {}
    setTimeout(() => process.exit(1), 4000);
  }
}, 10 * 60 * 1000);
