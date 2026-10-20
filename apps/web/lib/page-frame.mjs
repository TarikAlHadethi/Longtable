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
else if(d.op==="changed"){subs.forEach(function(f){try{f(d.key,d.value)}catch(_){}});}
else if(d.op==="cursors"){cursors=d.list||[];draw();}
else if(d.op==="marks"){marks(d.list||[]);}
else if(d.op==="focus"){focus(d.id);}
else if(d.op==="mode"){MODE=d.m==="comment"||d.m==="edit"?d.m:"view";document.designMode=MODE==="edit"?"on":"off";if(MODE!=="comment")outline(null);document.documentElement.style.cursor=MODE==="comment"?"crosshair":"";}
else if(d.op==="pins"){pinsList=d.list||[];drawPins();}
else if(d.op==="serialize"){serialize();}
else if(d.op==="print"){window.print();}
else if(d.op==="png"){png();}});
var MODE="view",BOX=null,pinsList=[];
function box(){if(!BOX){BOX=document.createElement("div");BOX.style.cssText="position:absolute;pointer-events:none;border:2px solid #3a9a78;border-radius:8px;background:rgba(58,154,120,.08);transition:left .12s ease,top .12s ease,width .12s ease,height .12s ease;display:none";layer().appendChild(BOX);}return BOX;}
function outline(el){var b=box();if(!el){b.style.display="none";return;}var r=el.getBoundingClientRect();b.style.display="block";b.style.left=(r.left+scrollX-4)+"px";b.style.top=(r.top+scrollY-4)+"px";b.style.width=(r.width+8)+"px";b.style.height=(r.height+8)+"px";}
function label(el){var t=String(el.innerText||el.getAttribute("aria-label")||el.getAttribute("alt")||"").replace(/\\s+/g," ").trim();return (t||el.tagName.toLowerCase()).slice(0,80);}
document.addEventListener("mouseover",function(e){if(MODE!=="comment")return;var t=e.target;if(!t||t.nodeType!==1||inLayer(t))return;outline(t);},true);
document.addEventListener("click",function(e){if(MODE!=="comment")return;var t=e.target;if(!t||t.nodeType!==1||inLayer(t))return;e.preventDefault();e.stopPropagation();var r=t.getBoundingClientRect();
parent.postMessage({lt:K,op:"pickEl",a:{path:pathOf(t),label:label(t),x:r.left,y:r.top,w:r.width,h:r.height}},"*");},true);
function drawPins(){var L=layer(),old=L.querySelectorAll("[data-lt-pin]");for(var i=0;i<old.length;i++)old[i].remove();
for(var j=0;j<pinsList.length;j++){var p=pinsList[j],el=at(p.path||[]);if(!el||inLayer(el))continue;var r=el.getBoundingClientRect(),d=document.createElement("button");
d.setAttribute("data-lt-pin",String(p.id).replace(/[^0-9a-f-]/g,""));d.textContent=String(p.n).slice(0,3);
d.style.cssText="position:absolute;pointer-events:auto;left:"+(r.right+scrollX-11)+"px;top:"+(r.top+scrollY-11)+"px;width:24px;height:24px;padding:0;border-radius:50% 50% 50% 6px;border:2px solid #fff;background:#3a9a78;color:#fff;font:700 11px/20px system-ui,sans-serif;text-align:center;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.22);animation:lt-pop .32s cubic-bezier(.34,1.56,.64,1) both";
d.onclick=function(ev){ev.preventDefault();ev.stopPropagation();var rr=this.getBoundingClientRect();parent.postMessage({lt:K,op:"pin",a:{id:this.getAttribute("data-lt-pin"),x:rr.left,y:rr.top}},"*");};L.appendChild(d);}}
addEventListener("resize",drawPins);
function serialize(){unmark();var was=MODE;document.designMode="off";var l=LAYER;if(l&&l.parentNode)l.parentNode.removeChild(l);var hs=document.querySelectorAll("[data-lt]"),gone=[];
for(var i=0;i<hs.length;i++){gone.push([hs[i],hs[i].parentNode,hs[i].nextSibling]);hs[i].parentNode.removeChild(hs[i]);}
var out="<!doctype html>"+document.documentElement.outerHTML;for(var k=gone.length-1;k>=0;k--)gone[k][1].insertBefore(gone[k][0],gone[k][2]);
if(l)document.documentElement.appendChild(l);document.designMode=was==="edit"?"on":"off";parent.postMessage({lt:K,op:"html",a:out},"*");}
function png(){var done=function(v){parent.postMessage({lt:K,op:"png",a:v},"*");};var go=function(){window.html2canvas(document.body,{backgroundColor:null,scale:2,ignoreElements:function(e){return e===LAYER;}}).then(function(c){done(c.toDataURL("image/png"));}).catch(function(){done(null);});};
if(window.html2canvas)return go();var sc=document.createElement("script");sc.setAttribute("data-lt","");sc.src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";sc.onload=go;sc.onerror=function(){done(null);};document.head.appendChild(sc);}
var LAYER=null,cursors=[],last=0,away=null;
function layer(){if(!LAYER){LAYER=document.createElement("div");LAYER.setAttribute("data-lt-layer","");LAYER.style.cssText="position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647";
var st=document.createElement("style");st.textContent="[data-lt-cursor]{position:absolute;left:0;top:0;transition:transform .09s linear;will-change:transform}[data-lt-cursor] span{position:absolute;left:12px;top:14px;padding:2px 7px;border-radius:7px;font:600 11px/1.5 system-ui,sans-serif;color:#fff;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.18)}mark[data-lt-mark]{background:rgba(255,196,0,.32);color:inherit;border-radius:2px;cursor:pointer;transition:background .2s}mark[data-lt-mark].lt-on{background:rgba(255,170,0,.65)}@keyframes lt-in{from{opacity:0}to{opacity:1}}@keyframes lt-pop{from{opacity:0;transform:scale(.4)}to{opacity:1;transform:none}}[data-lt-cursor]{animation:lt-in .2s ease both}";
LAYER.appendChild(st);document.documentElement.appendChild(LAYER);}return LAYER;}
function inLayer(el){while(el){if(el===LAYER)return true;el=el.parentElement;}return false;}
function pathOf(el){var p=[];while(el&&el.nodeType===1&&el!==document.documentElement){var i=0,s=el;while((s=s.previousElementSibling))i++;p.unshift(i);el=el.parentElement;}return p;}
function at(p){var el=document.documentElement;for(var i=0;i<p.length&&el;i++)el=el.children[p[i]];return el||null;}
function draw(){var L=layer(),seen={};for(var i=0;i<cursors.length;i++){var c=cursors[i],el=at(c.path||[]);if(!el||inLayer(el))continue;var r=el.getBoundingClientRect();
var x=r.left+scrollX+Math.min(1,Math.max(0,c.fx||0))*r.width,y=r.top+scrollY+Math.min(1,Math.max(0,c.fy||0))*r.height;seen[c.id]=1;
var d=L.querySelector('[data-lt-cursor="'+String(c.id).replace(/[^0-9a-f-]/g,"")+'"]');
if(!d){d=document.createElement("div");d.setAttribute("data-lt-cursor",String(c.id).replace(/[^0-9a-f-]/g,""));
d.innerHTML='<svg width="18" height="20" viewBox="0 0 18 20"><path d="M1 1l15 8-7 1.6L5.6 18z" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg><span></span>';L.appendChild(d);}
d.querySelector("path").setAttribute("fill",/^[#a-z0-9(),.% -]{1,40}$/i.test(c.color||"")?c.color:"#555");var t=d.querySelector("span");t.textContent=String(c.name||"Someone").slice(0,40);t.style.background=d.querySelector("path").getAttribute("fill");
d.style.transform="translate("+x+"px,"+y+"px)";}
var all=L.querySelectorAll("[data-lt-cursor]");for(var j=0;j<all.length;j++)if(!seen[all[j].getAttribute("data-lt-cursor")])all[j].remove();}
addEventListener("resize",draw);
document.addEventListener("pointermove",function(e){var t=e.target;if(!t||t.nodeType!==1||inLayer(t))return;var now=Date.now();if(now-last<50)return;last=now;
if(t.tagName==="MARK"&&t.hasAttribute("data-lt-mark"))t=t.parentElement;var r=t.getBoundingClientRect();
parent.postMessage({lt:K,op:"pointer",a:{path:pathOf(t),fx:r.width?(e.clientX-r.left)/r.width:0,fy:r.height?(e.clientY-r.top)/r.height:0}},"*");});
document.documentElement.addEventListener("pointerleave",function(){parent.postMessage({lt:K,op:"pointer",a:null},"*");});
function unmark(){var ms=document.querySelectorAll("mark[data-lt-mark]");for(var i=0;i<ms.length;i++){var m=ms[i],p=m.parentNode;while(m.firstChild)p.insertBefore(m.firstChild,m);p.removeChild(m);p.normalize();}}
function marks(list){unmark();for(var i=0;i<list.length;i++){var w=String(list[i].text||"").trim();if(w.length<2)continue;
var it=document.createTreeWalker(document.body||document.documentElement,NodeFilter.SHOW_TEXT,{acceptNode:function(n){var p=n.parentElement;if(!p||inLayer(p)||/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/.test(p.tagName)||p.closest("mark[data-lt-mark]"))return NodeFilter.FILTER_REJECT;return NodeFilter.FILTER_ACCEPT;}}),node;
while((node=it.nextNode())){var k=node.nodeValue.indexOf(w);if(k<0)continue;var r=document.createRange();r.setStart(node,k);r.setEnd(node,k+w.length);var m=document.createElement("mark");m.setAttribute("data-lt-mark",String(list[i].id).replace(/[^0-9a-f-]/g,""));r.surroundContents(m);break;}}draw();}
function focus(id){var ms=document.querySelectorAll("mark[data-lt-mark]");for(var i=0;i<ms.length;i++)ms[i].classList.toggle("lt-on",ms[i].getAttribute("data-lt-mark")===id);var m=document.querySelector('mark[data-lt-mark="'+String(id||"").replace(/[^0-9a-f-]/g,"")+'"]');if(m&&m.scrollIntoView)m.scrollIntoView({block:"nearest",behavior:"smooth"});}
document.addEventListener("click",function(e){var m=e.target&&e.target.closest&&e.target.closest("mark[data-lt-mark]");if(m)parent.postMessage({lt:K,op:"mark",a:m.getAttribute("data-lt-mark")},"*");});
document.addEventListener("mouseup",function(){if(MODE==="edit")return;var s=String(getSelection()||"").trim();if(s)parent.postMessage({lt:K,op:"picked",a:s.slice(0,300)},"*");});
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
  // Each part Longtable adds carries data-lt, so a page edited by hand is saved without them.
  const head = `<meta data-lt charset="utf-8"><meta data-lt http-equiv="Content-Security-Policy" content="${escapeAttr(FRAME_POLICY)}">`
    + `<meta data-lt name="viewport" content="width=device-width, initial-scale=1"><script data-lt>${bridge(key, me)}</script>`;
  return `<!doctype html><html><head>${head}</head>` + String(html);
}
