// How a page an AI made is shown: inside a frame with no origin of its own (sandboxed, without allow-same-origin), so
// it can never reach this site's sign-in, storage or pages, and with a content policy that lets it load scripts and
// fonts only from a few public CDNs and reach no network at all. What it may do with the table goes through
// `window.longtable`, a few messages to this page that the room checks and carries out as the person viewing.

export const FRAME_SANDBOX = "allow-scripts allow-forms allow-modals allow-downloads";

const CDNS = "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com";
export const FRAME_POLICY = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${CDNS}`,
  `style-src 'unsafe-inline' https://fonts.googleapis.com ${CDNS}`,
  `font-src data: https://fonts.gstatic.com ${CDNS}`,
  "img-src data: blob:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "worker-src blob:",
].join("; ");

// A value written into the bridge's script, so no name can close the script it sits in.
const js = (v) => JSON.stringify(v).split("<").join(String.fromCharCode(92) + "u003c");

// The bridge inside the frame. `key` ties its messages to this one frame.
function bridge(key, me) {
  return `(function(){
var K=${js(key)},n=0,wait={},subs=[];
function call(op,a){return new Promise(function(ok,no){var id=++n;wait[id]=[ok,no];parent.postMessage({lt:K,id:id,op:op,a:a},"*");});}
addEventListener("message",function(e){var d=e.data;if(e.source!==parent||!d||d.lt!==K)return;
if(d.id&&wait[d.id]){var w=wait[d.id];delete wait[d.id];d.error?w[1](new Error(d.error)):w[0](d.value);}
else if(d.op==="changed"){subs.forEach(function(f){try{f(d.key,d.value)}catch(_){}});}});
document.addEventListener("mouseup",function(){var s=String(getSelection()||"").trim();if(s)parent.postMessage({lt:K,op:"picked",a:s.slice(0,300)},"*");});
window.longtable=Object.freeze({me:${js(me)},
get:function(k){return call("get",{key:String(k)});},
set:function(k,v){return call("set",{key:String(k),value:v===undefined?null:v});},
all:function(){return call("all",{});},
on:function(f){if(typeof f==="function")subs.push(f);}});
})();`;
}

const escapeAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// The whole document handed to the frame: the policy and the bridge first, then the page as the AI wrote it. A page
// may tighten the policy with its own, never loosen it (every policy on a document applies).
export function frameDoc(html, { key, me }) {
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttr(FRAME_POLICY)}">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1"><script>${bridge(key, me)}</script>`;
  return `<!doctype html><html><head>${head}</head>` + String(html);
}
