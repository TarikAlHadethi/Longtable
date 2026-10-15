// The connection's own Claude sign-in, with no terminal on screen.
//
// Claude Desktop keeps its sign-in to itself, so the connection needs one of its own. `claude setup-token` is
// Anthropic's documented way for scripts. It expects a terminal, so this runs it in a hidden one and shows the
// person a small page in their browser instead. The token is read off a proper screen copy (a terminal emulator,
// so spacing survives), checked with a one-word request, saved encrypted, and never printed or sent anywhere.

import http from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import pty from "@lydell/node-pty";
import headless from "@xterm/headless";
import { childEnv, tokenWorks } from "./claude.mjs";
import { log, saveSecret } from "./store.mjs";

const { Terminal } = headless;

export function openInBrowser(url) {
  if (process.platform === "win32") {
    spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Start-Process $env:LT_URL"], {
      env: { ...process.env, LT_URL: url }, windowsHide: true, stdio: "ignore",
    });
  } else {
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  }
}

function pickWorkingToken(claude, raw) {
  const candidates = [raw];
  const lastDash = raw.lastIndexOf("-");
  for (let i = raw.length - 2; i > lastDash; i--) if (raw[i] === "A" && raw[i + 1] === "A") candidates.push(raw.slice(0, i + 2));
  return candidates.find((c) => tokenWorks(claude, c)) || null;
}

const PAGE = (title) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
:root{color-scheme:light dark;--bg:#f8f6f3;--fg:#2b2724;--muted:#6b6862;--card:#fff;--line:#e4e1db;--accent:#24312c}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe8;--muted:#9b978f;--card:#1f1e1c;--line:#2e2c29;--accent:#7fb8a4}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:480px;margin:0 auto;padding:56px 16px}h1{font-size:22px;margin:0 0 8px}p{color:var(--muted);margin:0 0 20px}
input{width:100%;box-sizing:border-box;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--fg);font:inherit}
button,a.btn{display:inline-block;margin-top:12px;padding:12px 18px;border:0;border-radius:10px;background:var(--accent);color:#fff;font:inherit;text-decoration:none;cursor:pointer}
.hide{display:none}.ok{color:#438a73;font-weight:600}
</style></head><body><main>
<h1>${title}</h1><p id="msg">Starting Claude's sign-in…</p>
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
  }catch(e){document.getElementById("msg").textContent="This page has done its job. You can close it.";return}
  setTimeout(tick,1000);
}
document.getElementById("form").addEventListener("submit",async(e)=>{e.preventDefault();
  const code=document.getElementById("code").value.trim(); if(!code)return;
  document.getElementById("code").value="";
  await fetch(base+"/code",{method:"POST",headers:{"content-type":"text/plain"},body:code});
});
tick();
</script></body></html>`;

// Resolves true once a working sign-in is saved, false if it failed or timed out.
export function signIn(claude, { title = "Connect your Claude" } = {}) {
  return new Promise((resolve) => {
    let state = { state: "starting", message: "Starting Claude's sign-in…" };
    let finished = false;
    let pressedEnter = false;
    const screen = new Terminal({ cols: 400, rows: 200, allowProposedApi: true, scrollback: 2000 });
    const screenText = () => {
      const b = screen.buffer.active;
      const lines = [];
      for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? "");
      return lines.join("\n");
    };
    const term = pty.spawn(claude, ["setup-token"], {
      name: "xterm-256color", cols: 400, rows: 200, cwd: process.env.USERPROFILE || process.env.HOME || process.cwd(), env: childEnv(null),
    });

    // The ten-minute limit below. Cleared when the sign-in ends, or `connect` waited out all ten minutes before
    // exiting even after a sign-in that worked first time.
    let deadline = null;
    function finish(ok, message) {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      state = { state: ok ? "connected" : "failed", message };
      try { term.kill(); } catch {}
      setTimeout(() => { server.close(); resolve(ok); }, 3000);
    }

    function look() {
      if (finished) return;
      const text = screenText();
      const token = text.match(/sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}/);
      if (token) {
        state = { state: "working", url: state.url, message: "Approved. Checking the sign-in works…" };
        try { term.kill(); } catch {}
        const good = pickWorkingToken(claude, token[0]);
        if (good) {
          saveSecret("claude-token", good);
          log(`saved a working Claude sign-in of ${good.length} characters`);
          finish(true, "Connected. Your Claude can now answer at the table, quietly, on your own plan.");
        } else {
          finish(false, "Claude approved, but the sign-in didn't work. Close this page and press Connect again.");
        }
        return;
      }
      const url = text.match(/https:\/\/\S*oauth\S*/i);
      if (url && state.state === "starting") state = { state: "approve", url: url[0], message: "Approve in Claude's tab. If it didn't open, use the button." };
      if (!pressedEnter && /press enter/i.test(text)) { pressedEnter = true; term.write("\r"); }
      if (/paste code here|enter (the )?code|authori[sz]ation code/i.test(text) && state.state === "approve") {
        state = { state: "code", url: state.url, message: "1. Open Claude's sign-in and approve. 2. If Claude shows a code, copy it. 3. Paste it below and press Connect." };
      }
    }

    term.onData((data) => screen.write(data, look));
    term.onExit(() => setTimeout(() => finish(false, "Claude's sign-in closed without connecting. Close this page and try again."), 1500));

    const secret = randomBytes(16).toString("hex");
    const server = http.createServer((req, res) => {
      const base = `/${secret}`;
      if (req.url === base || req.url === `${base}/`) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(PAGE(title));
      }
      if (req.url === `${base}/status`) {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(JSON.stringify(state));
      }
      if (req.url === `${base}/code` && req.method === "POST") {
        let body = "";
        req.on("data", (d) => (body += d).length > 4096 && req.destroy());
        req.on("end", () => {
          if (body.trim() && state.state === "code") {
            state = { state: "working", url: state.url, message: "Checking the code with Claude…" };
            term.write(body.trim() + "\r");
          }
          res.writeHead(204);
          res.end();
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => openInBrowser(`http://127.0.0.1:${server.address().port}/${secret}`));
    deadline = setTimeout(() => finish(false, "This took too long, so it stopped. Close this page and try again."), 10 * 60 * 1000);
  });
}
